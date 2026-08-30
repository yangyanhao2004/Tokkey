"""ChatGPT OAuth credentials for the canonical Codex backend.

The Codex CLI logs a user into their ChatGPT account and leaves the resulting
OAuth tokens in `~/.codex/auth.json`. This module lets the gateway spend that
login on the user's behalf, so a route can reach OpenAI's Codex models with no
API key configured anywhere.

Two facts shape everything here:

* The token is only accepted by `https://chatgpt.com/backend-api/codex`, and
  sending it anywhere else would hand the user's ChatGPT account to whoever
  configured that route. `CanonicalCodexEndpoint` is the only thing standing
  between those two outcomes.
* The token expires roughly hourly, while a Tokiie session does not. The
  refresh grant therefore lives here rather than in the app, and the refreshed
  pair is written back to the same file so the Codex CLI keeps working too.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx

LOGGER = logging.getLogger(__name__)

# Client identity headers a Codex caller may send through to the ChatGPT
# backend. `authorization` and `chatgpt-account-id` are deliberately absent:
# the gateway owns both, and relaying a caller's version of either would let a
# local agent choose which account the upstream call is billed to.
CODEX_CLIENT_IDENTITY_HEADERS = frozenset(
    {
        "openai-beta",
        "originator",
        "session_id",
        "session-id",
        "thread-id",
        "x-client-request-id",
        "x-codex-beta-features",
        "x-codex-installation-id",
        "x-codex-parent-thread-id",
        "x-codex-turn-metadata",
        "x-codex-turn-state",
        "x-codex-window-id",
        "x-oai-attestation",
        "x-openai-subagent",
        "x-responsesapi-include-timing-metrics",
    }
)


class CodexOAuthUnavailable(Exception):
    """Raised when no live ChatGPT OAuth credential can be produced."""


class CodexNativeRoute:
    """Recognize a route Tokiie serves from the Codex model catalog.

    A native route stores no endpoint and no key: which of OpenAI's two backends
    answers it is decided per request, from the credential the caller brought.
    The marker is explicit rather than inferred from the empty endpoint, because
    "no endpoint configured" is also what an ordinary route relying on the SDK's
    default looks like, and those must keep behaving as they always have.
    """

    MARKER = "codex_native"

    @classmethod
    def matches(cls, model_info: dict[str, Any]) -> bool:
        """Return whether this route's durable marker names a Codex native model."""
        return model_info.get("upstream") == cls.MARKER


class OpenAiApiKey:
    """Tell a plausible API key from a placeholder a caller merely sent.

    This decides one thing only: whether an unconfigured native route falls back
    to the public API or to the ChatGPT login. "The caller sent something" is
    not a safe test there, because agents pointed at this gateway routinely
    carry a placeholder and Tokiie's own admission tokens are bearer tokens too,
    and shipping either to OpenAI would leak a local secret for a confusing 401.
    An unrecognized token falls through to the ChatGPT login instead, which is
    both the safe direction and the one that costs the user nothing.

    It is deliberately *not* evidence that a key belongs to OpenAI. Subscription
    relays and self-hosted proxies issue `sk-`-prefixed keys precisely so that
    OpenAI clients accept them, so the prefix cannot identify the issuer. A user
    whose key belongs to such a service configures its endpoint on the route,
    and that endpoint wins before this check is ever reached.
    """

    # Covers every form OpenAI issues today: `sk-`, `sk-proj-`, `sk-svcacct-`.
    PREFIX = "sk-"

    @classmethod
    def looks_like(cls, value: str | None) -> bool:
        """Return whether this token is shaped like a key OpenAI would accept."""
        return isinstance(value, str) and value.startswith(cls.PREFIX) and len(value) > len(cls.PREFIX)


class OpenAiApiEndpoint:
    """The public OpenAI API, which is what an API key buys access to."""

    BASE_URL = "https://api.openai.com/v1"


class CanonicalCodexEndpoint:
    """Recognize the one base URL a ChatGPT OAuth token may ever be sent to.

    Equality against the normalized URL is the security boundary of this whole
    module, so it is deliberately not a string comparison: a URL carrying
    userinfo, a query, or a fragment can disguise a different destination and is
    rejected outright rather than normalized into something that compares equal.
    """

    BASE_URL = "https://chatgpt.com/backend-api/codex"

    @classmethod
    def matches(cls, api_base: Any) -> bool:
        """Return whether this route's endpoint is the canonical Codex backend."""
        return cls.normalize(api_base) == cls.BASE_URL

    @staticmethod
    def normalize(api_base: Any) -> str | None:
        """Return the scheme/host/path form of a URL, or None when it is unusable."""
        if not isinstance(api_base, str) or not api_base.strip():
            return None
        try:
            parts = urlsplit(api_base.strip())
        except ValueError:
            return None
        if not parts.scheme or not parts.netloc:
            return None
        if parts.query or parts.fragment or "@" in parts.netloc:
            return None
        return f"{parts.scheme.lower()}://{parts.netloc.lower()}{parts.path.rstrip('/')}"


@dataclass(frozen=True, slots=True)
class ChatGPTOAuthTokens:
    """One ChatGPT login as the Codex CLI stores it."""

    access_token: str
    refresh_token: str
    account_id: str
    # None when the access token carries no decodable expiry. Such a token is
    # treated as live on purpose: guessing an expiry would either refresh every
    # call or never refresh, and an actually dead token still surfaces as an
    # upstream 401.
    expires_at: float | None

    def expires_within(self, seconds: float) -> bool:
        """Return whether this token is close enough to expiry to refresh now."""
        return self.expires_at is not None and self.expires_at - time.time() <= seconds


class JsonWebTokenClaims:
    """Read the unverified payload of a JWT.

    Nothing here is a security decision -- the issuer verifies the token, not
    this process. The claims are only used to learn when to refresh and which
    ChatGPT account a token belongs to.
    """

    @staticmethod
    def decode(token: str) -> dict[str, Any]:
        """Return the token's claims, or an empty mapping when it is undecodable."""
        parts = token.split(".")
        if len(parts) != 3 or not parts[1]:
            return {}
        payload = parts[1]
        # JWTs use base64url without padding; b64decode requires it.
        padded = payload + "=" * (-len(payload) % 4)
        try:
            claims = json.loads(base64.urlsafe_b64decode(padded))
        except (ValueError, json.JSONDecodeError):
            return {}
        return claims if isinstance(claims, dict) else {}

    @classmethod
    def expiry(cls, token: str) -> float | None:
        """Return the `exp` claim in epoch seconds, or None when absent."""
        expiry = cls.decode(token).get("exp")
        return float(expiry) if isinstance(expiry, (int, float)) else None

    @classmethod
    def chatgpt_account_id(cls, *tokens: str) -> str:
        """Find the ChatGPT account id in the first token that carries one."""
        for token in tokens:
            claims = cls.decode(token)
            account_id = claims.get("chatgpt_account_id")
            if isinstance(account_id, str) and account_id:
                return account_id
            namespaced = claims.get("https://api.openai.com/auth")
            if isinstance(namespaced, dict):
                account_id = namespaced.get("chatgpt_account_id")
                if isinstance(account_id, str) and account_id:
                    return account_id
        return ""


class CodexAuthFile:
    """Read and rewrite `auth.json` in the one shape the Codex CLI writes.

    The file is shared with the Codex CLI, so a rewrite preserves every field it
    does not own and replaces the file atomically. That keeps a concurrent
    reader from ever seeing a half-written login, at the cost of losing a
    simultaneous CLI write -- which the CLI recovers from by refreshing again.
    """

    FILE_NAME = "auth.json"

    def __init__(self, path: Path | None = None) -> None:
        self._path = path or self.default_path()

    @staticmethod
    def default_path() -> Path:
        """Locate `auth.json` the way the Codex CLI does, honoring `CODEX_HOME`."""
        codex_home = os.environ.get("CODEX_HOME", "").strip()
        home = Path(codex_home) if codex_home else Path.home() / ".codex"
        return home / CodexAuthFile.FILE_NAME

    @property
    def path(self) -> Path:
        """The file this instance reads and writes."""
        return self._path

    def read(self) -> ChatGPTOAuthTokens:
        """Return the stored ChatGPT login, explaining precisely what is missing."""
        document = self._read_document()
        tokens = document.get("tokens")
        access_token = tokens.get("access_token") if isinstance(tokens, dict) else None
        if not isinstance(access_token, str) or not access_token.strip():
            # The API-key shape is a distinct, common state and deserves its own
            # diagnosis: relaying an `sk-` key to the ChatGPT backend only ever
            # produces an opaque 401.
            if document.get("OPENAI_API_KEY"):
                raise CodexOAuthUnavailable(
                    f"{self._path} holds an OpenAI API key rather than a ChatGPT login; "
                    "run `codex login` to sign in with ChatGPT"
                )
            raise CodexOAuthUnavailable(
                f"{self._path} carries no ChatGPT access token; run `codex login`"
            )

        refresh_token = tokens.get("refresh_token")
        id_token = tokens.get("id_token")
        stored_account_id = tokens.get("account_id")
        account_id = (
            stored_account_id
            if isinstance(stored_account_id, str) and stored_account_id
            else JsonWebTokenClaims.chatgpt_account_id(
                id_token if isinstance(id_token, str) else "",
                access_token,
            )
        )
        if not account_id:
            raise CodexOAuthUnavailable(
                f"{self._path} names no ChatGPT account; run `codex login` again"
            )
        return ChatGPTOAuthTokens(
            access_token=access_token.strip(),
            refresh_token=refresh_token.strip() if isinstance(refresh_token, str) else "",
            account_id=account_id,
            expires_at=JsonWebTokenClaims.expiry(access_token),
        )

    def write(self, tokens: ChatGPTOAuthTokens) -> None:
        """Persist a refreshed login without disturbing fields this file shares."""
        document = self._read_document()
        stored_tokens = document.get("tokens")
        document = {
            **document,
            "tokens": {
                **(stored_tokens if isinstance(stored_tokens, dict) else {}),
                "access_token": tokens.access_token,
                "refresh_token": tokens.refresh_token,
                "account_id": tokens.account_id,
            },
            "last_refresh": self._timestamp(),
        }
        temporary_path = self._path.with_name(f"{self._path.name}.tokiie.tmp")
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            # The file holds a live credential, so it is created unreadable by
            # other users before any bytes are written into it.
            descriptor = os.open(temporary_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(document, handle, indent=2)
            os.replace(temporary_path, self._path)
        except OSError:
            temporary_path.unlink(missing_ok=True)
            # A refreshed token that cannot be stored is still usable for this
            # call; only the next process pays for the lost write.
            LOGGER.warning("Could not persist the refreshed ChatGPT login to %s", self._path)

    def _read_document(self) -> dict[str, Any]:
        """Return the parsed file, failing with the reason it could not be read."""
        try:
            document = json.loads(self._path.read_text(encoding="utf-8"))
        except FileNotFoundError as error:
            raise CodexOAuthUnavailable(
                f"no ChatGPT login found at {self._path}; run `codex login`"
            ) from error
        except (OSError, json.JSONDecodeError) as error:
            raise CodexOAuthUnavailable(f"could not read {self._path}: {error}") from error
        if not isinstance(document, dict):
            raise CodexOAuthUnavailable(f"{self._path} is not a JSON object")
        return document

    @staticmethod
    def _timestamp() -> str:
        """Match the ISO-8601 shape the Codex CLI stamps on a refresh."""
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class ChatGPTTokenRefresher:
    """Exchange a refresh token for a new ChatGPT access token."""

    # The Codex CLI's own public OAuth client. The refresh tokens in auth.json
    # were issued to it, so no other client id can redeem them.
    CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
    TOKEN_URL = "https://auth.openai.com/oauth/token"
    TIMEOUT_SECONDS = 30.0

    def __init__(self, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._transport = transport

    async def refresh(self, tokens: ChatGPTOAuthTokens) -> ChatGPTOAuthTokens:
        """Return a renewed login, keeping the account id when the grant omits it."""
        if not tokens.refresh_token:
            raise CodexOAuthUnavailable(
                "the stored ChatGPT login has expired and carries no refresh token; "
                "run `codex login`"
            )
        try:
            async with httpx.AsyncClient(
                timeout=self.TIMEOUT_SECONDS,
                transport=self._transport,
            ) as client:
                response = await client.post(
                    self.TOKEN_URL,
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                    data={
                        "grant_type": "refresh_token",
                        "client_id": self.CLIENT_ID,
                        "refresh_token": tokens.refresh_token,
                    },
                )
        except httpx.HTTPError as error:
            raise CodexOAuthUnavailable(f"ChatGPT token refresh failed: {error}") from error

        if response.status_code >= 400:
            raise CodexOAuthUnavailable(
                f"ChatGPT token refresh was rejected with HTTP {response.status_code}; "
                "run `codex login`"
            )
        return self._tokens_from_grant(response, tokens)

    @classmethod
    def _tokens_from_grant(
        cls,
        response: httpx.Response,
        previous: ChatGPTOAuthTokens,
    ) -> ChatGPTOAuthTokens:
        """Decode one token response, carrying forward what it does not restate."""
        try:
            grant = response.json()
        except ValueError as error:
            raise CodexOAuthUnavailable("ChatGPT token refresh returned no JSON") from error
        if not isinstance(grant, dict):
            raise CodexOAuthUnavailable("ChatGPT token refresh returned no token object")

        access_token = grant.get("access_token")
        if not isinstance(access_token, str) or not access_token.strip():
            raise CodexOAuthUnavailable("ChatGPT token refresh returned no access token")
        access_token = access_token.strip()

        # A refresh may or may not rotate the refresh token; reusing the old one
        # when it does not is what keeps the next refresh working.
        refreshed = grant.get("refresh_token")
        refresh_token = (
            refreshed.strip()
            if isinstance(refreshed, str) and refreshed.strip()
            else previous.refresh_token
        )
        id_token = grant.get("id_token")
        account_id = (
            JsonWebTokenClaims.chatgpt_account_id(
                id_token if isinstance(id_token, str) else "",
                access_token,
            )
            or previous.account_id
        )
        return ChatGPTOAuthTokens(
            access_token=access_token,
            refresh_token=refresh_token,
            account_id=account_id,
            expires_at=JsonWebTokenClaims.expiry(access_token),
        )


class CodexOAuthCredentialProvider:
    """Serve a live ChatGPT login, refreshing it before a call goes out.

    Refreshing is serialized behind one lock and re-reads the file inside it, so
    concurrent turns produce a single refresh and a login the Codex CLI renewed
    a moment ago is adopted rather than replaced.
    """

    # Refresh this far ahead of expiry so a long turn cannot start on a token
    # that dies while the model is still streaming.
    EXPIRY_SKEW_SECONDS = 300.0

    def __init__(
        self,
        auth_file: CodexAuthFile | None = None,
        refresher: ChatGPTTokenRefresher | None = None,
    ) -> None:
        self._auth_file = auth_file or CodexAuthFile()
        self._refresher = refresher or ChatGPTTokenRefresher()
        self._refresh_lock = asyncio.Lock()

    async def tokens(self) -> ChatGPTOAuthTokens:
        """Return a login good for the call about to be made."""
        stored = self._auth_file.read()
        if not stored.expires_within(self.EXPIRY_SKEW_SECONDS):
            return stored
        async with self._refresh_lock:
            # Another turn, or the Codex CLI, may have refreshed while this one
            # waited; re-reading here is what makes that work not repeat.
            current = self._auth_file.read()
            if not current.expires_within(self.EXPIRY_SKEW_SECONDS):
                return current
            refreshed = await self._refresher.refresh(current)
            self._auth_file.write(refreshed)
            LOGGER.info("Refreshed the ChatGPT login backing the canonical Codex route")
            return refreshed
