"""Thread-safe in-memory model route registry owned by the Tokkey gateway."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from threading import RLock
from typing import Any, Iterable
from uuid import uuid4


class RouteConflictError(ValueError):
    """Raised when a model name or model id would become ambiguous."""


@dataclass(frozen=True, slots=True)
class ModelStreamingCapabilities:
    """Explicit route capabilities; unknown LiteLLM model names are never guessed."""

    supports_native_streaming: bool = False
    supports_responses_sse_passthrough: bool = False

    @classmethod
    def from_model_info(cls, model_info: dict[str, Any]) -> "ModelStreamingCapabilities":
        """Decode capabilities supplied by the host application's model materializer."""
        return cls(
            supports_native_streaming=model_info.get("supports_native_streaming") is True,
            supports_responses_sse_passthrough=(
                model_info.get("supports_responses_sse_passthrough") is True
            ),
        )


@dataclass(frozen=True, slots=True)
class ModelRoute:
    """One agent-facing model alias and its LiteLLM SDK call parameters."""

    model_id: str
    model_name: str
    litellm_params: dict[str, Any]
    model_info: dict[str, Any]
    streaming_capabilities: ModelStreamingCapabilities

    @classmethod
    def from_management_payload(
        cls,
        payload: dict[str, Any],
        *,
        model_id: str | None = None,
    ) -> "ModelRoute":
        """Validate and normalize the model-management payload used by Swift."""
        model_name = payload.get("model_name")
        params = payload.get("litellm_params")
        info = payload.get("model_info", {})
        if not isinstance(model_name, str) or not model_name.strip():
            raise ValueError("model_name must be a non-empty string")
        if not isinstance(params, dict):
            raise ValueError("litellm_params must be an object")
        actual_model = params.get("model")
        if not isinstance(actual_model, str) or not actual_model.strip():
            raise ValueError("litellm_params.model must be a non-empty string")
        if not isinstance(info, dict):
            raise ValueError("model_info must be an object")
        resolved_id = model_id or info.get("id") or str(uuid4())
        if not isinstance(resolved_id, str) or not resolved_id.strip():
            raise ValueError("model id must be a non-empty string")
        normalized_info = deepcopy(info)
        normalized_info["id"] = resolved_id
        return cls(
            model_id=resolved_id,
            model_name=model_name,
            litellm_params=deepcopy(params),
            model_info=normalized_info,
            streaming_capabilities=ModelStreamingCapabilities.from_model_info(normalized_info),
        )

    def management_payload(self) -> dict[str, Any]:
        """Return the LiteLLM-compatible representation consumed by Swift."""
        return {
            "model_name": self.model_name,
            "litellm_params": deepcopy(self.litellm_params),
            "model_info": deepcopy(self.model_info),
        }


class ModelRouteRegistry:
    """Own model CRUD and atomic full-snapshot replacement in one lock."""

    def __init__(self) -> None:
        self._lock = RLock()
        self._routes_by_id: dict[str, ModelRoute] = {}
        self._ids_by_name: dict[str, str] = {}

    def create(self, payload: dict[str, Any]) -> ModelRoute:
        """Insert one route, rejecting duplicate aliases and ids."""
        route = ModelRoute.from_management_payload(payload)
        with self._lock:
            self._validate_unique(route, self._routes_by_id, self._ids_by_name)
            self._routes_by_id[route.model_id] = route
            self._ids_by_name[route.model_name] = route.model_id
        return route

    def update(self, model_id: str, litellm_params: dict[str, Any]) -> ModelRoute:
        """Replace call parameters while preserving alias, marker, and id."""
        with self._lock:
            existing = self._routes_by_id.get(model_id)
            if existing is None:
                raise KeyError(model_id)
            payload = existing.management_payload()
            payload["litellm_params"] = litellm_params
            updated = ModelRoute.from_management_payload(payload, model_id=model_id)
            self._routes_by_id[model_id] = updated
            return updated

    def delete(self, model_id: str) -> bool:
        """Delete one route idempotently and report whether it existed."""
        with self._lock:
            route = self._routes_by_id.pop(model_id, None)
            if route is None:
                return False
            self._ids_by_name.pop(route.model_name, None)
            return True

    def resolve(self, model_name: str) -> ModelRoute:
        """Resolve an agent-facing alias into an immutable route snapshot."""
        with self._lock:
            model_id = self._ids_by_name.get(model_name)
            if model_id is None:
                raise KeyError(model_name)
            return self._routes_by_id[model_id]

    def list(self) -> list[ModelRoute]:
        """Return a stable alias-sorted snapshot for management diagnostics."""
        with self._lock:
            return sorted(self._routes_by_id.values(), key=lambda route: route.model_name)

    def replace(self, payloads: Iterable[dict[str, Any]]) -> list[ModelRoute]:
        """Validate a complete snapshot before atomically making it visible."""
        routes: dict[str, ModelRoute] = {}
        ids_by_name: dict[str, str] = {}
        for payload in payloads:
            if not isinstance(payload, dict):
                raise ValueError("every model snapshot entry must be an object")
            model_id = payload.get("model_id")
            route_payload = payload.get("model")
            if not isinstance(route_payload, dict):
                raise ValueError("model snapshot entry must contain a model object")
            route = ModelRoute.from_management_payload(route_payload, model_id=model_id)
            self._validate_unique(route, routes, ids_by_name)
            routes[route.model_id] = route
            ids_by_name[route.model_name] = route.model_id
        with self._lock:
            self._routes_by_id = routes
            self._ids_by_name = ids_by_name
        return sorted(routes.values(), key=lambda route: route.model_name)

    @staticmethod
    def _validate_unique(
        route: ModelRoute,
        routes: dict[str, ModelRoute],
        ids_by_name: dict[str, str],
    ) -> None:
        """Keep both indexes one-to-one so routing never becomes ambiguous."""
        if route.model_id in routes:
            raise RouteConflictError(f"model id '{route.model_id}' already exists")
        if route.model_name in ids_by_name:
            raise RouteConflictError(f"model_name '{route.model_name}' already exists")

