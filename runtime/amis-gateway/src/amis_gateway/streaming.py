"""Native OpenAI Responses streaming without LiteLLM fake-stream buffering."""

from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from time import monotonic
from typing import Any
from urllib.parse import urlsplit

import httpx

from .registry import ModelRoute


LOGGER = logging.getLogger(__name__)
JSONMapping = dict[str, Any]
MetricSink = Callable[["GatewayStreamingMetric"], None]


@dataclass(frozen=True, slots=True)
class GatewayStreamingMetric:
    """One privacy-safe upstream streaming milestone measured from request start."""

    name: str
    elapsed_milliseconds: int
    event_type: str | None = None
    byte_count: int | None = None


@dataclass(slots=True)
class GatewayStreamingMetrics:
    """Record first-occurrence streaming milestones and emit structured logs."""

    route_name: str
    sink: MetricSink | None = None
    _started_at: float = field(default_factory=monotonic)
    _recorded_names: set[str] = field(default_factory=set)

    def record(
        self,
        name: str,
        *,
        event_type: str | None = None,
        byte_count: int | None = None,
        once: bool = True,
    ) -> None:
        """Emit one milestone without exposing prompts, credentials, or output text."""
        if once and name in self._recorded_names:
            return
        self._recorded_names.add(name)
        metric = GatewayStreamingMetric(
            name=name,
            elapsed_milliseconds=max(0, round((monotonic() - self._started_at) * 1000)),
            event_type=event_type,
            byte_count=byte_count,
        )
        LOGGER.info(
            "Gateway streaming metric %s",
            json.dumps(
                {
                    "route": self.route_name,
                    "name": metric.name,
                    "elapsed_ms": metric.elapsed_milliseconds,
                    "event_type": metric.event_type,
                    "byte_count": metric.byte_count,
                },
                separators=(",", ":"),
            ),
        )
        if self.sink is not None:
            self.sink(metric)


@dataclass(frozen=True, slots=True)
class LocalEndpointPolicy:
    """Classify a provider endpoint as a machine-local one or a public API.

    Two decisions depend on this and must never disagree: a local endpoint is
    never reached through a user-configured desktop proxy, and it is never sent
    a credential, because the model server answering it belongs to this machine.
    """

    def is_local(self, url: str) -> bool:
        """Return whether the URL names a loopback, private, or `.local` host."""
        hostname = urlsplit(url).hostname
        if hostname is None:
            # URL validation remains HTTPX's responsibility. An unclassifiable
            # host is conservatively treated as public: it keeps the default
            # proxy behavior and never drops a credential the provider needs.
            return False

        normalized_hostname = hostname.rstrip(".").lower()
        if normalized_hostname == "localhost" or normalized_hostname.endswith(
            (".localhost", ".local")
        ):
            return True

        try:
            # IPv6 link-local URLs may include a zone identifier such as %en0.
            address = ipaddress.ip_address(normalized_hostname.split("%", maxsplit=1)[0])
        except ValueError:
            # A public provider hostname.
            return False

        # Loopback, private, link-local, reserved, and otherwise non-global
        # addresses all identify a model server reachable without leaving the
        # user's own network.
        return not address.is_global


@dataclass(frozen=True, slots=True)
class UpstreamProxyPolicy:
    """Keep local model traffic direct while honoring proxies for public APIs."""

    endpoints: LocalEndpointPolicy = LocalEndpointPolicy()

    def should_trust_environment(self, url: str) -> bool:
        """Return whether HTTPX may use proxy settings inherited from the app."""
        return not self.endpoints.is_local(url)


@dataclass(frozen=True, slots=True)
class StreamingRetryPolicy:
    """Bound retries to failures that occur before upstream response headers."""

    maximum_attempts: int = 3
    base_delay_seconds: float = 0.1
    maximum_delay_seconds: float = 1.0

    def delay(self, attempt: int) -> float:
        """Return deterministic exponential backoff for a completed attempt."""
        return min(self.maximum_delay_seconds, self.base_delay_seconds * (2 ** (attempt - 1)))


class NativeResponsesProxyError(RuntimeError):
    """Expose an upstream HTTP status without leaking credentials."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code


class ResponsesSSEEventClassifier:
    """Classify complete SSE events while tolerating arbitrary byte fragmentation."""

    TERMINAL_TYPES = frozenset(
        {
            "response.completed",
            "response.failed",
            "response.incomplete",
            "response.cancelled",
        }
    )
    REASONING_TYPES = frozenset(
        {
            "response.reasoning_text.delta",
            "response.reasoning_summary_text.delta",
            "response.reasoning_summary_part.added",
        }
    )
    TOOL_TYPES = frozenset(
        {
            "response.function_call_arguments.delta",
            "response.function_call_arguments.done",
            "response.function_call.added",
        }
    )

    def __init__(self) -> None:
        self._buffer = bytearray()

    def consume(self, chunk: bytes) -> list[str]:
        """Return event types from every newly completed SSE event in order."""
        self._buffer.extend(chunk)
        normalized = bytes(self._buffer).replace(b"\r\n", b"\n")
        events: list[str] = []
        consumed_normalized = 0
        while True:
            boundary = normalized.find(b"\n\n", consumed_normalized)
            if boundary < 0:
                break
            frame = normalized[consumed_normalized:boundary]
            consumed_normalized = boundary + 2
            event_type = self._event_type(frame)
            if event_type is not None:
                events.append(event_type)
        if consumed_normalized:
            # Reconstructing the unconsumed normalized suffix is safe because SSE
            # treats CRLF and LF identically, and prevents unbounded buffering.
            self._buffer = bytearray(normalized[consumed_normalized:])
        return events

    @classmethod
    def is_tool_event(cls, event_type: str, frame_value: JSONMapping | None = None) -> bool:
        """Recognize direct argument deltas and output-item function calls."""
        if event_type in cls.TOOL_TYPES:
            return True
        return (
            event_type == "response.output_item.added"
            and isinstance(frame_value, dict)
            and isinstance(frame_value.get("item"), dict)
            and frame_value["item"].get("type") in {"function_call", "custom_tool_call"}
        )

    @staticmethod
    def _event_type(frame: bytes) -> str | None:
        for line in frame.split(b"\n"):
            if not line.startswith(b"data:"):
                continue
            payload = line[5:].lstrip()
            if payload == b"[DONE]":
                return "[DONE]"
            try:
                value = json.loads(payload)
            except (json.JSONDecodeError, UnicodeDecodeError):
                return None
            if isinstance(value, dict) and isinstance(value.get("type"), str):
                event_type = value["type"]
                if ResponsesSSEEventClassifier.is_tool_event(event_type, value):
                    return (
                        "response.function_call.added"
                        if event_type == "response.output_item.added"
                        else event_type
                    )
                return event_type
        return None


class NativeResponsesSSESession:
    """Own an open httpx response until downstream consumption or cancellation."""

    def __init__(
        self,
        *,
        client: httpx.AsyncClient,
        response: httpx.Response,
        metrics: GatewayStreamingMetrics,
    ) -> None:
        self.client = client
        self.response = response
        self.metrics = metrics
        self.classifier = ResponsesSSEEventClassifier()
        self._received_byte_count = 0
        self._sent_byte_count = 0
        # Distinguishes "upstream finished the response" from "the client walked
        # away mid-stream", which is what a Codex turn/interrupt looks like here.
        self._saw_terminal_event = False
        # Set by an explicit cancel, so the read failure it causes is reported as
        # the requested stop rather than as a provider error.
        self._abort_reason = ""

    async def iter_bytes(self) -> AsyncIterator[bytes]:
        """Forward raw SSE bytes immediately and close upstream in every exit path."""
        try:
            async for chunk in self.response.aiter_raw():
                # Closing a custom or buffered transport can unblock its iterator
                # with one final queued chunk instead of raising. Once Stop wins,
                # no additional provider bytes belong to the abandoned response.
                if self._abort_reason:
                    self.metrics.record("downstream.aborted")
                    return
                if not chunk:
                    continue
                self._received_byte_count += len(chunk)
                # Keep the streaming hot path bounded: record the first byte
                # arrival once instead of logging every provider transport chunk.
                self.metrics.record(
                    "upstream.first_bytes_received",
                    byte_count=self._received_byte_count,
                )
                for event_type in self.classifier.consume(chunk):
                    self.metrics.record(
                        "upstream.first_sse_event",
                        event_type=event_type,
                        byte_count=self._received_byte_count,
                    )
                    if event_type in ResponsesSSEEventClassifier.REASONING_TYPES:
                        self.metrics.record("upstream.first_reasoning_delta", event_type=event_type)
                    if event_type in ResponsesSSEEventClassifier.TOOL_TYPES:
                        self.metrics.record("upstream.first_tool_call_delta", event_type=event_type)
                    if event_type == "response.output_text.delta":
                        self.metrics.record("upstream.first_output_text_delta", event_type=event_type)
                    if event_type in ResponsesSSEEventClassifier.TERMINAL_TYPES:
                        self._saw_terminal_event = True
                        self.metrics.record("upstream.terminal_event", event_type=event_type)
                yield chunk
                # Generator resumption means Starlette consumed the previous
                # chunk, so this cumulative count approximates downstream flush.
                self._sent_byte_count += len(chunk)
                self.metrics.record(
                    "downstream.first_sse_bytes_sent",
                    byte_count=self._sent_byte_count,
                )
        # Starlette can surface downstream closure as either cancellation shape.
        except (asyncio.CancelledError, GeneratorExit):
            self.metrics.record("downstream.cancelled")
            raise
        except Exception:
            # An explicit cancel closes the provider connection underneath this
            # read, so the failure it raises is the requested stop, not a fault.
            # Ending the generator instead of raising lets the response finish
            # normally for a client that is no longer reading it anyway.
            if self._abort_reason:
                self.metrics.record("downstream.aborted")
                return
            self.metrics.record("upstream.stream_failed")
            LOGGER.exception("Native Responses SSE passthrough failed for route %s", self.metrics.route_name)
            raise
        finally:
            await self._close_upstream()
            self.metrics.record("request.completed")

    async def abort(self, reason: str) -> None:
        """Drop the provider connection now, from outside the reading task.

        Closing the response is what releases the model runtime, and it unblocks
        the read in flight even when the provider has gone quiet -- which is the
        whole point, since a stalled read is what a long prompt looks like here.
        """
        if self._abort_reason:
            return
        self._abort_reason = reason
        await self._close_upstream()

    async def _close_upstream(self) -> None:
        """Release the provider socket without masking the exception being unwound.

        This runs inside `finally`, so an httpx failure raised here would replace
        the original cancellation or stream error. Each close is therefore
        isolated and reported instead of propagated or silently dropped.
        """
        for name, close in (("response", self.response.aclose), ("client", self.client.aclose)):
            try:
                await close()
            except Exception:
                LOGGER.exception(
                    "Failed to close upstream %s for route %s after stream teardown",
                    name,
                    self.metrics.route_name,
                )


class NativeResponsesSSEProxy:
    """Open a provider-native Responses stream for explicitly capable routes."""

    _FORWARDED_RESPONSE_HEADERS = frozenset(
        {
            "content-type",
            "openai-processing-ms",
            "x-request-id",
            "request-id",
        }
    )

    def __init__(
        self,
        *,
        timeout: httpx.Timeout | None = None,
        retry_policy: StreamingRetryPolicy = StreamingRetryPolicy(),
        transport: httpx.AsyncBaseTransport | None = None,
        metric_sink: MetricSink | None = None,
        proxy_policy: UpstreamProxyPolicy = UpstreamProxyPolicy(),
    ) -> None:
        # No read deadline: a provider that goes quiet for minutes is what a long
        # reasoning or tool-using turn looks like from here, and a read timeout
        # mid-stream kills the response with no retry. The turn is still bounded
        # from both ends -- the Adapter owns the execution deadline and a client
        # disconnect cancels this task -- so the gateway must not race them.
        # Connect stays bounded because an unreachable provider is a real fault.
        self._timeout = timeout or httpx.Timeout(None, connect=10.0)
        self._retry_policy = retry_policy
        self._transport = transport
        self._metric_sink = metric_sink
        self._proxy_policy = proxy_policy

    async def open(
        self,
        *,
        payload: JSONMapping,
        route: ModelRoute,
        forwarded_headers: JSONMapping,
        credential: str | None = None,
    ) -> NativeResponsesSSESession:
        """Return after upstream headers, never after the complete model response."""
        metrics = GatewayStreamingMetrics(route_name=route.model_name, sink=self._metric_sink)
        metrics.record("request.received")
        url = self._responses_url(route)
        upstream_payload = dict(payload)
        upstream_payload["model"] = self._provider_model_name(route)
        upstream_payload["stream"] = True
        headers = {
            "Accept": "text/event-stream",
            "Content-Type": "application/json",
            **{str(key): str(value) for key, value in forwarded_headers.items()},
        }
        # A local model server is called with no Authorization header at all;
        # the caller decides that by passing no credential.
        if credential:
            headers["Authorization"] = f"Bearer {credential}"

        attempt = 1
        while True:
            client = httpx.AsyncClient(
                timeout=self._timeout,
                transport=self._transport,
                trust_env=self._proxy_policy.should_trust_environment(url),
            )
            request = client.build_request("POST", url, headers=headers, json=upstream_payload)
            metrics.record("upstream.request_started")
            try:
                response = await client.send(request, stream=True)
                metrics.record("upstream.response_headers_received")
                if response.status_code >= 400:
                    body = (await response.aread()).decode("utf-8", errors="replace")
                    await response.aclose()
                    await client.aclose()
                    raise NativeResponsesProxyError(
                        response.status_code,
                        body or f"upstream returned HTTP {response.status_code}",
                    )
                return NativeResponsesSSESession(client=client, response=response, metrics=metrics)
            except NativeResponsesProxyError:
                raise
            except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout) as error:
                await client.aclose()
                if attempt >= self._retry_policy.maximum_attempts:
                    raise NativeResponsesProxyError(502, f"upstream streaming connection failed: {error}") from error
                metrics.record("upstream.retry_scheduled", once=False)
                await asyncio.sleep(self._retry_policy.delay(attempt))
                attempt += 1
            # BaseException, not Exception: a client disconnect cancels this task,
            # and CancelledError must still release the upstream connection.
            except BaseException:
                await client.aclose()
                raise

    def response_headers(self, session: NativeResponsesSSESession) -> dict[str, str]:
        """Forward only safe response metadata; framing is owned by Starlette."""
        return {
            name: value
            for name, value in session.response.headers.items()
            if name.lower() in self._FORWARDED_RESPONSE_HEADERS
        }

    @staticmethod
    def _provider_model_name(route: ModelRoute) -> str:
        model = str(route.litellm_params["model"])
        return model.split("/", maxsplit=1)[1] if model.startswith("openai/") else model

    @staticmethod
    def _responses_url(route: ModelRoute) -> str:
        api_base = route.litellm_params.get("api_base")
        if not isinstance(api_base, str) or not api_base.strip():
            raise ValueError("native Responses SSE passthrough requires litellm_params.api_base")
        base = api_base.rstrip("/")
        if base.endswith("/responses"):
            return base
        return f"{base}/responses"
