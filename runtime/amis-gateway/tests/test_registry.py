"""Unit tests for atomic route ownership and conflict handling."""

from amis_gateway.registry import ModelRouteRegistry, RouteConflictError


def model_payload(name: str = "agent-model", model: str = "openai/upstream") -> dict:
    """Build one complete management payload used across registry tests."""
    return {
        "model_name": name,
        "litellm_params": {"model": model, "api_key": "secret"},
        "model_info": {"created_by": "tokiie", "profile_id": "profile"},
    }


def test_replace_is_atomic_when_new_snapshot_is_invalid() -> None:
    """An invalid replacement must leave the last known-good registry visible."""
    registry = ModelRouteRegistry()
    original = registry.create(model_payload())

    try:
        registry.replace([
            {"model_id": "one", "model": model_payload("duplicate")},
            {"model_id": "two", "model": model_payload("duplicate")},
        ])
    except RouteConflictError:
        pass
    else:
        raise AssertionError("expected duplicate model_name to fail")

    assert registry.resolve("agent-model") == original


def test_snapshot_preserves_swift_owned_model_id() -> None:
    """A restored route keeps the id the host application persisted for it."""
    registry = ModelRouteRegistry()
    routes = registry.replace([{"model_id": "durable-id", "model": model_payload()}])

    assert routes[0].model_id == "durable-id"
    assert routes[0].model_info["id"] == "durable-id"



def test_explicit_native_streaming_capabilities_are_preserved() -> None:
    """A custom model can opt into native Responses SSE without name mapping."""
    registry = ModelRouteRegistry()
    payload = model_payload(model="openai/Qwen3.5-35B-A3B-Q4_K_M.gguf")
    payload["model_info"].update(
        {
            "supports_native_streaming": True,
            "supports_responses_sse_passthrough": True,
        }
    )

    route = registry.create(payload)

    assert route.streaming_capabilities.supports_native_streaming is True
    assert route.streaming_capabilities.supports_responses_sse_passthrough is True
    assert route.management_payload()["model_info"]["supports_native_streaming"] is True
