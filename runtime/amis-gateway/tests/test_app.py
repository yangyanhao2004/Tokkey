"""Protocol and management tests for the focused Tokkey gateway surface."""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
import litellm
import pytest
from amis_gateway.app import (
    GATEWAY_RUNTIME_PROTOCOL_VERSION,
    AmisGatewayApplication,
    ClientDisconnected,
    LiteLLMSDKCompatibility,
    ResponsesToolOutputNormalizer,
)
from amis_gateway.cancellation import UpstreamAborted
from amis_gateway.credentials import UpstreamTarget

# The gateway authenticates nobody; a caller's key is only a candidate
# credential for the upstream provider call.
CALLER_KEY = "caller-supplied-key"
AUTH = {"Authorization": f"Bearer {CALLER_KEY}"}


async def test_health_reports_launch_identity_and_runtime_protocol() -> None:
    """The supervisor can distinguish its helper from stale app builds."""
    application = AmisGatewayApplication(instance_id="current-app-launch")
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application.app),
        base_url="http://gateway.test",
    )

    response = await client.get("/health/liveliness")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "amis-gateway",
        "instance_id": "current-app-launch",
        "runtime_protocol_version": GATEWAY_RUNTIME_PROTOCOL_VERSION,
    }
    await client.aclose()


class FakeResponse:
    """Minimal Pydantic-like SDK result used to verify structured serialization."""

    def __init__(self, value: dict[str, Any]) -> None:
        self.value = value

    def model_dump(self, **_: Any) -> dict[str, Any]:
        """Match the response protocol implemented by LiteLLM's typed models."""
        return self.value


class FakeAsyncStream:
    """Async iterator matching LiteLLM's streaming response contract."""

    def __init__(self, events: list[Any]) -> None:
        self._events = iter(events)

    def __aiter__(self) -> "FakeAsyncStream":
        return self

    async def __anext__(self) -> Any:
        try:
            event = next(self._events)
            # Anthropic streams are native SSE bytes; other SDK streams expose
            # typed response models represented by dictionaries in these tests.
            return FakeResponse(event) if isinstance(event, dict) else event
        except StopIteration as error:
            raise StopAsyncIteration from error


class HangingAfterTerminalStream:
    """Stream that never reaches EOF unless the Gateway actively closes it."""

    def __init__(self, terminal_type: str) -> None:
        self._terminal_type = terminal_type
        self._emitted_terminal = False
        self._closed = asyncio.Event()

    @property
    def was_closed(self) -> bool:
        """Expose cleanup state without leaking the internal synchronization primitive."""
        return self._closed.is_set()

    def __aiter__(self) -> "HangingAfterTerminalStream":
        return self

    async def __anext__(self) -> FakeResponse:
        if not self._emitted_terminal:
            self._emitted_terminal = True
            return FakeResponse({"type": self._terminal_type, "response": {"id": "resp"}})
        await self._closed.wait()
        raise StopAsyncIteration

    async def aclose(self) -> None:
        """Mirror LiteLLM's close contract and unblock a pending next event."""
        self._closed.set()


def model_payload() -> dict[str, Any]:
    """Build one model route with protected upstream credentials."""
    return {
        "model_name": "agent-model",
        "litellm_params": {
            "model": "openai/upstream-model",
            "api_key": "upstream-secret",
            "api_base": "https://provider.example/v1",
        },
        "model_info": {
            "created_by": "tokkey",
            "profile_id": "profile-id",
            "api_format": "openai_chat",
        },
    }


async def test_model_discovery_lists_routes_without_leaking_credentials() -> None:
    """A client's model picker sees the aliases, never the keys behind them."""
    application = AmisGatewayApplication()
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application.app),
        base_url="http://gateway.test",
    )

    labelled = model_payload()
    labelled["model_name"] = "claude-opus-5"
    labelled["model_info"] = {**labelled["model_info"], "display_name": "Claude Opus 5"}
    await client.post("/model/new", headers=AUTH, json=labelled)
    await client.post("/model/new", headers=AUTH, json=model_payload())

    response = await client.get("/v1/models?limit=1000", headers=AUTH)

    assert response.status_code == 200
    body = response.json()
    assert body["object"] == "list"
    # Alias-sorted, matching the registry's own stable ordering.
    assert [entry["id"] for entry in body["data"]] == ["agent-model", "claude-opus-5"]
    assert body["data"][1]["display_name"] == "Claude Opus 5"
    # A route with no label omits the field rather than echoing its id.
    assert "display_name" not in body["data"][0]
    # The upstream endpoint and key stay in the management view alone.
    assert "upstream-secret" not in response.text
    assert "provider.example" not in response.text

    # `/models` serves OpenAI-format callers the identical document.
    assert (await client.get("/models", headers=AUTH)).json() == body
    await client.aclose()


async def test_model_discovery_survives_an_unusable_limit() -> None:
    """A malformed limit yields the full picker instead of an empty one."""
    application = AmisGatewayApplication()
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application.app),
        base_url="http://gateway.test",
    )
    await client.post("/model/new", headers=AUTH, json=model_payload())

    for query in ("?limit=not-a-number", "?limit=0", "?limit=-5", ""):
        response = await client.get(f"/v1/models{query}", headers=AUTH)
        assert response.status_code == 200, query
        assert [entry["id"] for entry in response.json()["data"]] == ["agent-model"], query

    await client.aclose()


async def messages_turn(alias: str, *, headers: dict[str, str] | None = None) -> Any:
    """Run one Messages turn against a gateway holding no route at all."""
    captured: dict[str, Any] = {}

    async def messages_call(**kwargs: Any) -> FakeResponse:
        captured.update(kwargs)
        return FakeResponse({"id": "msg"})

    application = AmisGatewayApplication(messages_call=messages_call)
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application.app),
        base_url="http://gateway.test",
    )
    response = await client.post(
        "/v1/messages",
        headers=AUTH if headers is None else headers,
        json={"model": alias, "messages": [], "max_tokens": 10},
    )
    await client.aclose()
    return response, captured


async def test_unseeded_claude_model_is_served_instead_of_refused() -> None:
    """A model newer than this build's catalog still reaches Anthropic."""
    response, captured = await messages_turn("claude-opus-6")

    assert response.status_code == 200
    # Provider-qualified so LiteLLM picks Anthropic, and no endpoint, so the
    # caller's subscription token can only ever travel to Anthropic itself.
    assert captured["model"] == "anthropic/claude-opus-6"
    assert captured["api_key"] == CALLER_KEY
    assert "api_base" not in captured


async def test_unseeded_claude_model_is_served_without_being_registered() -> None:
    """Serving an unknown alias must not grow the set the picker advertises."""
    async def messages_call(**_: Any) -> FakeResponse:
        return FakeResponse({"id": "msg"})

    application = AmisGatewayApplication(messages_call=messages_call)
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application.app),
        base_url="http://gateway.test",
    )
    await client.post(
        "/v1/messages",
        headers=AUTH,
        json={"model": "claude-opus-6", "messages": [], "max_tokens": 10},
    )

    # A typo would otherwise become a permanent phantom entry in the picker.
    assert (await client.get("/v1/models", headers=AUTH)).json()["data"] == []
    assert (await client.get("/model/info", headers=AUTH)).json()["data"] == []
    await client.aclose()


async def test_unseeded_claude_model_still_requires_the_caller_to_bring_a_key() -> None:
    """The fallback widens routing, never the credential rules."""
    response, _ = await messages_turn("claude-opus-6", headers={})

    assert response.status_code == 401
    assert "claude-opus-6" in response.json()["error"]["message"]


async def test_picker_alias_resolves_to_the_route_behind_it() -> None:
    """Claude's pickers name a cloud route under a prefix the gateway takes off."""
    captured: dict[str, Any] = {}

    async def messages_call(**kwargs: Any) -> FakeResponse:
        captured.update(kwargs)
        return FakeResponse({"id": "msg"})

    application = AmisGatewayApplication(messages_call=messages_call)
    application._registry.create(model_payload())
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application.app),
        base_url="http://gateway.test",
    )

    response = await client.post(
        "/v1/messages",
        headers=AUTH,
        json={"model": "anthropic.agent-model", "messages": [], "max_tokens": 10},
    )

    assert response.status_code == 200
    # The registered route answered — not the unregistered-Claude fallback, which
    # would have sent an "anthropic/..." model to Anthropic with no api_base.
    assert captured["model"] == "openai/upstream-model"
    assert captured["api_base"] == "https://provider.example/v1"
    await client.aclose()


async def test_picker_alias_resolves_a_route_named_only_by_its_id_suffix() -> None:
    """Claude Desktop refuses a vendor-named route, so it names one by its suffix."""
    captured: dict[str, Any] = {}

    async def messages_call(**kwargs: Any) -> FakeResponse:
        captured.update(kwargs)
        return FakeResponse({"id": "msg"})

    application = AmisGatewayApplication(messages_call=messages_call)
    suffixed = model_payload()
    suffixed["model_name"] = "custom-gpt-5.6-terra-openai-c05442"
    application._registry.create(suffixed)
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application.app),
        base_url="http://gateway.test",
    )

    response = await client.post(
        "/v1/messages",
        headers=AUTH,
        json={"model": "anthropic.c05442", "messages": [], "max_tokens": 10},
    )

    assert response.status_code == 200
    assert captured["model"] == "openai/upstream-model"
    await client.aclose()


async def test_picker_alias_refuses_a_suffix_two_routes_share() -> None:
    """An ambiguous suffix names no route, rather than an arbitrary one of them."""
    application = AmisGatewayApplication()
    for provider in ("openai", "azure"):
        route = model_payload()
        route["model_name"] = f"custom-model-{provider}-c05442"
        application._registry.create(route)
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application.app),
        base_url="http://gateway.test",
    )

    response = await client.post(
        "/v1/messages",
        headers=AUTH,
        json={"model": "anthropic.c05442", "messages": [], "max_tokens": 10},
    )

    # Refused locally: serving either one would bill a provider the user's
    # picker never named.
    assert response.status_code == 404
    await client.aclose()


async def test_fallback_refuses_to_relay_a_non_anthropic_alias() -> None:
    """An unregistered alias cannot aim the caller's key at another provider."""
    for alias in ("openai/gpt-5", "gpt-5", "anthropic/gpt-5", "sonnet", "anthropic/"):
        response, captured = await messages_turn(alias)
        assert response.status_code == 404, alias
        assert captured == {}, alias


async def test_management_crud_and_atomic_restore() -> None:
    """Swift's existing create/list/update/delete shapes remain compatible."""
    application = AmisGatewayApplication()
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application.app),
        base_url="http://gateway.test",
    )

    created = await client.post("/model/new", headers=AUTH, json=model_payload())
    assert created.status_code == 200
    model_id = created.json()["model_id"]
    assert (await client.get("/model/info", headers=AUTH)).json()["data"][0]["model_info"]["id"] == model_id

    updated = await client.patch(
        f"/model/{model_id}/update",
        headers=AUTH,
        json={"litellm_params": {"model": "openai/new", "api_key": "new-secret"}},
    )
    assert updated.status_code == 200

    replaced = await client.put(
        "/_amis/models",
        headers=AUTH,
        json={"models": [{"model_id": "sqlite-id", "model": model_payload()}]},
    )
    assert replaced.json() == {"replaced": 1}
    assert (await client.get("/model/info", headers=AUTH)).json()["data"][0]["model_info"]["id"] == "sqlite-id"

    assert (await client.post("/model/delete", headers=AUTH, json={"id": "sqlite-id"})).status_code == 200
    assert (await client.get("/model/info", headers=AUTH)).json() == {"data": []}
    await client.aclose()


async def test_chat_request_uses_route_credentials_and_streams_openai_sse() -> None:
    """Agent-supplied routing values cannot override Tokkey's selected upstream."""
    captured: dict[str, Any] = {}

    async def chat_call(**kwargs: Any) -> FakeAsyncStream:
        captured.update(kwargs)
        return FakeAsyncStream([{"id": "chunk", "choices": []}])

    application = AmisGatewayApplication(chat_call=chat_call)
    application._registry.create(model_payload())
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application.app),
        base_url="http://gateway.test",
    )
    response = await client.post(
        "/v1/chat/completions",
        headers=AUTH,
        json={"model": "agent-model", "messages": [], "stream": True, "api_key": "attacker"},
    )

    assert response.status_code == 200
    assert captured["model"] == "openai/upstream-model"
    assert captured["api_key"] == "upstream-secret"
    assert captured["_skip_mcp_handler"] is True
    assert "data: {\"id\":\"chunk\",\"choices\":[]}" in response.text
    assert response.text.endswith("data: [DONE]\n\n")
    await client.aclose()


async def responses_route_credential(
    route: dict[str, Any],
    headers: dict[str, str],
) -> Any:
    """Run one Responses turn through the SDK path and report the key it used."""
    captured: dict[str, Any] = {}

    async def responses_call(**kwargs: Any) -> FakeResponse:
        captured.update(kwargs)
        return FakeResponse({"id": "resp"})

    application = AmisGatewayApplication(responses_call=responses_call)
    application._registry.create(route)
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application.app),
        base_url="http://gateway.test",
    )

    response = await client.post(
        "/v1/responses",
        headers=headers,
        json={"model": "agent-model", "input": "hello"},
    )

    assert response.status_code == 200
    await client.aclose()
    return captured["api_key"]


async def test_local_provider_route_needs_no_credential_from_anyone() -> None:
    """A model served from this machine is called without a real key."""
    route = model_payload()
    route["litellm_params"]["api_base"] = "http://127.0.0.1:8080/v1"
    del route["litellm_params"]["api_key"]

    # The placeholder only exists because the provider SDK refuses to build a
    # client without one; the loopback server ignores it.
    assert await responses_route_credential(route, AUTH) == "local"


async def test_stored_route_key_wins_over_the_caller_header() -> None:
    """An agent cannot redirect a paid provider call onto its own credential."""
    assert await responses_route_credential(model_payload(), AUTH) == "upstream-secret"


async def test_public_route_without_a_stored_key_forwards_the_caller_header() -> None:
    """Codex may bring its own key for a route Tokkey holds no key for."""
    route = model_payload()
    del route["litellm_params"]["api_key"]

    assert await responses_route_credential(route, AUTH) == CALLER_KEY
    assert await responses_route_credential(
        route,
        {"x-api-key": CALLER_KEY},
    ) == CALLER_KEY


async def test_public_route_without_any_credential_is_rejected_before_the_provider() -> None:
    """A key nobody supplied is reported here instead of as an opaque upstream 401."""
    async def responses_call(**_: Any) -> FakeResponse:
        raise AssertionError("the provider must not be called without a credential")

    application = AmisGatewayApplication(responses_call=responses_call)
    route = model_payload()
    del route["litellm_params"]["api_key"]
    application._registry.create(route)
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application.app),
        base_url="http://gateway.test",
    )

    response = await client.post("/v1/responses", json={"model": "agent-model", "input": "hello"})

    assert response.status_code == 401
    assert "agent-model" in response.json()["error"]["message"]
    await client.aclose()


async def test_local_provider_stream_carries_no_authorization_header() -> None:
    """Raw passthrough to a loopback model server sends no credential at all."""
    captured: dict[str, Any] = {}

    async def upstream(request: httpx.Request) -> httpx.Response:
        captured["authorization"] = request.headers.get("authorization")
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            stream=httpx.ByteStream(b'data: {"type":"response.completed"}\n\n'),
        )

    from amis_gateway.streaming import NativeResponsesSSEProxy

    application = AmisGatewayApplication(
        responses_sse_proxy=NativeResponsesSSEProxy(transport=httpx.MockTransport(upstream)),
    )
    route = passthrough_route_payload()
    route["litellm_params"]["api_base"] = "http://localhost:8080/v1"
    del route["litellm_params"]["api_key"]
    application._registry.create(route)
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application.app),
        base_url="http://gateway.test",
    )

    response = await client.post(
        "/v1/responses",
        headers=AUTH,
        json={"model": "agent-model", "input": "hello", "stream": True},
    )

    assert response.status_code == 200
    assert captured["authorization"] is None
    await client.aclose()


async def test_responses_registers_explicit_native_streaming_before_sdk_call() -> None:
    """Controlled runtimes bypass LiteLLM's fake stream for unknown model names."""
    real_model = "tokkey-unknown-native-streaming-model"
    observed: dict[str, bool] = {}

    async def responses_call(**_: Any) -> FakeAsyncStream:
        observed["supports_native_streaming"] = litellm.utils.supports_native_streaming(
            model=real_model,
            custom_llm_provider="openai",
        )
        return FakeAsyncStream([{"type": "response.completed"}])

    application = AmisGatewayApplication(responses_call=responses_call)
    route = model_payload()
    route["litellm_params"]["model"] = f"openai/{real_model}"
    route["model_info"].update({
        "api_format": "openai_responses",
        "supports_native_streaming": True,
    })
    application._registry.create(route)
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application.app),
        base_url="http://gateway.test",
    )

    response = await client.post(
        "/v1/responses",
        headers=AUTH,
        json={"model": "agent-model", "input": "hello", "stream": True},
    )

    assert response.status_code == 200
    assert observed["supports_native_streaming"] is True
    await client.aclose()


async def test_messages_registers_explicit_native_responses_streaming_before_sdk_call() -> None:
    """Messages routes register before LiteLLM dispatches them through Responses."""
    real_model = "tokkey-unknown-messages-native-streaming-model"
    observed: dict[str, bool] = {}

    async def messages_call(**_: Any) -> FakeAsyncStream:
        observed["supports_native_streaming"] = litellm.utils.supports_native_streaming(
            model=real_model,
            custom_llm_provider="openai",
        )
        return FakeAsyncStream(
            [b'event: message_stop\ndata: {"type":"message_stop"}\n\n']
        )

    application = AmisGatewayApplication(messages_call=messages_call)
    route = model_payload()
    route["litellm_params"]["model"] = f"openai/{real_model}"
    route["model_info"].update({
        "api_format": "openai_responses",
        "supports_native_streaming": True,
    })
    application._registry.create(route)
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application.app),
        base_url="http://gateway.test",
    )

    response = await client.post(
        "/v1/messages",
        headers={"x-api-key": CALLER_KEY},
        json={"model": "agent-model", "messages": [], "max_tokens": 10, "stream": True},
    )

    assert response.status_code == 200
    assert observed["supports_native_streaming"] is True
    await client.aclose()


async def test_responses_does_not_assume_streaming_for_unmarked_routes() -> None:
    """Custom endpoints remain governed by LiteLLM when capability is unknown."""
    real_model = "tokkey-unknown-custom-model"
    observed: dict[str, bool] = {}

    async def responses_call(**_: Any) -> FakeAsyncStream:
        observed["supports_native_streaming"] = litellm.utils.supports_native_streaming(
            model=real_model,
            custom_llm_provider="openai",
        )
        return FakeAsyncStream([{"type": "response.completed"}])

    application = AmisGatewayApplication(responses_call=responses_call)
    route = model_payload()
    route["litellm_params"]["model"] = f"openai/{real_model}"
    route["model_info"]["api_format"] = "openai_responses"
    application._registry.create(route)
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application.app),
        base_url="http://gateway.test",
    )

    response = await client.post(
        "/v1/responses",
        headers=AUTH,
        json={"model": "agent-model", "input": "hello", "stream": True},
    )

    assert response.status_code == 200
    assert observed["supports_native_streaming"] is False
    await client.aclose()


async def test_deepseek_function_tools_avoid_proxy_only_mcp_imports() -> None:
    """DeepSeek function calling works without LiteLLM's full Proxy extras."""
    application = AmisGatewayApplication()
    route = model_payload()
    route["litellm_params"]["model"] = "deepseek/deepseek-v4-pro"
    application._registry.create(route)
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application.app),
        base_url="http://gateway.test",
    )
    response = await client.post(
        "/v1/chat/completions",
        headers=AUTH,
        json={
            "model": "agent-model",
            "messages": [{"role": "user", "content": "hello"}],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "noop",
                        "description": "Return without side effects.",
                        "parameters": {"type": "object", "properties": {}},
                    },
                }
            ],
            "mock_response": "ok",
        },
    )

    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"] == "ok"
    await client.aclose()


async def test_chat_rejects_proxy_managed_mcp_tools() -> None:
    """True MCP tools fail clearly instead of importing unavailable Proxy modules."""
    application = AmisGatewayApplication()
    application._registry.create(model_payload())
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application.app),
        base_url="http://gateway.test",
    )
    response = await client.post(
        "/v1/chat/completions",
        headers=AUTH,
        json={
            "model": "agent-model",
            "messages": [{"role": "user", "content": "hello"}],
            "tools": [{"type": "mcp", "server_url": "litellm_proxy"}],
        },
    )

    assert response.status_code == 400
    assert "Proxy-managed MCP tools are not supported" in response.json()["error"]["message"]
    await client.aclose()


async def test_anthropic_messages_uses_native_error_and_event_envelopes() -> None:
    """Claude-compatible requests accept x-api-key and emit named Anthropic SSE events."""
    captured: dict[str, Any] = {}

    async def messages_call(**kwargs: Any) -> FakeAsyncStream:
        captured.update(kwargs)
        return FakeAsyncStream(
            [b'event: message_start\ndata: {"type":"message_start","message":{"id":"msg"}}\n\n']
        )

    application = AmisGatewayApplication(messages_call=messages_call)
    application._registry.create(model_payload())
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application.app),
        base_url="http://gateway.test",
    )
    response = await client.post(
        "/v1/messages",
        headers={"x-api-key": CALLER_KEY, "anthropic-beta": "feature-2026-01-01"},
        json={"model": "agent-model", "messages": [], "max_tokens": 10, "stream": True},
    )

    assert response.status_code == 200
    assert response.text.startswith("event: message_start\ndata: ")
    assert captured["extra_headers"] == {"anthropic-beta": "feature-2026-01-01"}
    assert "_skip_mcp_handler" not in captured
    missing = await client.post(
        "/v1/messages",
        headers={"x-api-key": CALLER_KEY},
        json={"model": "missing", "messages": [], "max_tokens": 10},
    )
    assert missing.status_code == 404
    assert missing.json()["type"] == "error"
    await client.aclose()


def test_anthropic_streaming_handler_dependencies_are_installed() -> None:
    """The SDK-only runtime includes LiteLLM's Anthropic stream dependencies."""
    from litellm.proxy.pass_through_endpoints.streaming_handler import (
        PassThroughStreamingHandler,
    )

    assert PassThroughStreamingHandler is not None


async def test_responses_returns_structured_sdk_result() -> None:
    """Responses API output is serialized from LiteLLM's typed object directly."""
    async def responses_call(**_: Any) -> FakeResponse:
        return FakeResponse({"id": "resp", "object": "response", "status": "completed"})

    application = AmisGatewayApplication(responses_call=responses_call)
    application._registry.create(model_payload())
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application.app),
        base_url="http://gateway.test",
    )
    response = await client.post(
        "/v1/responses",
        headers=AUTH,
        json={"model": "agent-model", "input": "hello"},
    )

    assert response.status_code == 200
    assert response.json() == {"id": "resp", "object": "response", "status": "completed"}
    await client.aclose()


@pytest.mark.parametrize(
    "terminal_type",
    [
        "response.completed",
        "response.failed",
        "response.incomplete",
        "response.cancelled",
    ],
)
async def test_responses_stream_ends_and_closes_iterator_at_terminal_event(
    terminal_type: str,
) -> None:
    """A semantic terminal event must finish promptly even if upstream never sends EOF."""
    stream = HangingAfterTerminalStream(terminal_type)
    application = AmisGatewayApplication()

    async def collect_events() -> list[bytes]:
        return [
            event
            async for event in application._stream_events(stream, protocol="responses")
        ]

    events = await asyncio.wait_for(collect_events(), timeout=0.25)

    assert events == [
        f'data: {{"type":"{terminal_type}","response":{{"id":"resp"}}}}\n\n'.encode()
    ]
    assert stream.was_closed is True


async def test_responses_stream_does_not_stop_at_non_terminal_delta() -> None:
    """Ordinary output deltas continue until a real terminal event is forwarded."""
    stream = FakeAsyncStream(
        [
            {"type": "response.output_text.delta", "delta": "OK"},
            {"type": "response.completed", "response": {"id": "resp"}},
            {"type": "response.output_text.delta", "delta": "ignored"},
        ]
    )
    application = AmisGatewayApplication()

    events = [
        event
        async for event in application._stream_events(stream, protocol="responses")
    ]

    assert len(events) == 2
    assert b"response.output_text.delta" in events[0]
    assert b"response.completed" in events[1]


async def test_responses_disable_proxy_mcp_dispatch_and_preserve_provider_tools() -> None:
    """Responses bypasses LiteLLM Proxy MCP while forwarding native MCP tools."""
    captured: dict[str, Any] = {}

    async def responses_call(**kwargs: Any) -> FakeResponse:
        captured.update(kwargs)
        return FakeResponse({"id": "resp", "object": "response", "status": "completed"})

    application = AmisGatewayApplication(responses_call=responses_call)
    application._registry.create(model_payload())
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application.app),
        base_url="http://gateway.test",
    )
    provider_tool = {
        "type": "mcp",
        "server_label": "provider-mcp",
        "server_url": "https://provider.example/mcp",
    }
    response = await client.post(
        "/v1/responses",
        headers=AUTH,
        json={"model": "agent-model", "input": "hello", "tools": [provider_tool]},
    )

    from litellm.responses import main as responses_main

    assert response.status_code == 200
    assert captured["tools"] == [provider_tool]
    assert captured["_skip_mcp_handler"] is True
    assert (
        responses_main._responses_try_dispatch_mcp_gateway
        is LiteLLMSDKCompatibility._skip_proxy_mcp_dispatch
    )
    await client.aclose()


async def test_deepseek_responses_to_chat_translation_skips_proxy_mcp(monkeypatch: Any) -> None:
    """Codex tool history reaches DeepSeek with valid Chat message ordering."""
    captured: dict[str, Any] = {}

    async def completion_call(**kwargs: Any) -> Any:
        captured.update(kwargs)
        return litellm.ModelResponse(
            model="deepseek-v4-pro",
            choices=[
                {
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {"role": "assistant", "content": "ok"},
                }
            ],
        )

    monkeypatch.setattr(litellm, "acompletion", completion_call)
    application = AmisGatewayApplication()
    route = model_payload()
    route["litellm_params"]["model"] = "deepseek/deepseek-v4-pro"
    application._registry.create(route)
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application.app),
        base_url="http://gateway.test",
    )
    response = await client.post(
        "/v1/responses",
        headers=AUTH,
        json={
            "model": "agent-model",
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "inspect files"}],
                },
                {
                    "type": "function_call",
                    "call_id": "call-1",
                    "name": "noop",
                    "arguments": "{}",
                },
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "I will inspect it."}],
                },
                {
                    "type": "function_call_output",
                    "call_id": "call-1",
                    "output": "done",
                },
            ],
            "tools": [
                {
                    "type": "function",
                    "name": "noop",
                    "description": "Return without side effects.",
                    "parameters": {"type": "object", "properties": {}},
                }
            ],
        },
    )

    assert response.status_code == 200
    assert response.json()["output"][0]["content"][0]["text"] == "ok"
    assert captured["_skip_mcp_handler"] is True
    messages = captured["messages"]
    tool_call_index = next(index for index, message in enumerate(messages) if message.get("tool_calls"))
    assert messages[tool_call_index]["role"] == "assistant"
    assert messages[tool_call_index]["content"] == [
        {"type": "text", "text": "I will inspect it."}
    ]
    assert messages[tool_call_index + 1]["role"] == "tool"
    assert messages[tool_call_index + 1]["tool_call_id"] == "call-1"
    # LiteLLM records transformed-call metadata asynchronously; drain it before
    # pytest closes this test's event loop so the SDK does not leak a coroutine.
    from litellm.litellm_core_utils.logging_worker import GLOBAL_LOGGING_WORKER

    await GLOBAL_LOGGING_WORKER.clear_queue()
    await client.aclose()


def test_upstream_proxy_policy_bypasses_local_model_addresses() -> None:
    """LAN model servers stay direct even when the app mirrors a SOCKS proxy."""
    from amis_gateway.streaming import UpstreamProxyPolicy

    policy = UpstreamProxyPolicy()

    assert policy.should_trust_environment(
        "http://192.168.1.210:8080/v1/responses"
    ) is False
    assert policy.should_trust_environment(
        "http://127.0.0.1:8080/v1/responses"
    ) is False
    assert policy.should_trust_environment(
        "http://[::1]:8080/v1/responses"
    ) is False
    assert policy.should_trust_environment(
        "http://model-server.local/v1/responses"
    ) is False
    assert policy.should_trust_environment(
        "https://provider.example/v1/responses"
    ) is True


class ControlledSSEStream(httpx.AsyncByteStream):
    """Yield one event immediately and hold the terminal event behind a gate."""

    def __init__(self) -> None:
        self.release_terminal = asyncio.Event()
        self.was_closed = False

    async def __aiter__(self):
        yield b'data: {"type":"response.reasoning_text.delta","delta":"thinking"}\n\n'
        await self.release_terminal.wait()
        yield b'data: {"type":"response.completed","response":{"id":"resp"}}\n\n'

    async def aclose(self) -> None:
        self.was_closed = True
        self.release_terminal.set()


async def test_native_responses_route_passthrough_streams_before_terminal_event() -> None:
    """An explicitly capable unknown model bypasses LiteLLM fake streaming."""
    upstream_stream = ControlledSSEStream()
    captured: dict[str, Any] = {}

    async def upstream(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["authorization"] = request.headers.get("authorization")
        captured["payload"] = __import__("json").loads(request.content)
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream", "x-request-id": "upstream-id"},
            stream=upstream_stream,
        )

    from amis_gateway.streaming import NativeResponsesSSEProxy

    application = AmisGatewayApplication(
        responses_sse_proxy=NativeResponsesSSEProxy(
            transport=httpx.MockTransport(upstream),
        ),
    )
    route = model_payload()
    route["litellm_params"]["model"] = "openai/Qwen3.5-35B-A3B-Q4_K_M.gguf"
    route["model_info"]["api_format"] = "openai_responses"
    route["model_info"]["supports_native_streaming"] = True
    route["model_info"]["supports_responses_sse_passthrough"] = True
    resolved = application._registry.create(route)

    session = await application._responses_sse_proxy.open(
        payload={"model": resolved.model_name, "input": "hello", "stream": True},
        route=resolved,
        forwarded_headers={},
        target=UpstreamTarget(
            api_base="https://provider.example/v1",
            api_key="upstream-secret",
        ),
    )
    iterator = session.iter_bytes()
    first = await asyncio.wait_for(anext(iterator), timeout=0.1)

    assert b"response.reasoning_text.delta" in first
    assert upstream_stream.release_terminal.is_set() is False
    assert captured == {
        "url": "https://provider.example/v1/responses",
        "authorization": "Bearer upstream-secret",
        "payload": {
            "model": "Qwen3.5-35B-A3B-Q4_K_M.gguf",
            "input": "hello",
            "stream": True,
        },
    }

    await iterator.aclose()
    assert upstream_stream.was_closed is True


async def test_native_responses_route_preserves_raw_sse_frames_through_asgi() -> None:
    """The Gateway forwards provider SSE bytes instead of reserializing SDK events."""
    raw_events = (
        b'event: response.output_text.delta\r\n'
        b'data: {"type":"response.output_text.delta","delta":"OK"}\r\n\r\n'
        b'data: {"type":"response.completed","response":{"id":"resp"}}\r\n\r\n'
    )

    async def upstream(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=httpx.ByteStream(raw_events))

    from amis_gateway.streaming import NativeResponsesSSEProxy

    application = AmisGatewayApplication(
        responses_sse_proxy=NativeResponsesSSEProxy(transport=httpx.MockTransport(upstream)),
    )
    route = model_payload()
    route["model_info"].update(
        {
            "api_format": "openai_responses",
            "supports_native_streaming": True,
            "supports_responses_sse_passthrough": True,
        }
    )
    application._registry.create(route)
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application.app),
        base_url="http://gateway.test",
    )

    response = await client.post(
        "/v1/responses",
        headers=AUTH,
        json={"model": "agent-model", "input": "hello", "stream": True},
    )

    assert response.status_code == 200
    assert response.content == raw_events
    await client.aclose()


async def test_native_responses_flattens_image_tool_output_before_upstream() -> None:
    """Codex `view_image` results reach text-only providers instead of failing the turn."""
    captured: dict[str, Any] = {}

    async def upstream(request: httpx.Request) -> httpx.Response:
        captured["payload"] = __import__("json").loads(request.content)
        return httpx.Response(
            200,
            stream=httpx.ByteStream(b'data: {"type":"response.completed","response":{}}\n\n'),
        )

    from amis_gateway.streaming import NativeResponsesSSEProxy

    application = AmisGatewayApplication(
        responses_sse_proxy=NativeResponsesSSEProxy(transport=httpx.MockTransport(upstream)),
    )
    route = model_payload()
    route["model_info"].update(
        {
            "api_format": "openai_responses",
            "supports_native_streaming": True,
            "supports_responses_sse_passthrough": True,
        }
    )
    application._registry.create(route)
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application.app),
        base_url="http://gateway.test",
    )

    response = await client.post(
        "/v1/responses",
        headers=AUTH,
        json={
            "model": "agent-model",
            "stream": True,
            "input": [
                {
                    "type": "function_call",
                    "call_id": "call-1",
                    "name": "view_image",
                    "arguments": '{"path":"/tmp/shot.png"}',
                },
                {
                    "type": "function_call_output",
                    "call_id": "call-1",
                    "output": [{"type": "input_image", "image_url": "data:image/png;base64,AAAA"}],
                },
            ],
        },
    )

    assert response.status_code == 200
    # The note names the file taken from the originating call, so the model can point
    # the user at the image the app rendered for it.
    assert captured["payload"]["input"][1] == {
        "type": "function_call_output",
        "call_id": "call-1",
        "output": ResponsesToolOutputNormalizer.IMAGE_NOTE.format(
            location=" (file: /tmp/shot.png)"
        ),
    }
    await client.aclose()


def test_responses_tool_output_normalizer_keeps_portable_results_untouched() -> None:
    """Only the list form is rewritten, and its text parts survive the flattening."""
    string_payload = {
        "input": [{"type": "function_call_output", "call_id": "call-1", "output": "done"}]
    }
    assert ResponsesToolOutputNormalizer.normalize(string_payload) is string_payload
    assert ResponsesToolOutputNormalizer.normalize({"input": "hello"}) == {"input": "hello"}

    mixed = ResponsesToolOutputNormalizer.normalize(
        {
            "input": [
                {
                    "type": "function_call_output",
                    "call_id": "call-1",
                    "output": [
                        {"type": "input_text", "text": "attached local image path: /tmp/shot.png"},
                        {"type": "input_image", "image_url": "data:image/png;base64,AAAA"},
                    ],
                },
                {"type": "message", "role": "user", "content": "next"},
            ]
        }
    )

    # No `function_call` accompanies this result, so the note simply omits the file.
    assert mixed["input"][0]["output"] == (
        "attached local image path: /tmp/shot.png\n"
        + ResponsesToolOutputNormalizer.IMAGE_NOTE.format(location="")
    )
    # Items that are not tool results stay exactly as the agent sent them.
    assert mixed["input"][1] == {"type": "message", "role": "user", "content": "next"}
    assert (
        ResponsesToolOutputNormalizer.normalize(
            {"input": [{"type": "function_call_output", "call_id": "call-1", "output": []}]}
        )["input"][0]["output"]
        == ResponsesToolOutputNormalizer.EMPTY_NOTE
    )


def test_responses_sse_classifier_maps_output_item_tool_calls() -> None:
    """Tool-call item creation is exposed as a dedicated first-tool milestone."""
    from amis_gateway.streaming import ResponsesSSEEventClassifier

    classifier = ResponsesSSEEventClassifier()
    events = classifier.consume(
        b'data: {"type":"response.output_item.added","item":{"type":"function_call"}}\n\n'
    )

    assert events == ["response.function_call.added"]
    assert events[0] in ResponsesSSEEventClassifier.TOOL_TYPES


async def test_disconnect_during_open_cancels_upstream_request() -> None:
    """An interrupt while waiting for provider headers aborts the upstream call."""
    upstream_started = asyncio.Event()
    upstream_cancelled = asyncio.Event()

    async def upstream(_: httpx.Request) -> httpx.Response:
        upstream_started.set()
        try:
            await asyncio.sleep(30)  # Provider that never returns headers.
        except asyncio.CancelledError:
            upstream_cancelled.set()
            raise
        return httpx.Response(200)

    from amis_gateway.streaming import NativeResponsesSSEProxy

    application = AmisGatewayApplication(
        responses_sse_proxy=NativeResponsesSSEProxy(transport=httpx.MockTransport(upstream)),
    )
    route = model_payload()
    route["model_info"]["api_format"] = "openai_responses"
    route["model_info"]["supports_native_streaming"] = True
    route["model_info"]["supports_responses_sse_passthrough"] = True
    application._registry.create(route)

    class DisconnectingRequest:
        """Minimal Request double whose receive() reports a dropped connection."""

        def __init__(self) -> None:
            self.receive_calls = 0

        async def receive(self) -> dict[str, Any]:
            self.receive_calls += 1
            await upstream_started.wait()
            # uvicorn keeps re-delivering this once the socket is gone.
            return {"type": "http.disconnect"}

    request = DisconnectingRequest()
    with pytest.raises(ClientDisconnected):
        await application._await_unless_disconnected(
            request,
            application._responses_sse_proxy.open(
                payload={"model": "agent-model", "input": "hello", "stream": True},
                route=application._registry.resolve("agent-model"),
                forwarded_headers={},
                target=UpstreamTarget(api_base="https://provider.example/v1"),
            ),
            description="opening the provider Responses stream",
        )

    await asyncio.wait_for(upstream_cancelled.wait(), timeout=1)
    assert request.receive_calls == 1


# MARK: - Explicit cancellation
#
# Direct chat points Codex at this gateway, so no socket the app holds carries the
# request and `turn/interrupt` is the app's only lever over Codex. These tests
# cover the lever that bypasses Codex: naming the injected cancellation id drops
# only that provider connection, which is what makes a local runtime stop working.


def passthrough_route_payload() -> dict[str, Any]:
    """Build a route whose durable markers enable raw Responses passthrough."""
    route = model_payload()
    route["model_info"]["api_format"] = "openai_responses"
    route["model_info"]["supports_native_streaming"] = True
    route["model_info"]["supports_responses_sse_passthrough"] = True
    return route


async def test_explicit_cancel_closes_the_provider_connection_mid_stream() -> None:
    """A cancel mid-generation ends the response and releases the provider."""
    upstream_stream = ControlledSSEStream()
    cancellation_id = "codex-thread-mid-stream"

    async def upstream(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            stream=upstream_stream,
        )

    from amis_gateway.streaming import NativeResponsesSSEProxy

    proxy = NativeResponsesSSEProxy(transport=httpx.MockTransport(upstream))
    application = AmisGatewayApplication(
        responses_sse_proxy=proxy,
    )
    resolved = application._registry.create(passthrough_route_payload())
    exchange = application._cancellations.register(
        route_name=resolved.model_name,
        cancellation_id=cancellation_id,
    )
    session = await proxy.open(
        payload={"model": resolved.model_name, "input": "hello", "stream": True},
        route=resolved,
        forwarded_headers={},
        target=UpstreamTarget(api_base="https://provider.example/v1"),
    )
    await exchange.adopt(session)
    chunks = application._passthrough_stream(session, exchange=exchange)

    assert b"reasoning_text.delta" in await anext(chunks)
    # The provider is now mid-generation and the exchange is tracked.
    assert application._cancellations.in_flight_count == 1

    aborted = await application._cancellations.abort(
        cancellation_id=cancellation_id,
        reason="user pressed Stop",
    )
    assert aborted == 1

    # Closing the provider connection unblocks the read this stream was parked
    # on, and the response ends instead of waiting for a terminal event.
    remaining = [chunk async for chunk in chunks]

    assert b"response.completed" not in b"".join(remaining)
    assert upstream_stream.was_closed is True
    assert application._cancellations.in_flight_count == 0


async def test_explicit_cancel_during_prompt_processing_aborts_the_upstream_call() -> None:
    """The busiest phase -- no headers yet -- is the one a Stop must reach."""
    upstream_started = asyncio.Event()
    upstream_cancelled = asyncio.Event()
    cancellation_id = "codex-thread-prefill"

    async def upstream(_: httpx.Request) -> httpx.Response:
        upstream_started.set()
        try:
            await asyncio.sleep(30)  # A runtime still processing the prompt.
        except asyncio.CancelledError:
            upstream_cancelled.set()
            raise
        return httpx.Response(200)

    from amis_gateway.streaming import NativeResponsesSSEProxy

    application = AmisGatewayApplication(
        responses_sse_proxy=NativeResponsesSSEProxy(transport=httpx.MockTransport(upstream)),
    )
    resolved = application._registry.create(passthrough_route_payload())

    class SilentRequest:
        """Request double whose client never disconnects, unlike an interrupt."""

        async def receive(self) -> dict[str, Any]:
            await asyncio.Event().wait()
            raise AssertionError("unreachable")

    exchange = application._cancellations.register(
        route_name=resolved.model_name,
        cancellation_id=cancellation_id,
    )
    waiting = asyncio.ensure_future(
        application._await_unless_disconnected(
            SilentRequest(),
            application._responses_sse_proxy.open(
                payload={"model": resolved.model_name, "input": "hello", "stream": True},
                route=resolved,
                forwarded_headers={},
                target=UpstreamTarget(api_base="https://provider.example/v1"),
            ),
            description="opening the provider Responses stream",
            exchange=exchange,
        )
    )
    await asyncio.wait_for(upstream_started.wait(), timeout=1)

    assert await application._cancellations.abort(
        cancellation_id=cancellation_id,
        reason="Stop",
    ) == 1

    with pytest.raises(UpstreamAborted):
        await asyncio.wait_for(waiting, timeout=1)
    await asyncio.wait_for(upstream_cancelled.wait(), timeout=1)


async def test_cancel_endpoint_is_idempotent_and_validated() -> None:
    """A Stop for a finished turn is success; a malformed one is not."""
    application = AmisGatewayApplication()
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application.app),
        base_url="http://gateway",
    )

    # Nothing in flight: the requested state already holds.
    nothing = await client.post(
        "/_amis/cancel",
        headers=AUTH,
        json={"thread_id": "already-finished"},
    )
    assert nothing.status_code == 200
    assert nothing.json()["aborted"] == 0

    unknown = await client.post(
        "/_amis/cancel",
        headers=AUTH,
        json={"thread_id": "never-registered"},
    )
    assert unknown.status_code == 200
    assert unknown.json()["aborted"] == 0

    # No credential is required by the loopback gateway itself.
    unauthenticated = await client.post("/_amis/cancel", json={"thread_id": "never-registered"})
    assert unauthenticated.status_code == 200

    invalid = await client.post("/_amis/cancel", headers=AUTH, json={"thread_id": ""})
    assert invalid.status_code == 400

    await client.aclose()


async def test_explicit_cancel_does_not_abort_sibling_session_on_same_model() -> None:
    """Cancellation ids isolate concurrent Codex sessions sharing one model route."""
    application = AmisGatewayApplication()
    first = application._cancellations.register(
        route_name="shared-model",
        cancellation_id="codex-thread-one",
    )
    second = application._cancellations.register(
        route_name="shared-model",
        cancellation_id="codex-thread-two",
    )

    aborted = await application._cancellations.abort(
        cancellation_id="codex-thread-one",
        reason="user pressed Stop",
    )

    assert aborted == 1
    assert first.aborted is True
    assert second.aborted is False
    first.release()
    second.release()


async def test_cancel_before_inference_prevents_late_provider_start() -> None:
    """A Stop that beats Codex to the Gateway remains authoritative for that id."""
    application = AmisGatewayApplication()

    aborted = await application._cancellations.abort(
        cancellation_id="codex-thread-racing-start",
        reason="user pressed Stop",
    )
    exchange = application._cancellations.register(
        route_name="shared-model",
        cancellation_id="codex-thread-racing-start",
    )

    assert aborted == 0
    assert exchange.aborted is True
    exchange.release()

    next_turn = application._cancellations.register(
        route_name="shared-model",
        cancellation_id="codex-thread-racing-start",
    )
    assert next_turn.aborted is False
    next_turn.release()


async def test_cancelled_exchange_does_not_poison_next_turn_reusing_thread_header() -> None:
    """A resumed Codex thread may retain its provider header across later turns."""
    application = AmisGatewayApplication()
    cancellation_id = "resumed-codex-thread"
    stopped = application._cancellations.register(
        route_name="shared-model",
        cancellation_id=cancellation_id,
    )

    assert await application._cancellations.abort(
        cancellation_id=cancellation_id,
        reason="user pressed Stop",
    ) == 1
    stopped.release()

    next_turn = application._cancellations.register(
        route_name="shared-model",
        cancellation_id=cancellation_id,
    )

    assert next_turn.aborted is False
    next_turn.release()
