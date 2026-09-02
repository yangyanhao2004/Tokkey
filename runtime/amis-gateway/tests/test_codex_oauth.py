"""Tests for spending a ChatGPT login on the canonical Codex backend."""

from __future__ import annotations

import asyncio
import base64
import json
import time
from pathlib import Path
from typing import Any

import httpx
import pytest
from amis_gateway.app import AmisGatewayApplication
from amis_gateway.codex_oauth import (
    CanonicalCodexEndpoint,
    ChatGPTTokenRefresher,
    CodexAuthFile,
    CodexOAuthCredentialProvider,
    CodexNativeRoute,
    CodexOAuthUnavailable,
    OpenAiApiEndpoint,
    OpenAiApiKey,
)
from amis_gateway.credentials import UpstreamTargetPolicy
from amis_gateway.streaming import NativeResponsesSSEProxy

ACCOUNT_ID = "acct-chatgpt-123"
CALLER_KEY = "caller-supplied-key"
AUTH = {"Authorization": f"Bearer {CALLER_KEY}"}


def access_token(*, expires_in: float, account_id: str = ACCOUNT_ID) -> str:
    """Build an unsigned JWT carrying only the claims this gateway reads."""
    claims = {"exp": time.time() + expires_in, "chatgpt_account_id": account_id}
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"header.{payload}.signature"


def write_auth_file(path: Path, document: dict[str, Any]) -> CodexAuthFile:
    """Create one `auth.json` and the reader pointed at it."""
    path.write_text(json.dumps(document), encoding="utf-8")
    return CodexAuthFile(path)


def logged_in_document(*, expires_in: float = 3600.0) -> dict[str, Any]:
    """The document shape the Codex CLI writes after a ChatGPT login."""
    return {
        "auth_mode": "chatgpt",
        "OPENAI_API_KEY": None,
        "tokens": {
            "id_token": "id-token",
            "access_token": access_token(expires_in=expires_in),
            "refresh_token": "refresh-token-1",
            "account_id": ACCOUNT_ID,
        },
        "last_refresh": "2026-08-30T00:00:00Z",
    }


def codex_route(**overrides: Any) -> dict[str, Any]:
    """One route pointed at the canonical ChatGPT Codex backend, with no key."""
    params = {
        "model": "openai/gpt-5-codex",
        "api_base": CanonicalCodexEndpoint.BASE_URL,
        **overrides,
    }
    return {
        "model_name": "codex-model",
        "litellm_params": params,
        "model_info": {
            "created_by": "tokkey",
            "profile_id": "codex-profile",
            "api_format": "openai_responses",
            "supports_native_streaming": True,
            "supports_responses_sse_passthrough": True,
        },
    }


def application_with_auth_file(
    auth_file: CodexAuthFile,
    *,
    responses_call: Any = None,
    responses_sse_proxy: NativeResponsesSSEProxy | None = None,
    refresher: ChatGPTTokenRefresher | None = None,
) -> AmisGatewayApplication:
    """Build a gateway whose ChatGPT login comes from one test-owned file."""
    return AmisGatewayApplication(
        responses_call=responses_call or _unused_provider_call,
        responses_sse_proxy=responses_sse_proxy or NativeResponsesSSEProxy(),
        credential_policy=UpstreamTargetPolicy(
            codex_oauth=CodexOAuthCredentialProvider(auth_file, refresher),
        ),
    )


async def _unused_provider_call(**_: Any) -> Any:
    """Fail the test if a request reaches the provider without a credential."""
    raise AssertionError("the provider must not be called")


def gateway_client(application: AmisGatewayApplication) -> httpx.AsyncClient:
    """Address the gateway's ASGI app directly."""
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application.app),
        base_url="http://gateway.test",
    )


# --- The security boundary -------------------------------------------------


@pytest.mark.parametrize(
    "api_base",
    [
        "https://chatgpt.com/backend-api/codex",
        "https://chatgpt.com/backend-api/codex/",
        "https://CHATGPT.com/backend-api/codex",
    ],
)
def test_canonical_codex_endpoint_accepts_only_url_spellings_of_one_destination(
    api_base: str,
) -> None:
    """Trailing slashes and host casing name the same backend, so they match."""
    assert CanonicalCodexEndpoint.matches(api_base) is True


@pytest.mark.parametrize(
    "api_base",
    [
        "https://chatgpt.com.evil.test/backend-api/codex",
        "https://chatgpt.com/backend-api/codex/../../other",
        "http://chatgpt.com/backend-api/codex",
        "https://user:pass@chatgpt.com/backend-api/codex",
        "https://chatgpt.com/backend-api/codex?to=elsewhere",
        "https://chatgpt.com/backend-api/codex#elsewhere",
        "https://api.openai.com/v1",
        "",
        None,
    ],
)
def test_canonical_codex_endpoint_rejects_every_other_destination(api_base: Any) -> None:
    """A URL that is not exactly the ChatGPT backend never sees the token."""
    assert CanonicalCodexEndpoint.matches(api_base) is False


async def test_lookalike_host_gets_the_caller_key_and_never_the_chatgpt_login(
    tmp_path: Path,
) -> None:
    """The OAuth token is chosen by destination, so a near-miss host cannot get it."""
    auth_file = write_auth_file(tmp_path / "auth.json", logged_in_document())
    captured: dict[str, Any] = {}

    async def responses_call(**kwargs: Any) -> Any:
        captured.update(kwargs)
        return {"id": "resp"}

    application = application_with_auth_file(auth_file, responses_call=responses_call)
    application._registry.create(
        codex_route(api_base="https://chatgpt.com.evil.test/backend-api/codex")
    )
    client = gateway_client(application)

    response = await client.post(
        "/v1/responses",
        headers=AUTH,
        json={"model": "codex-model", "input": "hello"},
    )

    assert response.status_code == 200
    assert captured["api_key"] == CALLER_KEY
    assert "chatgpt-account-id" not in captured.get("extra_headers", {})
    await client.aclose()


async def test_canonical_route_ignores_the_caller_key_and_spends_the_chatgpt_login(
    tmp_path: Path,
) -> None:
    """A local agent's placeholder key must never travel to chatgpt.com."""
    document = logged_in_document()
    auth_file = write_auth_file(tmp_path / "auth.json", document)
    captured: dict[str, Any] = {}

    async def responses_call(**kwargs: Any) -> Any:
        captured.update(kwargs)
        return {"id": "resp"}

    application = application_with_auth_file(auth_file, responses_call=responses_call)
    application._registry.create(codex_route())
    client = gateway_client(application)

    response = await client.post(
        "/v1/responses",
        headers={**AUTH, "originator": "codex_cli_rs", "session_id": "session-1"},
        json={"model": "codex-model", "input": "hello"},
    )

    assert response.status_code == 200
    assert captured["api_key"] == document["tokens"]["access_token"]
    assert captured["extra_headers"]["chatgpt-account-id"] == ACCOUNT_ID
    # The ChatGPT backend reads its caller's identity headers, not just its token.
    assert captured["extra_headers"]["originator"] == "codex_cli_rs"
    assert captured["extra_headers"]["session_id"] == "session-1"
    await client.aclose()


async def test_codex_identity_headers_are_not_forwarded_to_other_providers(
    tmp_path: Path,
) -> None:
    """Only the backend that understands the Codex header set receives it."""
    auth_file = write_auth_file(tmp_path / "auth.json", logged_in_document())
    captured: dict[str, Any] = {}

    async def responses_call(**kwargs: Any) -> Any:
        captured.update(kwargs)
        return {"id": "resp"}

    application = application_with_auth_file(auth_file, responses_call=responses_call)
    application._registry.create(
        codex_route(api_base="https://provider.example/v1", api_key="stored-key")
    )
    client = gateway_client(application)

    response = await client.post(
        "/v1/responses",
        headers={**AUTH, "originator": "codex_cli_rs", "openai-beta": "responses=v1"},
        json={"model": "codex-model", "input": "hello"},
    )

    assert response.status_code == 200
    assert captured["extra_headers"] == {"openai-beta": "responses=v1"}
    await client.aclose()


# --- Failing before any upstream I/O ---------------------------------------


async def test_api_key_shaped_auth_file_is_diagnosed_instead_of_relayed(
    tmp_path: Path,
) -> None:
    """`{"OPENAI_API_KEY": ...}` is not a ChatGPT login and cannot be forwarded."""
    auth_file = write_auth_file(
        tmp_path / "auth.json",
        {"auth_mode": "apikey", "OPENAI_API_KEY": "sk-not-an-oauth-token"},
    )
    application = application_with_auth_file(auth_file)
    application._registry.create(codex_route())
    client = gateway_client(application)

    response = await client.post(
        "/v1/responses",
        headers=AUTH,
        json={"model": "codex-model", "input": "hello"},
    )

    assert response.status_code == 401
    message = response.json()["error"]["message"]
    assert "API key rather than a ChatGPT login" in message
    assert "codex login" in message
    await client.aclose()


async def test_missing_auth_file_is_reported_before_the_provider_is_called(
    tmp_path: Path,
) -> None:
    """A user who never ran `codex login` reads that, not an upstream 401."""
    application = application_with_auth_file(CodexAuthFile(tmp_path / "absent.json"))
    application._registry.create(codex_route())
    client = gateway_client(application)

    response = await client.post(
        "/v1/responses",
        headers=AUTH,
        json={"model": "codex-model", "input": "hello"},
    )

    assert response.status_code == 401
    assert "codex login" in response.json()["error"]["message"]
    await client.aclose()


async def test_expired_login_without_a_refresh_token_fails_with_a_usable_message(
    tmp_path: Path,
) -> None:
    """An unrenewable login is a login problem, so it is named as one."""
    document = logged_in_document(expires_in=-60.0)
    document["tokens"]["refresh_token"] = ""
    auth_file = write_auth_file(tmp_path / "auth.json", document)
    application = application_with_auth_file(auth_file)
    application._registry.create(codex_route())
    client = gateway_client(application)

    response = await client.post(
        "/v1/responses",
        headers=AUTH,
        json={"model": "codex-model", "input": "hello"},
    )

    assert response.status_code == 401
    assert "codex login" in response.json()["error"]["message"]
    await client.aclose()


# --- Refreshing -------------------------------------------------------------


class RecordingTokenEndpoint:
    """Stand in for `auth.openai.com`, counting the grants it is asked for."""

    def __init__(self, *, rotate_refresh_token: bool = True) -> None:
        self.requests: list[dict[str, str]] = []
        self._rotate_refresh_token = rotate_refresh_token

    def transport(self) -> httpx.MockTransport:
        """The transport a `ChatGPTTokenRefresher` should post through."""
        return httpx.MockTransport(self._handle)

    async def _handle(self, request: httpx.Request) -> httpx.Response:
        assert str(request.url) == ChatGPTTokenRefresher.TOKEN_URL
        form = dict(
            pair.split("=", maxsplit=1)
            for pair in request.content.decode().split("&")
        )
        self.requests.append(form)
        grant: dict[str, Any] = {
            "access_token": access_token(expires_in=3600.0),
            "expires_in": 3600,
        }
        if self._rotate_refresh_token:
            grant["refresh_token"] = "refresh-token-2"
        return httpx.Response(200, json=grant)


async def test_expiring_login_is_refreshed_and_written_back_to_the_shared_file(
    tmp_path: Path,
) -> None:
    """The Codex CLI shares this file, so the renewed pair has to land in it."""
    path = tmp_path / "auth.json"
    auth_file = write_auth_file(path, logged_in_document(expires_in=-60.0))
    endpoint = RecordingTokenEndpoint()
    captured: dict[str, Any] = {}

    async def responses_call(**kwargs: Any) -> Any:
        captured.update(kwargs)
        return {"id": "resp"}

    application = application_with_auth_file(
        auth_file,
        responses_call=responses_call,
        refresher=ChatGPTTokenRefresher(endpoint.transport()),
    )
    application._registry.create(codex_route())
    client = gateway_client(application)

    response = await client.post(
        "/v1/responses",
        headers=AUTH,
        json={"model": "codex-model", "input": "hello"},
    )

    assert response.status_code == 200
    assert endpoint.requests == [
        {
            "grant_type": "refresh_token",
            "client_id": ChatGPTTokenRefresher.CLIENT_ID,
            "refresh_token": "refresh-token-1",
        }
    ]
    stored = json.loads(path.read_text(encoding="utf-8"))
    assert stored["tokens"]["access_token"] == captured["api_key"]
    assert stored["tokens"]["refresh_token"] == "refresh-token-2"
    # Fields this gateway does not own survive the rewrite.
    assert stored["auth_mode"] == "chatgpt"
    assert stored["tokens"]["id_token"] == "id-token"
    await client.aclose()


async def test_a_grant_that_does_not_rotate_keeps_the_previous_refresh_token(
    tmp_path: Path,
) -> None:
    """Dropping the old token when the grant omits a new one breaks the next refresh."""
    path = tmp_path / "auth.json"
    auth_file = write_auth_file(path, logged_in_document(expires_in=-60.0))
    endpoint = RecordingTokenEndpoint(rotate_refresh_token=False)
    provider = CodexOAuthCredentialProvider(auth_file, ChatGPTTokenRefresher(endpoint.transport()))

    tokens = await provider.tokens()

    assert tokens.refresh_token == "refresh-token-1"
    assert tokens.account_id == ACCOUNT_ID
    assert json.loads(path.read_text(encoding="utf-8"))["tokens"]["refresh_token"] == "refresh-token-1"


async def test_a_live_login_is_used_without_contacting_the_token_endpoint(
    tmp_path: Path,
) -> None:
    """Refreshing a token with an hour left would add a network hop to every turn."""
    document = logged_in_document(expires_in=3600.0)
    auth_file = write_auth_file(tmp_path / "auth.json", document)
    endpoint = RecordingTokenEndpoint()
    provider = CodexOAuthCredentialProvider(auth_file, ChatGPTTokenRefresher(endpoint.transport()))

    tokens = await provider.tokens()

    assert tokens.access_token == document["tokens"]["access_token"]
    assert endpoint.requests == []


async def test_concurrent_turns_share_one_refresh(tmp_path: Path) -> None:
    """Ten turns starting at once must not send ten refresh grants."""
    auth_file = write_auth_file(tmp_path / "auth.json", logged_in_document(expires_in=-60.0))
    endpoint = RecordingTokenEndpoint()
    provider = CodexOAuthCredentialProvider(auth_file, ChatGPTTokenRefresher(endpoint.transport()))

    results = await asyncio.gather(*(provider.tokens() for _ in range(10)))

    assert len(endpoint.requests) == 1
    assert len({tokens.access_token for tokens in results}) == 1


async def test_a_rejected_refresh_is_reported_as_a_login_problem(tmp_path: Path) -> None:
    """An expired refresh token needs a new login, and says so."""
    auth_file = write_auth_file(tmp_path / "auth.json", logged_in_document(expires_in=-60.0))
    refresher = ChatGPTTokenRefresher(
        httpx.MockTransport(lambda _: httpx.Response(400, json={"error": "invalid_grant"}))
    )
    provider = CodexOAuthCredentialProvider(auth_file, refresher)

    with pytest.raises(CodexOAuthUnavailable, match="codex login"):
        await provider.tokens()


async def test_an_undecodable_expiry_is_treated_as_live(tmp_path: Path) -> None:
    """Guessing an expiry would either refresh every call or never refresh."""
    document = logged_in_document()
    document["tokens"]["access_token"] = "not-a-jwt"
    auth_file = write_auth_file(tmp_path / "auth.json", document)
    endpoint = RecordingTokenEndpoint()
    provider = CodexOAuthCredentialProvider(auth_file, ChatGPTTokenRefresher(endpoint.transport()))

    tokens = await provider.tokens()

    assert tokens.access_token == "not-a-jwt"
    assert endpoint.requests == []


async def test_the_account_id_falls_back_to_the_token_claims(tmp_path: Path) -> None:
    """A login stored without `account_id` still names the account it belongs to."""
    document = logged_in_document()
    del document["tokens"]["account_id"]
    auth_file = write_auth_file(tmp_path / "auth.json", document)

    assert (await CodexOAuthCredentialProvider(auth_file).tokens()).account_id == ACCOUNT_ID


# --- The wire -------------------------------------------------------------


async def test_streamed_codex_turn_posts_to_the_backend_path_without_v1(
    tmp_path: Path,
) -> None:
    """The ChatGPT backend has no `/v1`; adding one turns every turn into a 404."""
    document = logged_in_document()
    auth_file = write_auth_file(tmp_path / "auth.json", document)
    captured: dict[str, Any] = {}

    async def upstream(request: httpx.Request) -> httpx.Response:
        captured.update(
            {
                "url": str(request.url),
                "authorization": request.headers.get("authorization"),
                "account_id": request.headers.get("chatgpt-account-id"),
                "originator": request.headers.get("originator"),
                "model": json.loads(request.content)["model"],
            }
        )
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            stream=httpx.ByteStream(b'data: {"type":"response.completed"}\n\n'),
        )

    application = application_with_auth_file(
        auth_file,
        responses_sse_proxy=NativeResponsesSSEProxy(transport=httpx.MockTransport(upstream)),
    )
    application._registry.create(codex_route())
    client = gateway_client(application)

    response = await client.post(
        "/v1/responses",
        headers={**AUTH, "originator": "codex_cli_rs"},
        json={"model": "codex-model", "input": "hello", "stream": True},
    )

    assert response.status_code == 200
    assert captured == {
        "url": "https://chatgpt.com/backend-api/codex/responses",
        "authorization": f"Bearer {document['tokens']['access_token']}",
        "account_id": ACCOUNT_ID,
        "originator": "codex_cli_rs",
        # The LiteLLM provider prefix is Tokkey's routing detail, not a model name.
        "model": "gpt-5-codex",
    }
    await client.aclose()


async def test_a_caller_cannot_shadow_the_account_the_call_is_billed_to(
    tmp_path: Path,
) -> None:
    """`chatgpt-account-id` is resolved by the gateway, never relayed."""
    auth_file = write_auth_file(tmp_path / "auth.json", logged_in_document())
    captured: dict[str, Any] = {}

    async def upstream(request: httpx.Request) -> httpx.Response:
        captured["account_id"] = request.headers.get("chatgpt-account-id")
        captured["authorization"] = request.headers.get("authorization")
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            stream=httpx.ByteStream(b'data: {"type":"response.completed"}\n\n'),
        )

    application = application_with_auth_file(
        auth_file,
        responses_sse_proxy=NativeResponsesSSEProxy(transport=httpx.MockTransport(upstream)),
    )
    application._registry.create(codex_route())
    client = gateway_client(application)

    response = await client.post(
        "/v1/responses",
        headers={
            "Authorization": "Bearer ocx_admin_someone_elses_secret",
            "chatgpt-account-id": "acct-someone-else",
        },
        json={"model": "codex-model", "input": "hello", "stream": True},
    )

    assert response.status_code == 200
    assert captured["account_id"] == ACCOUNT_ID
    assert "ocx_admin_someone_elses_secret" not in captured["authorization"]
    await client.aclose()


# --- Codex native models: one route, two backends ---------------------------


def native_route(**overrides: Any) -> dict[str, Any]:
    """One Codex native model route: no endpoint and no key of its own."""
    return {
        "model_name": "gpt-5.5",
        "litellm_params": {"model": "openai/gpt-5.5", "api_key": "", "api_base": ""},
        "model_info": {
            "created_by": "tokkey",
            "upstream": CodexNativeRoute.MARKER,
            "api_format": "openai_responses",
            "supports_native_streaming": True,
            "supports_responses_sse_passthrough": True,
            **overrides,
        },
    }


async def native_route_target(
    headers: dict[str, str],
    *,
    auth_file: CodexAuthFile,
) -> dict[str, Any]:
    """Run one native-model turn and report the endpoint and key it resolved to."""
    captured: dict[str, Any] = {}

    async def responses_call(**kwargs: Any) -> Any:
        captured.update(kwargs)
        return {"id": "resp"}

    application = application_with_auth_file(auth_file, responses_call=responses_call)
    application._registry.create(native_route())
    client = gateway_client(application)

    response = await client.post(
        "/v1/responses",
        headers=headers,
        json={"model": "gpt-5.5", "input": "hello"},
    )

    assert response.status_code == 200
    await client.aclose()
    return captured


async def test_native_model_with_an_openai_key_goes_to_the_public_api(
    tmp_path: Path,
) -> None:
    """A caller who brought a key is served by the endpoint that key works on."""
    auth_file = write_auth_file(tmp_path / "auth.json", logged_in_document())

    captured = await native_route_target(
        {"Authorization": "Bearer sk-proj-abc123"},
        auth_file=auth_file,
    )

    assert captured["api_base"] == OpenAiApiEndpoint.BASE_URL
    assert captured["api_key"] == "sk-proj-abc123"
    # The ChatGPT account header belongs to the other backend only.
    assert "chatgpt-account-id" not in captured.get("extra_headers", {})


async def test_native_model_without_a_key_spends_the_chatgpt_login(tmp_path: Path) -> None:
    """A caller with no key at all is served by the user's ChatGPT subscription."""
    document = logged_in_document()
    auth_file = write_auth_file(tmp_path / "auth.json", document)

    captured = await native_route_target({}, auth_file=auth_file)

    assert captured["api_base"] == CanonicalCodexEndpoint.BASE_URL
    assert captured["api_key"] == document["tokens"]["access_token"]
    assert captured["extra_headers"]["chatgpt-account-id"] == ACCOUNT_ID


@pytest.mark.parametrize(
    "placeholder",
    ["dummy", "local", "ocx_admin_secret", "Bearer", "sk-", "not-a-key"],
)
async def test_a_placeholder_bearer_never_reaches_the_public_api(
    tmp_path: Path,
    placeholder: str,
) -> None:
    """Agents pointed here routinely carry a fake key; it must not be relayed."""
    document = logged_in_document()
    auth_file = write_auth_file(tmp_path / "auth.json", document)

    captured = await native_route_target(
        {"Authorization": f"Bearer {placeholder}"},
        auth_file=auth_file,
    )

    assert captured["api_base"] == CanonicalCodexEndpoint.BASE_URL
    assert captured["api_key"] == document["tokens"]["access_token"]
    assert placeholder not in json.dumps(captured.get("extra_headers", {}))


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("sk-abc", True),
        ("sk-proj-abc", True),
        ("sk-svcacct-abc", True),
        ("sk-", False),
        ("dummy", False),
        ("", False),
        (None, False),
    ],
)
def test_openai_key_shape(value: Any, expected: bool) -> None:
    """Only the issued-key prefix selects the public API path."""
    assert OpenAiApiKey.looks_like(value) is expected


async def test_native_model_streams_to_the_public_api_with_v1(tmp_path: Path) -> None:
    """The public API keeps its `/v1`, which the ChatGPT backend does not have."""
    auth_file = write_auth_file(tmp_path / "auth.json", logged_in_document())
    captured: dict[str, Any] = {}

    async def upstream(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["authorization"] = request.headers.get("authorization")
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            stream=httpx.ByteStream(b'data: {"type":"response.completed"}\n\n'),
        )

    application = application_with_auth_file(
        auth_file,
        responses_sse_proxy=NativeResponsesSSEProxy(transport=httpx.MockTransport(upstream)),
    )
    application._registry.create(native_route())
    client = gateway_client(application)

    response = await client.post(
        "/v1/responses",
        headers={"Authorization": "Bearer sk-proj-abc123"},
        json={"model": "gpt-5.5", "input": "hello", "stream": True},
    )

    assert response.status_code == 200
    assert captured == {
        "url": "https://api.openai.com/v1/responses",
        "authorization": "Bearer sk-proj-abc123",
    }
    await client.aclose()


async def test_native_model_streams_to_the_chatgpt_backend_without_v1(
    tmp_path: Path,
) -> None:
    """The same route, no key, reaches the other backend at its own path."""
    document = logged_in_document()
    auth_file = write_auth_file(tmp_path / "auth.json", document)
    captured: dict[str, Any] = {}

    async def upstream(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["account_id"] = request.headers.get("chatgpt-account-id")
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            stream=httpx.ByteStream(b'data: {"type":"response.completed"}\n\n'),
        )

    application = application_with_auth_file(
        auth_file,
        responses_sse_proxy=NativeResponsesSSEProxy(transport=httpx.MockTransport(upstream)),
    )
    application._registry.create(native_route())
    client = gateway_client(application)

    response = await client.post(
        "/v1/responses",
        json={"model": "gpt-5.5", "input": "hello", "stream": True},
    )

    assert response.status_code == 200
    assert captured == {
        "url": "https://chatgpt.com/backend-api/codex/responses",
        "account_id": ACCOUNT_ID,
    }
    await client.aclose()


async def test_an_ordinary_keyless_route_is_unaffected_by_the_native_marker(
    tmp_path: Path,
) -> None:
    """Only a marked route dual-routes; an unmarked one keeps its old behavior."""
    auth_file = write_auth_file(tmp_path / "auth.json", logged_in_document())
    unmarked = native_route()
    del unmarked["model_info"]["upstream"]
    captured: dict[str, Any] = {}

    async def responses_call(**kwargs: Any) -> Any:
        captured.update(kwargs)
        return {"id": "resp"}

    application = application_with_auth_file(auth_file, responses_call=responses_call)
    application._registry.create(unmarked)
    client = gateway_client(application)

    response = await client.post(
        "/v1/responses",
        headers={"Authorization": "Bearer sk-proj-abc123"},
        json={"model": "gpt-5.5", "input": "hello"},
    )

    assert response.status_code == 200
    # Forwarded caller key, and no endpoint injected: the SDK default applies.
    assert captured["api_key"] == "sk-proj-abc123"
    assert "api_base" not in captured
    await client.aclose()


# --- A native model served from the user's own OpenAI-compatible service -----


def relayed_native_route(**params: Any) -> dict[str, Any]:
    """A native route pointed at a subscription relay or self-hosted proxy."""
    route = native_route()
    route["litellm_params"] = {**route["litellm_params"], **params}
    return route


async def native_route_call(
    route: dict[str, Any],
    headers: dict[str, str],
    *,
    auth_file: CodexAuthFile,
) -> dict[str, Any]:
    """Run one turn against the given native route and report the SDK arguments."""
    captured: dict[str, Any] = {}

    async def responses_call(**kwargs: Any) -> Any:
        captured.update(kwargs)
        return {"id": "resp"}

    application = application_with_auth_file(auth_file, responses_call=responses_call)
    application._registry.create(route)
    client = gateway_client(application)

    response = await client.post(
        "/v1/responses",
        headers=headers,
        json={"model": "gpt-5.5", "input": "hello"},
    )

    assert response.status_code == 200
    await client.aclose()
    return captured


async def test_a_configured_endpoint_wins_over_the_public_api(tmp_path: Path) -> None:
    """A relay issues `sk-` keys too, so the prefix must not pick the destination."""
    auth_file = write_auth_file(tmp_path / "auth.json", logged_in_document())

    captured = await native_route_call(
        relayed_native_route(api_base="https://relay.example/v1"),
        {"Authorization": "Bearer sk-relay-issued-key"},
        auth_file=auth_file,
    )

    assert captured["api_base"] == "https://relay.example/v1"
    assert captured["api_key"] == "sk-relay-issued-key"


async def test_a_configured_endpoint_uses_its_stored_key_over_the_callers(
    tmp_path: Path,
) -> None:
    """Tokkey's own choice of key for a relay outranks whatever an agent sends."""
    auth_file = write_auth_file(tmp_path / "auth.json", logged_in_document())

    captured = await native_route_call(
        relayed_native_route(api_base="https://relay.example/v1", api_key="stored-relay-key"),
        {"Authorization": "Bearer sk-proj-caller-key"},
        auth_file=auth_file,
    )

    assert captured["api_base"] == "https://relay.example/v1"
    assert captured["api_key"] == "stored-relay-key"


async def test_a_keyless_turn_reaches_the_chatgpt_login_past_a_configured_endpoint(
    tmp_path: Path,
) -> None:
    """The route's endpoint is where key traffic goes; a keyless turn has none."""
    document = logged_in_document()
    auth_file = write_auth_file(tmp_path / "auth.json", document)

    captured = await native_route_call(
        relayed_native_route(api_base="https://relay.example/v1"),
        {},
        auth_file=auth_file,
    )

    assert captured["api_base"] == CanonicalCodexEndpoint.BASE_URL
    assert captured["api_key"] == document["tokens"]["access_token"]
    assert captured["extra_headers"]["chatgpt-account-id"] == ACCOUNT_ID


async def test_a_placeholder_key_never_reaches_a_configured_endpoint(
    tmp_path: Path,
) -> None:
    """A relay cannot honor a placeholder either, so it must not be sent one."""
    document = logged_in_document()
    auth_file = write_auth_file(tmp_path / "auth.json", document)

    captured = await native_route_call(
        relayed_native_route(api_base="https://relay.example/v1"),
        {"Authorization": "Bearer ocx_admin_secret"},
        auth_file=auth_file,
    )

    assert captured["api_base"] == CanonicalCodexEndpoint.BASE_URL
    assert captured["api_key"] == document["tokens"]["access_token"]


async def test_a_relay_never_receives_the_chatgpt_account_header(tmp_path: Path) -> None:
    """The ChatGPT account id identifies an account only chatgpt.com should see."""
    auth_file = write_auth_file(tmp_path / "auth.json", logged_in_document())

    captured = await native_route_call(
        relayed_native_route(api_base="https://relay.example/v1", api_key="stored-relay-key"),
        {"Authorization": "Bearer sk-proj-caller-key", "originator": "codex_cli_rs"},
        auth_file=auth_file,
    )

    assert "chatgpt-account-id" not in captured.get("extra_headers", {})
    # The Codex identity set belongs to the ChatGPT backend, not to a relay.
    assert "originator" not in captured.get("extra_headers", {})


async def test_a_native_route_with_only_a_stored_key_uses_the_public_api(
    tmp_path: Path,
) -> None:
    """A pasted OpenAI key with no endpoint still means the endpoint it came from."""
    auth_file = write_auth_file(tmp_path / "auth.json", logged_in_document())

    captured = await native_route_call(
        relayed_native_route(api_key="sk-proj-stored"),
        {},
        auth_file=auth_file,
    )

    assert captured["api_base"] == OpenAiApiEndpoint.BASE_URL
    assert captured["api_key"] == "sk-proj-stored"


async def test_a_relay_endpoint_streams_to_its_own_responses_path(tmp_path: Path) -> None:
    """The relay's base keeps whatever path shape the user configured."""
    auth_file = write_auth_file(tmp_path / "auth.json", logged_in_document())
    captured: dict[str, Any] = {}

    async def upstream(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["authorization"] = request.headers.get("authorization")
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            stream=httpx.ByteStream(b'data: {"type":"response.completed"}\n\n'),
        )

    application = application_with_auth_file(
        auth_file,
        responses_sse_proxy=NativeResponsesSSEProxy(transport=httpx.MockTransport(upstream)),
    )
    application._registry.create(
        relayed_native_route(api_base="https://relay.example/v1", api_key="sk-relay")
    )
    client = gateway_client(application)

    response = await client.post(
        "/v1/responses",
        json={"model": "gpt-5.5", "input": "hello", "stream": True},
    )

    assert response.status_code == 200
    assert captured == {
        "url": "https://relay.example/v1/responses",
        "authorization": "Bearer sk-relay",
    }
    await client.aclose()
