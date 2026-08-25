"""Explicit cancellation of one upstream exchange identified by its caller.

Closing the socket is what actually stops a model: llama-server abandons the
work it is doing for a caller that has gone away, whether it is still processing
the prompt or already emitting tokens. Everywhere the app owns that socket it
simply closes it and needs nothing from this module.

Direct chat is the case where it does not. Codex is configured to call this
gateway itself, so Tokiie injects an opaque cancellation id into the provider
request and later sends the same id to `POST /_amis/cancel`. The registry closes
only the exchange carrying that id, never sibling sessions using the same model.

The gateway's existing client-disconnect handling stays as it is. Whichever
signal arrives first ends the exchange, and the other finds nothing to end.
"""

from __future__ import annotations

import asyncio
from collections import deque
import logging
from typing import TYPE_CHECKING


if TYPE_CHECKING:  # Imported for typing only; streaming.py imports this module.
    from .streaming import NativeResponsesSSESession


LOGGER = logging.getLogger(__name__)


class UpstreamAborted(Exception):
    """Raised when an explicit cancel ended an exchange still waiting on a provider."""

    def __init__(self, route_name: str, reason: str) -> None:
        super().__init__(f"upstream exchange on route {route_name} was cancelled: {reason}")
        self.route_name = route_name
        self.reason = reason


class UpstreamExchange:
    """One in-flight gateway-to-provider exchange that an explicit cancel can end.

    An exchange covers both phases of a request, because a turn stopped while the
    prompt is still being processed is exactly the case worth stopping: no
    response headers exist yet, and the runtime is at its busiest. Before headers
    arrive ``abort_event`` is what the request handler races its upstream call
    against; afterwards the attached session is closed directly.
    """

    def __init__(
        self,
        *,
        route_name: str,
        cancellation_id: str | None,
        registry: UpstreamExchangeRegistry,
    ) -> None:
        self.route_name = route_name
        self.cancellation_id = cancellation_id
        self._registry = registry
        self._abort_event = asyncio.Event()
        self._reason = ""
        self._session: NativeResponsesSSESession | None = None

    @property
    def abort_event(self) -> asyncio.Event:
        """Set once this exchange has been asked to stop."""
        return self._abort_event

    @property
    def aborted(self) -> bool:
        """Whether an explicit cancel has reached this exchange."""
        return self._abort_event.is_set()

    @property
    def reason(self) -> str:
        """Why the exchange was cancelled, for diagnostics only."""
        return self._reason

    async def abort(self, reason: str) -> None:
        """Stop this exchange in whichever phase it is currently in."""
        self.mark_aborted(reason)
        session = self._session
        if session is not None:
            await session.abort(reason)

    def mark_aborted(self, reason: str) -> None:
        """Record cancellation synchronously before provider work can start."""
        if not self._abort_event.is_set():
            self._reason = reason
            self._abort_event.set()

    async def adopt(self, session: NativeResponsesSSESession) -> None:
        """Hand the open provider stream to this exchange.

        A cancel can land in the moment between the provider returning headers
        and the response stream starting, so an already-aborted exchange closes
        the session it is given rather than letting it stream a response nobody
        is waiting for.
        """
        self._session = session
        if self.aborted:
            await session.abort(self._reason)

    def release(self) -> None:
        """Drop this exchange from the registry; safe to call more than once."""
        self._registry.release(self)


class UpstreamExchangeRegistry:
    """Tracks in-flight exchanges by the opaque id supplied by their caller.

    Entries live only as long as one exchange, so a cancel arriving after the
    turn finished on its own matches nothing and reports zero. Callers must treat
    that as success: the desired state -- no upstream work for that route -- is
    exactly what holds.
    """

    _REMEMBERED_CANCELLATION_COUNT = 1_024

    def __init__(self) -> None:
        self._exchanges: dict[str, list[UpstreamExchange]] = {}
        self._cancelled_ids: set[str] = set()
        self._cancelled_order: deque[str] = deque()

    def register(
        self,
        *,
        route_name: str,
        cancellation_id: str | None,
    ) -> UpstreamExchange:
        """Create one exchange and make an early-arriving Stop authoritative."""
        exchange = UpstreamExchange(
            route_name=route_name,
            cancellation_id=cancellation_id,
            registry=self,
        )
        if cancellation_id is not None:
            self._exchanges.setdefault(cancellation_id, []).append(exchange)
            if cancellation_id in self._cancelled_ids:
                # A tombstone protects only the request that raced behind Stop.
                # Codex can reuse one thread-level provider header on later turns,
                # so leaving it behind would permanently poison that session.
                self._forget_cancelled(cancellation_id)
                exchange.mark_aborted("cancelled before the provider request started")
        LOGGER.info(
            "Tracking in-flight exchange on route %s cancellation_id=%s (in_flight=%d)",
            route_name,
            cancellation_id or "<none>",
            self.in_flight_count,
        )
        return exchange

    def release(self, exchange: UpstreamExchange) -> None:
        """Stop tracking one finished exchange; releasing twice is harmless."""
        cancellation_id = exchange.cancellation_id
        if cancellation_id is None:
            return
        matches = self._exchanges.get(cancellation_id)
        if matches is None:
            return
        try:
            matches.remove(exchange)
        except ValueError:
            return
        if not matches:
            self._exchanges.pop(cancellation_id, None)
        LOGGER.info(
            "Released in-flight exchange on route %s cancellation_id=%s: "
            "aborted=%s (in_flight=%d)",
            exchange.route_name,
            cancellation_id,
            exchange.aborted,
            self.in_flight_count,
        )

    async def abort(self, *, cancellation_id: str, reason: str) -> int:
        """Abort only exchanges carrying one caller-generated cancellation id."""
        matched = list(self._exchanges.get(cancellation_id, []))
        if matched:
            # The request is already known and will be closed directly; no late
            # request tombstone is needed, and retaining one would block the next
            # turn when Codex reuses its thread-level provider configuration.
            self._forget_cancelled(cancellation_id)
        else:
            self._remember_cancelled(cancellation_id)
        for exchange in matched:
            await exchange.abort(reason)
        LOGGER.warning(
            "Explicit cancel for cancellation_id=%s (reason=%s): aborted=%d still_in_flight=%d",
            cancellation_id,
            reason,
            len(matched),
            self.in_flight_count,
        )
        return len(matched)

    def _remember_cancelled(self, cancellation_id: str) -> None:
        """Bound early-cancel tombstones so a late Codex request cannot escape Stop."""
        if cancellation_id in self._cancelled_ids:
            return
        self._cancelled_ids.add(cancellation_id)
        self._cancelled_order.append(cancellation_id)
        while len(self._cancelled_order) > self._REMEMBERED_CANCELLATION_COUNT:
            expired = self._cancelled_order.popleft()
            self._cancelled_ids.discard(expired)

    def _forget_cancelled(self, cancellation_id: str) -> None:
        """Remove one consumed tombstone without disturbing cancellation order."""
        if cancellation_id not in self._cancelled_ids:
            return
        self._cancelled_ids.remove(cancellation_id)
        try:
            self._cancelled_order.remove(cancellation_id)
        except ValueError:
            pass

    @property
    def in_flight_count(self) -> int:
        """How many exchanges are currently tracked, for diagnostics and tests."""
        return sum(len(exchanges) for exchanges in self._exchanges.values())
