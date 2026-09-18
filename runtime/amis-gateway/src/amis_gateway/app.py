"""ASGI application exposing Tokkey's focused LiteLLM SDK gateway surface."""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import os
from collections.abc import AsyncIterator, Awaitable, Callable
from threading import RLock
from typing import Any
from urllib.parse import urlparse

import litellm
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route

from .cancellation import UpstreamAborted, UpstreamExchange, UpstreamExchangeRegistry
from .codex_oauth import CODEX_CLIENT_IDENTITY_HEADERS, CanonicalCodexEndpoint
from .credentials import (
    MissingUpstreamCredential,
    UpstreamTarget,
    UpstreamTargetPolicy,
)
from .registry import ModelRoute, ModelRouteRegistry, RouteConflictError
from .streaming import NativeResponsesProxyError, NativeResponsesSSEProxy

JSONMapping = dict[str, Any]
AsyncCall = Callable[..., Awaitable[Any]]
LOGGER = logging.getLogger(__name__)
# Tokkey's gateway surface starts a fresh lineage at 1: it drops the router
# difficulty endpoint that the Amis-era version 3 exposed, and no previously
# shipped Tokkey helper exists that a supervisor would need to stay compatible
# with. Bump this whenever the request or response contract changes so the
# supervisor can evict an orphaned helper left behind by an older app build.
GATEWAY_RUNTIME_PROTOCOL_VERSION = 1


class ClientDisconnected(Exception):
    """Internal control flow raised when the inference caller closes its socket."""


class ResponsesStreamTerminationPolicy:
    """Recognize semantic Responses completion without waiting for socket EOF."""

    TERMINAL_EVENT_TYPES = frozenset(
        {
            "response.completed",
            "response.failed",
            "response.incomplete",
            "response.cancelled",
        }
    )

    @classmethod
    def is_terminal(cls, value: Any, *, protocol: str) -> bool:
        """Return whether one normalized SDK event ends the Responses stream."""
        return (
            protocol == "responses"
            and isinstance(value, dict)
            and value.get("type") in cls.TERMINAL_EVENT_TYPES
        )

    @staticmethod
    async def close(stream: Any) -> None:
        """Release an SDK iterator after semantic termination or cancellation."""
        close = getattr(stream, "aclose", None)
        if not callable(close):
            return
        try:
            result = close()
            if inspect.isawaitable(result):
                await result
        except Exception:
            # Closing is best-effort cleanup after the response lifecycle has
            # already ended. Preserve the original stream outcome and retain a
            # detailed server-side diagnostic instead of masking it.
            LOGGER.exception("Failed to close LiteLLM streaming iterator")


class LiteLLMSDKCompatibility:
    """Isolate pinned SDK workarounds that keep Proxy-only modules unloaded."""

    @classmethod
    def configure(cls) -> None:
        """Disable the Responses dispatcher that imports LiteLLM Proxy MCP code."""
        from litellm.responses import main as responses_main

        dispatcher_name = "_responses_try_dispatch_mcp_gateway"
        if not hasattr(responses_main, dispatcher_name):
            raise RuntimeError(
                "LiteLLM Responses compatibility changed; review the Proxy MCP bypass"
            )
        setattr(responses_main, dispatcher_name, cls._skip_proxy_mcp_dispatch)

    @staticmethod
    def _skip_proxy_mcp_dispatch(**_: Any) -> None:
        """Leave every Responses tool for the upstream provider to handle."""
        return None


class LiteLLMModelCapabilityRegistrar:
    """Register Tokkey-controlled native streaming capabilities with LiteLLM."""

    def __init__(self, register_model: Callable[[dict[str, Any]], Any] | None = None) -> None:
        self._register_model = register_model or litellm.register_model
        self._registered_models: set[tuple[str, str]] = set()
        self._lock = RLock()

    def register_native_responses_streaming(self, route: ModelRoute) -> None:
        """Register only routes whose durable model marker explicitly guarantees SSE."""
        if route.model_info.get("supports_native_streaming") is not True:
            return
        configured_model = route.litellm_params.get("model")
        if not isinstance(configured_model, str) or not configured_model.strip():
            raise ValueError("streaming-capable route model must be a non-empty string")
        model, provider, _, _ = litellm.get_llm_provider(model=configured_model)
        if not provider:
            raise ValueError(f"streaming-capable route '{configured_model}' has no LiteLLM provider")

        registration_key = (provider, model)
        with self._lock:
            if registration_key in self._registered_models:
                return
            # LiteLLM otherwise buffers unknown OpenAI-compatible Responses models,
            # even when Tokkey owns the runtime and has recorded its streaming support.
            self._register_model({
                model: {
                    "litellm_provider": provider,
                    "mode": "responses",
                    "supports_native_streaming": True,
                }
            })
            self._registered_models.add(registration_key)


class ResponsesToolHistoryNormalizer:
    """Preserve Codex tool history when LiteLLM translates Responses to Chat."""

    @classmethod
    def normalize(cls, arguments: JSONMapping) -> JSONMapping:
        """Move assistant text ahead of pending calls so tool results stay adjacent."""
        input_items = arguments.get("input")
        if not isinstance(input_items, list):
            return arguments

        normalized: list[Any] = []
        pending_call_ids: set[str] = set()
        pending_start: int | None = None
        deferred_assistant_items: list[Any] = []
        changed = False

        for item in input_items:
            item_type = item.get("type") if isinstance(item, dict) else None
            if item_type == "function_call":
                call_id = cls._call_id(item)
                if call_id:
                    if not pending_call_ids:
                        pending_start = len(normalized)
                    pending_call_ids.add(call_id)
                normalized.append(item)
                continue

            if (
                pending_call_ids
                and item_type == "message"
                and item.get("role") == "assistant"
            ):
                deferred_assistant_items.append(item)
                changed = True
                continue

            if item_type == "function_call_output" and cls._call_id(item) in pending_call_ids:
                pending_start = cls._insert_deferred_assistant_items(
                    normalized,
                    deferred_assistant_items,
                    pending_start,
                )
                normalized.append(item)
                pending_call_ids.remove(cls._call_id(item))
                if not pending_call_ids:
                    pending_start = None
                continue

            pending_start = cls._insert_deferred_assistant_items(
                normalized,
                deferred_assistant_items,
                pending_start,
            )
            normalized.append(item)

        cls._insert_deferred_assistant_items(
            normalized,
            deferred_assistant_items,
            pending_start,
        )
        if not changed:
            return arguments
        normalized_arguments = dict(arguments)
        normalized_arguments["input"] = normalized
        return normalized_arguments

    @staticmethod
    def _call_id(item: Any) -> str:
        """Read a non-empty Responses call identifier from one input item."""
        if not isinstance(item, dict):
            return ""
        value = item.get("call_id") or item.get("id")
        return value if isinstance(value, str) else ""

    @staticmethod
    def _insert_deferred_assistant_items(
        normalized: list[Any],
        deferred: list[Any],
        pending_start: int | None,
    ) -> int | None:
        """Insert deferred text before the pending call group and clear the buffer."""
        if not deferred:
            return pending_start
        insertion_index = pending_start if pending_start is not None else len(normalized)
        normalized[insertion_index:insertion_index] = deferred
        inserted_count = len(deferred)
        deferred.clear()
        return insertion_index + inserted_count if pending_start is not None else None


class ResponsesToolOutputNormalizer:
    """Keep Codex tool results in the text-only shape every provider accepts.

    Codex's `view_image` tool answers with a `function_call_output` whose `output`
    is a list of content parts carrying an `input_image`. That list form is an
    OpenAI extension -- the Responses schema documents `output` as a string -- and
    providers reject it outright: llama.cpp answers HTTP 400 "Output of tool call
    should be 'Input text'", which fails the whole Codex turn instead of just the
    image. Text parts are preserved verbatim and every other part collapses into a
    note naming the file, so the turn continues with the model still able to talk
    about the image it asked for.

    The image is deliberately not re-attached as a user message: an endpoint without
    vision rejects that too (llama.cpp answers HTTP 500 "image input is not
    supported"), so it would only trade one dead turn for another. It is not lost
    either -- `view_image` exists to show a file to the *user*, and the Tokkey app
    renders that file in the transcript from the same call. The note tells the model
    so, which is what stops it from apologizing for a QR code the user can see.

    That last sentence is a claim about the caller, and this process cannot verify
    it: the note is true because the Tokkey app is the only client of this gateway's
    Codex routes and it renders every `view_image` row. A different client that
    forwards Codex traffic here without rendering would make it a lie.
    """

    # Written for the model, not for a human reader: a bare "omitted" would invite
    # the same call again, so the note states what happened, where the file is, and
    # what to do next.
    IMAGE_NOTE = (
        "[The image was displayed to the user in the conversation, and is not in your "
        "context because this model endpoint accepts text-only tool results{location}. "
        "Do not retry view_image; continue and refer to the image in your reply.]"
    )
    EMPTY_NOTE = "[empty tool output]"

    @classmethod
    def normalize(cls, payload: JSONMapping) -> JSONMapping:
        """Flatten every structured tool result in one Responses request payload."""
        input_items = payload.get("input")
        if not isinstance(input_items, list):
            return payload

        paths_by_call_id = cls._image_paths_by_call_id(input_items)
        normalized: list[Any] = []
        changed = False
        for item in input_items:
            flattened = (
                cls._flatten_output(
                    item.get("output"),
                    path=paths_by_call_id.get(cls._call_id(item), ""),
                )
                if isinstance(item, dict) and item.get("type") == "function_call_output"
                else None
            )
            if flattened is None:
                normalized.append(item)
                continue
            normalized.append({**item, "output": flattened})
            changed = True

        if not changed:
            return payload
        normalized_payload = dict(payload)
        normalized_payload["input"] = normalized
        return normalized_payload

    @staticmethod
    def _call_id(item: Any) -> str:
        """Read the identifier that pairs a tool result with its originating call."""
        if not isinstance(item, dict):
            return ""
        call_id = item.get("call_id")
        return call_id if isinstance(call_id, str) else ""

    @classmethod
    def _image_paths_by_call_id(cls, input_items: list[Any]) -> dict[str, str]:
        """Index the file each image call asked for, so its result can name it.

        The path lives in the `function_call` item, not in its output, and naming the
        file is what lets the model point the user at the right thing.
        """
        paths: dict[str, str] = {}
        for item in input_items:
            if not isinstance(item, dict) or item.get("type") != "function_call":
                continue
            call_id = cls._call_id(item)
            if not call_id:
                continue
            try:
                arguments = json.loads(item.get("arguments") or "{}")
            except (json.JSONDecodeError, TypeError):
                # Arguments are the provider's opaque string; an unparsable one only
                # costs this note its file name, so it must not fail the request.
                continue
            path = arguments.get("path") if isinstance(arguments, dict) else None
            if isinstance(path, str) and path:
                paths[call_id] = path
        return paths

    @classmethod
    def _flatten_output(cls, output: Any, *, path: str = "") -> str | None:
        """Return the text form of a structured output, or None to leave it alone."""
        # A plain string already is the portable shape; only the list form breaks.
        if not isinstance(output, list):
            return None
        parts = [cls._part_text(part, path=path) for part in output]
        return "\n".join(part for part in parts if part) or cls.EMPTY_NOTE

    @classmethod
    def _part_text(cls, part: Any, *, path: str = "") -> str:
        """Read one output part as text, replacing what cannot be sent as text."""
        if isinstance(part, str):
            return part
        if not isinstance(part, dict):
            return str(part)
        text = part.get("text")
        if isinstance(text, str) and text:
            return text
        part_type = part.get("type")
        if part_type == "input_image":
            return cls.IMAGE_NOTE.format(location=f" (file: {path})" if path else "")
        return f"[unsupported '{part_type}' tool output omitted]"


class LocalGrammarCompatibility:
    """Drop schema bounds that make a locally served model's grammar uncompilable.

    llama.cpp constrains tool-call output with a GBNF grammar built from each
    tool's JSON Schema, and it renders a bounded `maxLength` / `maxItems` as an
    explicit repetition. That repetition is expanded, not referenced, so the
    generated text grows with the bound -- and nesting multiplies it, because an
    inner rule is expanded again inside every level that contains it. Past a
    point the grammar no longer parses, and the server rejects the whole request
    with HTTP 400 "Failed to initialize samplers: failed to parse grammar",
    before a single token is generated.

    Measured against the real thing rather than reasoned about: Claude Code's
    `Artifact` tool declares `query.cursor` as a string of `maxLength` 4096, two
    objects deep. On its own that one property sinks the turn. The same property
    at the top level is fine, and nested at 1024 is fine, which is what shows
    this to be a size limit rather than an unsupported construct.

    Removing the bounds outright, rather than lowering them, is the deliberate
    choice. A lowered bound is still a constraint on generation, so capping
    `cursor` to something the grammar can hold would leave the model unable to
    emit a pagination cursor longer than the cap -- trading a failed turn for a
    silently truncated one. It would also need a threshold, and the safe
    threshold depends on the size of the whole tool set, which is not knowable
    from one property. Unbounded is both simpler and the only version verified
    against the full 35-tool payload.

    What is lost is a constraint on length alone. The value the model produces is
    still checked by whoever receives the tool call, which is where an over-long
    argument was always going to be caught. Every other keyword survives --
    `pattern` included, which llama.cpp compiles without complaint -- and so does
    every schema bound sent to a hosted provider, which has no such limit and
    honours them properly.
    """

    #: Hosts that mean "served by this machine", and so by a llama.cpp built to
    #: run on it. `0.0.0.0` is here because that is the address the local server
    #: binds (see `buildTokenHubServerArguments`), and a route may name it back.
    LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1", "0.0.0.0"})

    #: The bounds llama.cpp turns into an expanded repetition. The matching
    #: minimums are left alone: they are small wherever they appear, and a
    #: minimum bounds the start of a repetition rather than unrolling it.
    EXPANDED_BOUNDS = ("maxLength", "maxItems")

    @classmethod
    def applies(cls, route: ModelRoute) -> bool:
        """Whether this route is served from this machine."""
        api_base = route.litellm_params.get("api_base")
        if not isinstance(api_base, str) or not api_base:
            return False
        try:
            return urlparse(api_base).hostname in cls.LOOPBACK_HOSTS
        except ValueError:
            # An unparseable endpoint is not evidence of a local one.
            return False

    @classmethod
    def normalize(cls, payload: JSONMapping) -> JSONMapping:
        """Return the payload with uncompilable tool bounds removed.

        The same object is returned when nothing had to change, so a tool set
        that declares no such bound copies nothing.
        """
        tools = payload.get("tools")
        if not isinstance(tools, list) or not tools:
            return payload
        cleaned = [cls._strip(tool) for tool in tools]
        if cleaned == tools:
            return payload
        return {**payload, "tools": cleaned}

    @classmethod
    def _strip(cls, node: Any) -> Any:
        """Remove every expanded bound anywhere beneath one tool.

        Walks the whole tool rather than reaching into a known path, because the
        three wire shapes in play put the schema in three different places --
        Anthropic's `input_schema`, Chat Completions' `function.parameters`, and
        Responses' `parameters` -- and a bound can sit at any depth within any
        of them. Depth is exactly what makes one dangerous, so none can be
        assumed shallow enough to skip.
        """
        if isinstance(node, dict):
            return {
                key: cls._strip(value)
                for key, value in node.items()
                if not (key in cls.EXPANDED_BOUNDS and isinstance(value, int))
            }
        if isinstance(node, list):
            return [cls._strip(item) for item in node]
        return node


class ModelDiscoveryCatalog:
    """Answer `/v1/models` for clients that build their model picker from a gateway.

    This is the read-only public face of the same routes `/model/info` reports.
    The two are deliberately not one endpoint: `/model/info` is Tokkey's own
    management view and returns the endpoint and marker behind each route, which
    an inference caller has no business seeing.

    Claude Code reads only `id` and the optional `display_name`, and imposes no
    shape on the id, so the whole route set is offered here. The remaining fields
    are what an OpenAI-format client needs to parse the entry at all.
    """

    # Claude Code requests `?limit=1000`. The cap is its own value rather than a
    # larger one so a caller cannot ask this process to build an unbounded list.
    DEFAULT_LIMIT = 1000
    MAX_LIMIT = 1000

    @classmethod
    def payload(cls, routes: list[ModelRoute], *, limit: int) -> JSONMapping:
        """Return the discovery document for the routes this gateway serves."""
        return {
            "object": "list",
            "data": [cls._entry(route) for route in routes[:limit]],
        }

    @classmethod
    def read_limit(cls, request: Request) -> int:
        """Read `?limit=`, ignoring an absent or unusable value.

        Discovery is a picker populating itself, not a paging client, so a
        malformed limit falls back to the default instead of failing the request
        and leaving the caller with no models at all.
        """
        try:
            limit = int(request.query_params.get("limit", cls.DEFAULT_LIMIT))
        except (TypeError, ValueError):
            return cls.DEFAULT_LIMIT
        return min(limit, cls.MAX_LIMIT) if limit > 0 else cls.DEFAULT_LIMIT

    @staticmethod
    def _entry(route: ModelRoute) -> JSONMapping:
        """Describe one route as both protocols' model listings expect it."""
        entry: JSONMapping = {
            "id": route.model_name,
            "object": "model",
            # Anthropic's own listing types its entries; OpenAI's uses `object`.
            "type": "model",
            "owned_by": "amis-gateway",
        }
        display_name = route.model_info.get("display_name")
        # Omitted rather than defaulted to the id: the client already falls back
        # to the id, and a duplicated value would only look like a real label.
        if isinstance(display_name, str) and display_name.strip():
            entry["display_name"] = display_name.strip()
        return entry


class UnregisteredClaudeRoute:
    """Serve a Claude model the caller named that no route was seeded for.

    Tokkey seeds a route per Claude model from a list this build ships with, so
    that list is stale the day Anthropic releases a model. Without this, the
    release reaches the user as a local 404 for a model their own client just
    offered them, which reads as Tokkey being broken rather than behind.

    The synthesized route is exactly what the seeding registrar would have
    created -- `anthropic/<alias>`, no key, no endpoint -- and is never stored.
    Discovery keeps listing seeded routes only, so this widens what the gateway
    will *serve* without widening what it *advertises*: a mistyped alias is
    refused by Anthropic, which knows its own model list, instead of becoming a
    permanent phantom entry in the picker.

    Two things are fixed here rather than taken from the request, and both are
    load-bearing. Only Anthropic-shaped aliases qualify, and the endpoint is
    always Anthropic's own. Together they keep this from being an open relay: an
    unregistered alias cannot be used to aim the caller's credential at a host
    of its choosing. Everything else about the credential is unchanged -- with
    no key on the route, `UpstreamTargetPolicy` still requires the caller to
    bring their own, and still refuses the call by name when they bring none.
    """

    # The prefix LiteLLM reads to select Anthropic, and the one Anthropic's
    # model ids have always carried.
    PROVIDER_PREFIX = "anthropic/"
    MODEL_PREFIX = "claude-"

    @classmethod
    def build(cls, alias: str) -> ModelRoute | None:
        """Return a transient route for a Claude alias, or None for anything else."""
        model = cls._provider_qualified(alias)
        if model is None:
            return None
        return ModelRoute.from_management_payload(
            {
                "model_name": alias,
                # No key and no endpoint, both deliberate; see the class comment.
                "litellm_params": {"model": model},
                "model_info": {
                    "created_by": "amis-gateway",
                    "api_format": "anthropic",
                    # Marks the route as one nobody registered, so a log line or
                    # an error naming it is not mistaken for seeded state.
                    "unregistered": True,
                },
            },
            model_id=f"unregistered:{alias}",
        )

    @classmethod
    def _provider_qualified(cls, alias: str) -> str | None:
        """Qualify a Claude alias for LiteLLM, rejecting every other name."""
        if alias.startswith(cls.PROVIDER_PREFIX):
            # Already qualified by the caller; prefixing again would name a
            # model no provider has.
            return alias if alias[len(cls.PROVIDER_PREFIX):].startswith(cls.MODEL_PREFIX) else None
        return f"{cls.PROVIDER_PREFIX}{alias}" if alias.startswith(cls.MODEL_PREFIX) else None


class PickerModelAlias:
    """Undo the name Tokkey publishes cloud routes under in Claude's pickers.

    Neither Claude surface will show a bare route name, so Tokkey publishes each
    cloud route under an `anthropic.`-prefixed alias and the prefix comes back
    off here, before the registry lookup.

    The body behind the prefix is one of two things, because the two surfaces
    accept different names. Claude Code takes any name under that prefix, so it
    gets the route name whole. Claude Desktop additionally refuses any name
    containing a rival vendor's fragment -- `gpt`, `openai`, `deepseek` and
    dozens more -- which a route named for the model it fronts always carries,
    so it gets the route's trailing id segment alone. Both are resolved here:
    the whole name by an exact lookup, the suffix by matching the one route that
    ends in it.

    Distinct from `UnregisteredClaudeRoute.PROVIDER_PREFIX` despite the shared
    word: that one is `anthropic/`, LiteLLM's provider selector, and it goes
    *on* the way out to name an upstream. This one is `anthropic.`, a client-side
    display convention, and it comes *off* the way in.
    """

    PREFIX = "anthropic."

    @classmethod
    def strip(cls, alias: str) -> str | None:
        """Return the body behind a picker alias, or None for anything else."""
        if not alias.startswith(cls.PREFIX):
            return None
        # A bare prefix names no route; treat it as a miss rather than looking
        # the empty string up.
        return alias[len(cls.PREFIX):] or None

    @staticmethod
    def resolve(body: str, routes: list[ModelRoute]) -> ModelRoute | None:
        """Return the route an alias body names, or None when it names no single one.

        An exact name wins outright. Otherwise the body is a route's trailing id
        segment, and only an unambiguous match counts: two routes ending in the
        same segment would make the alias name neither, and serving an arbitrary
        one of them would send the turn to a provider the user did not pick.
        """
        for route in routes:
            if route.model_name == body:
                return route
        suffix = f"-{body}"
        matches = [route for route in routes if route.model_name.endswith(suffix)]
        return matches[0] if len(matches) == 1 else None


class AmisGatewayApplication:
    """Compose route management and SDK-backed inference over a loopback listener."""

    def __init__(
        self,
        *,
        instance_id: str = "embedded-test-instance",
        registry: ModelRouteRegistry | None = None,
        chat_call: AsyncCall | None = None,
        responses_call: AsyncCall | None = None,
        messages_call: AsyncCall | None = None,
        capability_registrar: LiteLLMModelCapabilityRegistrar | None = None,
        responses_sse_proxy: NativeResponsesSSEProxy | None = None,
        credential_policy: UpstreamTargetPolicy | None = None,
    ) -> None:
        if not instance_id:
            raise ValueError("instance_id must not be empty")
        LiteLLMSDKCompatibility.configure()
        self._instance_id = instance_id
        self._credentials = credential_policy or UpstreamTargetPolicy()
        self._registry = registry or ModelRouteRegistry()
        self._chat_call = chat_call or litellm.acompletion
        self._responses_call = responses_call or litellm.aresponses
        self._messages_call = messages_call or litellm.anthropic.messages.acreate
        self._capability_registrar = capability_registrar or LiteLLMModelCapabilityRegistrar()
        self._responses_sse_proxy = responses_sse_proxy or NativeResponsesSSEProxy()
        self._cancellations = UpstreamExchangeRegistry()
        self.app = Starlette(
            routes=[
                Route("/health/liveness", self.health, methods=["GET"]),
                Route("/health/liveliness", self.health, methods=["GET"]),
                Route("/model/new", self.create_model, methods=["POST"]),
                Route("/model/{model_id:str}/update", self.update_model, methods=["PATCH"]),
                Route("/model/delete", self.delete_model, methods=["POST"]),
                Route("/model/info", self.list_models, methods=["GET"]),
                Route("/v1/models", self.discover_models, methods=["GET"]),
                Route("/models", self.discover_models, methods=["GET"]),
                Route("/_amis/models", self.replace_models, methods=["PUT"]),
                Route("/_amis/cancel", self.cancel_inflight, methods=["POST"]),
                Route("/v1/chat/completions", self.chat_completions, methods=["POST"]),
                Route("/chat/completions", self.chat_completions, methods=["POST"]),
                Route("/v1/responses", self.responses, methods=["POST"]),
                Route("/responses", self.responses, methods=["POST"]),
                Route("/v1/messages", self.messages, methods=["POST"]),
                Route("/messages", self.messages, methods=["POST"]),
            ]
        )

    async def health(self, _: Request) -> Response:
        """Report liveness plus the launch identity used to reject stale helpers."""
        return JSONResponse(
            {
                "status": "ok",
                "service": "amis-gateway",
                "instance_id": self._instance_id,
                "runtime_protocol_version": GATEWAY_RUNTIME_PROTOCOL_VERSION,
            }
        )

    async def create_model(self, request: Request) -> Response:
        """Create one transient route through the legacy-compatible API."""
        try:
            route = self._registry.create(await self._read_object(request))
            return JSONResponse({"model_id": route.model_id, "model_info": route.model_info})
        except (ValueError, RouteConflictError) as error:
            return self._management_error(400, str(error))

    async def update_model(self, request: Request) -> Response:
        """Update one route's LiteLLM parameters without changing its identity."""
        model_id = request.path_params["model_id"]
        try:
            payload = await self._read_object(request)
            params = payload.get("litellm_params")
            if not isinstance(params, dict):
                raise ValueError("litellm_params must be an object")
            route = self._registry.update(model_id, params)
            return JSONResponse({"model_id": route.model_id, "model_info": route.model_info})
        except KeyError:
            return self._management_error(404, f"model '{model_id}' was not found")
        except ValueError as error:
            return self._management_error(400, str(error))

    async def delete_model(self, request: Request) -> Response:
        """Delete one transient route idempotently."""
        try:
            model_id = (await self._read_object(request)).get("id")
            if not isinstance(model_id, str) or not model_id:
                raise ValueError("id must be a non-empty string")
            self._registry.delete(model_id)
            return JSONResponse({"deleted": True, "id": model_id})
        except ValueError as error:
            return self._management_error(400, str(error))

    async def list_models(self, request: Request) -> Response:
        """List routes in the response shape already decoded by the Swift client."""
        return JSONResponse({"data": [route.management_payload() for route in self._registry.list()]})

    async def discover_models(self, request: Request) -> Response:
        """List the routes an inference caller may ask for, for its model picker."""
        return JSONResponse(
            ModelDiscoveryCatalog.payload(
                self._registry.list(),
                limit=ModelDiscoveryCatalog.read_limit(request),
            )
        )

    async def replace_models(self, request: Request) -> Response:
        """Atomically restore all routes from the host application's stored profiles."""
        try:
            payload = await self._read_object(request)
            models = payload.get("models")
            if not isinstance(models, list):
                raise ValueError("models must be an array")
            routes = self._registry.replace(models)
            return JSONResponse({"replaced": len(routes)})
        except (ValueError, RouteConflictError) as error:
            return self._management_error(400, str(error))

    async def cancel_inflight(self, request: Request) -> Response:
        """Drop only the provider connection carrying one cancellation id.

        This exists for callers that do not own the socket carrying the request.
        Direct chat configures Codex to call this gateway itself, so stopping a
        turn cannot be done by closing a socket the app holds -- there is none.
        Codex attaches an app-generated id to its provider request, and naming that
        id here releases only the matching runtime without affecting another
        session using the same model route.

        Cancelling nothing is success, not an error: a turn that already finished
        leaves the route with no in-flight exchange, which is the requested state.
        """
        try:
            payload = await self._read_object(request)
            cancellation_id = payload.get("thread_id")
            if not isinstance(cancellation_id, str) or not cancellation_id.strip():
                raise ValueError("thread_id must be a non-empty string")
            cancellation_id = cancellation_id.strip()
            if len(cancellation_id) > 256:
                raise ValueError("thread_id must be at most 256 characters")
            reason = payload.get("reason", "cancelled by the app")
            if not isinstance(reason, str):
                raise ValueError("reason must be a string")
            aborted = await self._cancellations.abort(
                cancellation_id=cancellation_id,
                reason=reason,
            )
            return JSONResponse({"aborted": aborted, "thread_id": cancellation_id})
        except json.JSONDecodeError as error:
            return self._management_error(400, f"invalid JSON: {error.msg}")
        except ValueError as error:
            return self._management_error(400, str(error))

    async def chat_completions(self, request: Request) -> Response:
        """Translate an OpenAI Chat Completions request through LiteLLM."""
        return await self._inference(request, protocol="chat", call=self._chat_call)

    async def responses(self, request: Request) -> Response:
        """Translate an OpenAI Responses request through LiteLLM."""
        return await self._inference(request, protocol="responses", call=self._responses_call)

    async def messages(self, request: Request) -> Response:
        """Translate an Anthropic Messages request through LiteLLM."""
        return await self._inference(request, protocol="messages", call=self._messages_call)

    async def _inference(self, request: Request, *, protocol: str, call: AsyncCall) -> Response:
        """Resolve an alias, merge protected route parameters, and serialize the SDK result."""
        payload: JSONMapping = {}
        exchange: UpstreamExchange | None = None
        stream_owns_exchange = False
        try:
            payload = await self._read_object(request)
            alias = payload.get("model")
            if not isinstance(alias, str) or not alias:
                return self._protocol_error(protocol, 400, "model must be a non-empty string")
            route = self._resolve_route(alias)
            if LocalGrammarCompatibility.applies(route):
                # Before anything reads the tools: both dispatch paths below
                # carry this payload, and the native proxy forwards it verbatim.
                payload = LocalGrammarCompatibility.normalize(payload)
            # Track before any provider work starts, so a cancel arriving while
            # the prompt is still being processed has something to stop.
            exchange = self._cancellations.register(
                route_name=route.model_name,
                cancellation_id=self._cancellation_id(request),
            )
            if protocol in {"responses", "messages"}:
                # Messages requests can dispatch through LiteLLM's Responses adapter,
                # so both entry points must register the durable streaming capability
                # before the SDK decides whether to buffer an unknown custom model.
                self._capability_registrar.register_native_responses_streaming(route)
            if protocol == "responses":
                # Applied to the payload itself so both dispatch paths below inherit
                # it: native passthrough forwards this object to the provider, and
                # the SDK path copies it in `_call_arguments`.
                payload = ResponsesToolOutputNormalizer.normalize(payload)
            # Resolved first: which headers may travel depends on the endpoint
            # this call was routed to, which a native route only decides here.
            target = await self._credentials.resolve(route, request)
            forwarded_headers = self._forwarded_provider_headers(request, target)
            if self._uses_native_responses_sse(payload, route=route, protocol=protocol):
                session = await self._await_unless_disconnected(
                    request,
                    self._responses_sse_proxy.open(
                        payload=payload,
                        route=route,
                        forwarded_headers=forwarded_headers,
                        target=target,
                    ),
                    description="opening the provider Responses stream",
                    exchange=exchange,
                )
                await exchange.adopt(session)
                response_headers = {
                    "Cache-Control": "no-cache",
                    "X-Accel-Buffering": "no",
                    **self._responses_sse_proxy.response_headers(session),
                }
                # The stream outlives this handler, so it owns the exchange from
                # here: releasing it now would leave a cancel with nothing to find
                # for the whole response.
                stream_owns_exchange = True
                return StreamingResponse(
                    self._passthrough_stream(session, exchange=exchange),
                    status_code=session.response.status_code,
                    media_type="text/event-stream",
                    headers=response_headers,
                )

            arguments = self._call_arguments(payload, route, target)
            if protocol == "responses":
                arguments = ResponsesToolHistoryNormalizer.normalize(arguments)
            self._configure_sdk_tool_handling(arguments, protocol=protocol)
            # The target's headers come last: they identify the account the call
            # is billed to, and a forwarded header must never replace them.
            extra_headers = {**forwarded_headers, **target.headers}
            if extra_headers:
                arguments["extra_headers"] = extra_headers
            result = await self._await_unless_disconnected(
                request,
                call(**arguments),
                description=f"awaiting the {protocol} upstream response",
                exchange=exchange,
            )
            if payload.get("stream") is True:
                return StreamingResponse(
                    self._stream_events(result, protocol=protocol),
                    media_type="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
                )
            return JSONResponse(self._json_value(result))
        except KeyError:
            return self._protocol_error(protocol, 404, f"model '{payload.get('model', '')}' was not found")
        except MissingUpstreamCredential as error:
            return self._protocol_error(protocol, 401, str(error))
        except json.JSONDecodeError as error:
            return self._protocol_error(protocol, 400, f"invalid JSON: {error.msg}")
        except ValueError as error:
            return self._protocol_error(protocol, 400, str(error))
        except NativeResponsesProxyError as error:
            return self._protocol_error(protocol, error.status_code, str(error))
        except ClientDisconnected:
            # Nobody is left to read this; it only keeps the ASGI contract intact.
            return self._protocol_error(protocol, 499, "client closed the request")
        except UpstreamAborted as error:
            # The app stopped this turn deliberately; the provider connection is
            # already closed and this response only completes the exchange.
            return self._protocol_error(protocol, 499, str(error))
        except Exception as error:  # LiteLLM exposes provider-specific exception subclasses.
            status = getattr(error, "status_code", None)
            if not isinstance(status, int) or not 400 <= status <= 599:
                status = 500
            return self._protocol_error(protocol, status, str(error) or type(error).__name__)
        finally:
            if exchange is not None and not stream_owns_exchange:
                exchange.release()

    def _resolve_route(self, alias: str) -> ModelRoute:
        """Resolve an alias, falling back to a transient route for a Claude model.

        The registry stays the only source of seeded routes; this just stops an
        unseeded Claude model from being refused locally. A `KeyError` still
        leaves here for every other alias, so the 404 path is unchanged.

        Claude's pickers reject bare cloud route names, so Tokkey publishes them
        under a `PickerModelAlias`. The prefix is stripped here so the real route
        can be found in the registry — the route's own `litellm_params` still
        carry the correct model identifier sent upstream.
        """
        try:
            return self._registry.resolve(alias)
        except KeyError:
            # Retry under the picker alias before handing off to the Anthropic
            # unregistered-route path, which would otherwise try to forward a
            # cloud model name to Anthropic.
            body = PickerModelAlias.strip(alias)
            if body is not None:
                aliased = PickerModelAlias.resolve(body, self._registry.list())
                if aliased is not None:
                    return aliased
            route = UnregisteredClaudeRoute.build(alias)
            if route is None:
                raise
            LOGGER.info("Serving unregistered Claude model '%s' through Anthropic.", alias)
            return route

    async def _passthrough_stream(
        self,
        session: Any,
        *,
        exchange: UpstreamExchange,
    ) -> AsyncIterator[bytes]:
        """Forward the raw provider stream and stop tracking it once it ends."""
        try:
            async for chunk in session.iter_bytes():
                yield chunk
        finally:
            exchange.release()

    async def _await_unless_disconnected(
        self,
        request: Request,
        operation: Any,
        *,
        description: str,
        exchange: UpstreamExchange | None = None,
    ) -> Any:
        """Await upstream work, cancelling it if the caller gives up first.

        Two things can end the wait. A Codex `turn/interrupt` reaches this gateway
        only as a dropped socket, and nothing observes that socket while the
        upstream call connects, uploads, or waits for response headers -- Starlette
        starts watching only once it sends a response. An explicit cancel from the
        app arrives on a different connection entirely. Racing both against the
        call covers the phase where the runtime is busiest and no response has
        started, which is where a stop matters most.
        """
        upstream = asyncio.ensure_future(operation)
        upstream_cancelled_here = False
        watchers: dict[asyncio.Future[Any], str] = {
            asyncio.ensure_future(self._wait_for_disconnect(request)): "client disconnected",
        }
        if exchange is not None:
            watchers[asyncio.ensure_future(exchange.abort_event.wait())] = "the app cancelled the turn"
        try:
            done, _ = await asyncio.wait(
                {upstream, *watchers},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if upstream in done:
                return upstream.result()
            triggered = next(watcher for watcher in watchers if watcher in done)
            LOGGER.warning(
                "Stopping upstream request while %s: %s",
                description,
                watchers[triggered],
            )
            upstream.cancel()
            upstream_cancelled_here = True
            if exchange is not None and exchange.aborted:
                raise UpstreamAborted(exchange.route_name, exchange.reason)
            raise ClientDisconnected()
        finally:
            for watcher in watchers:
                watcher.cancel()
            watcher_results = await asyncio.gather(*watchers, return_exceptions=True)
            self._log_task_cleanup_failures(watcher_results, description="disconnect watcher")
            if upstream_cancelled_here:
                upstream_results = await asyncio.gather(upstream, return_exceptions=True)
                self._log_task_cleanup_failures(upstream_results, description="cancelled upstream request")

    @staticmethod
    def _log_task_cleanup_failures(results: list[Any], *, description: str) -> None:
        """Report teardown failures while ignoring the cancellation requested here."""
        for result in results:
            if isinstance(result, BaseException) and not isinstance(result, asyncio.CancelledError):
                LOGGER.error(
                    "Failure while awaiting %s cleanup: %s",
                    description,
                    result,
                    exc_info=(type(result), result, result.__traceback__),
                )

    @staticmethod
    async def _wait_for_disconnect(request: Request) -> None:
        """Block until the ASGI server reports the caller closed the connection."""
        while True:
            if (await request.receive()).get("type") == "http.disconnect":
                return

    @staticmethod
    def _uses_native_responses_sse(
        payload: JSONMapping,
        *,
        route: ModelRoute,
        protocol: str,
    ) -> bool:
        """Use raw passthrough only when the durable route explicitly guarantees it."""
        capabilities = route.streaming_capabilities
        return (
            protocol == "responses"
            and payload.get("stream") is True
            and capabilities.supports_native_streaming
            and capabilities.supports_responses_sse_passthrough
        )

    @staticmethod
    def _call_arguments(
        payload: JSONMapping,
        route: ModelRoute,
        target: UpstreamTarget,
    ) -> JSONMapping:
        """Prevent callers from overriding the endpoint and credential selected by Tokkey."""
        arguments = dict(payload)
        arguments.pop("extra_headers", None)
        arguments["model"] = route.litellm_params["model"]
        for key, value in route.litellm_params.items():
            if value is not None:
                arguments[key] = value
        # Last word on destination and credential together, so a payload key, a
        # route key, and the caller's header can never disagree about what
        # reaches which provider.
        arguments["api_key"] = target.api_key or UpstreamTargetPolicy.LOCAL_PLACEHOLDER_KEY
        if target.api_base:
            arguments["api_base"] = target.api_base
        else:
            # A route that configured no endpoint keeps using the SDK's default.
            arguments.pop("api_base", None)
        arguments.setdefault("drop_params", True)
        return arguments

    @staticmethod
    def _configure_sdk_tool_handling(arguments: JSONMapping, *, protocol: str) -> None:
        """Reject local Proxy MCP references and preserve provider-native tools."""
        tools = arguments.get("tools")
        if isinstance(tools, list) and any(
            isinstance(tool, dict)
            and tool.get("type") == "mcp"
            and str(tool.get("server_url", "")).startswith("litellm_proxy")
            for tool in tools
        ):
            raise ValueError("LiteLLM Proxy-managed MCP tools are not supported by the local Tokkey gateway")
        # LiteLLM 1.92 imports its Proxy MCP handler for Chat and Responses tools
        # before checking tool types. Messages uses a separate Anthropic SDK path
        # that does not accept this private compatibility flag.
        if protocol == "messages":
            return
        arguments["_skip_mcp_handler"] = True

    # Protocol feature headers every route may carry. Credentials are never in
    # this set: the gateway resolves those per route instead of relaying them.
    _PROTOCOL_FEATURE_HEADERS = frozenset({"anthropic-beta", "anthropic-version", "openai-beta"})

    @classmethod
    def _forwarded_provider_headers(cls, request: Request, target: UpstreamTarget) -> JSONMapping:
        """Forward only protocol feature headers, never local gateway credentials."""
        allowed = cls._PROTOCOL_FEATURE_HEADERS
        if CanonicalCodexEndpoint.matches(target.api_base):
            # The ChatGPT backend reads its caller's identity and attestation
            # headers, not just its token, so a Codex client's own set is passed
            # through unchanged for the one destination that understands it.
            allowed = allowed | CODEX_CLIENT_IDENTITY_HEADERS
        return {
            name: value
            for name, value in request.headers.items()
            if name.lower() in allowed
        }

    @staticmethod
    def _cancellation_id(request: Request) -> str | None:
        """Read the private Codex correlation header without forwarding it upstream."""
        value = request.headers.get("x-tokkey-thread-id", "").strip()
        if not value:
            return None
        # Oversized untrusted identifiers are intentionally not registered. The
        # inference request remains valid, but no management request can target it.
        return value if len(value) <= 256 else None

    async def _stream_events(self, stream: Any, *, protocol: str) -> AsyncIterator[bytes]:
        """Encode native SSE and stop Responses streams at their semantic terminal event."""
        forwarded_event_count = 0
        try:
            async for event in stream:
                forwarded_event_count += 1
                # LiteLLM's Anthropic iterator emits complete SSE frames, while
                # Chat and Responses iterators emit structured response objects.
                if protocol == "messages" and isinstance(event, (bytes, bytearray, memoryview)):
                    yield bytes(event)
                    continue
                value = self._json_value(event)
                serialized = json.dumps(value, separators=(",", ":"), ensure_ascii=False)
                if protocol == "messages":
                    event_type = value.get("type", "message") if isinstance(value, dict) else "message"
                    yield f"event: {event_type}\ndata: {serialized}\n\n".encode()
                else:
                    yield f"data: {serialized}\n\n".encode()
                # The terminal event is part of the public protocol and must be
                # forwarded before closing the SDK iterator. Waiting for EOF here
                # can otherwise keep an already-complete Codex turn active for minutes.
                if ResponsesStreamTerminationPolicy.is_terminal(value, protocol=protocol):
                    break
            if protocol == "chat":
                yield b"data: [DONE]\n\n"
        # Mirrors the native passthrough path: a client that drops the socket
        # mid-turn (a Codex `turn/interrupt`) reaches this generator as a
        # cancellation, and the SDK iterator below is what releases the provider.
        except (asyncio.CancelledError, GeneratorExit):
            LOGGER.warning(
                "Client abandoned %s stream after %d forwarded events; closing SDK iterator",
                protocol,
                forwarded_event_count,
            )
            raise
        finally:
            await ResponsesStreamTerminationPolicy.close(stream)

    @staticmethod
    async def _read_object(request: Request) -> JSONMapping:
        """Decode one request body and reject arrays/scalars with a useful diagnostic."""
        payload = await request.json()
        if not isinstance(payload, dict):
            raise ValueError("request body must be a JSON object")
        return payload

    @staticmethod
    def _json_value(value: Any) -> Any:
        """Normalize Pydantic/OpenAI/LiteLLM response objects without string parsing."""
        if hasattr(value, "model_dump"):
            return value.model_dump(mode="json", exclude_none=True)
        if hasattr(value, "dict"):
            return value.dict()
        if isinstance(value, (dict, list, str, int, float, bool)) or value is None:
            return value
        raise TypeError(f"LiteLLM returned unsupported response type {type(value).__name__}")

    @staticmethod
    def _management_error(status: int, message: str) -> JSONResponse:
        """Keep management failures compatible with LiteLLM's detail-bearing responses."""
        return JSONResponse({"detail": message}, status_code=status)

    @staticmethod
    def _protocol_error(protocol: str, status: int, message: str) -> JSONResponse:
        """Return the native error envelope expected by OpenAI or Anthropic clients."""
        if protocol == "messages":
            return JSONResponse(
                {"type": "error", "error": {"type": "api_error", "message": message}},
                status_code=status,
            )
        return JSONResponse(
            {"error": {"message": message, "type": "api_error", "code": status}},
            status_code=status,
        )


def create_app(*, instance_id: str | None = None) -> Starlette:
    """Build the ASGI app from the launch identity owned by the supervisor."""
    resolved_instance_id = instance_id or os.environ.get(
        "AMIS_GATEWAY_INSTANCE_ID",
        "embedded-test-instance",
    )
    return AmisGatewayApplication(instance_id=resolved_instance_id).app
