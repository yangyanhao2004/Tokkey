"""What one upstream provider call authenticates with, and how it is chosen."""

from __future__ import annotations

import ipaddress
from collections.abc import Mapping
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from starlette.requests import Request

from .codex_oauth import (
    CanonicalCodexEndpoint,
    CodexNativeRoute,
    CodexOAuthCredentialProvider,
    CodexOAuthUnavailable,
    OpenAiApiEndpoint,
    OpenAiApiKey,
)
from .registry import ModelRoute


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
class UpstreamTarget:
    """Where one provider call goes and how it authenticates.

    Destination and credential are one decision, not two. A Codex native model
    is served by OpenAI's public API when the caller brought a key and by the
    ChatGPT backend when it did not, and those two endpoints accept entirely
    different credentials -- so a change that moved one without the other would
    send a ChatGPT OAuth token to `api.openai.com`. Resolving them together is
    what makes that combination unrepresentable.

    `headers` carries whatever else identifies the account being spent: the
    ChatGPT backend pairs its token with `chatgpt-account-id` and rejects one
    without the other.

    An `api_base` of None means the provider SDK's own default endpoint, which
    is how a route that never configured one has always behaved.
    """

    api_base: str | None = None
    api_key: str | None = None
    headers: Mapping[str, str] = field(default_factory=dict)


class MissingUpstreamCredential(Exception):
    """Raised when a public provider call has no credential to carry."""


class UpstreamTargetPolicy:
    """Choose where one provider call goes and what it carries, in a fixed order.

    The gateway itself is unauthenticated -- it listens on loopback only, so a
    key checked here would guard nothing the operating system does not already
    guard. What an incoming `Authorization` header is good for is the upstream
    call, and only when Tokiie has nothing better:

    1. A Codex native model is served from whichever OpenAI-compatible service
       the user actually has: the endpoint the Codex CLI is configured with
       whenever a key is available for it, and otherwise the ChatGPT backend on
       the user's login. One model entry therefore works for every kind of user.
    2. A local model server needs no credential and is called without one.
    3. A route pointing at the canonical ChatGPT Codex backend spends the user's
       ChatGPT login from `~/.codex/auth.json`, whatever the caller sent.
    4. The key stored on the route is Tokiie's own choice for that model and
       wins over anything a caller sends, so an agent cannot redirect a paid
       provider call onto someone else's account.
    5. Otherwise the caller's own header is forwarded, which is what lets an
       agent bring its own key for a route Tokiie holds no key for.

    Step 3 sits above the stored and caller keys rather than acting as a
    fallback for a request that happens to arrive without one. The ChatGPT
    backend accepts nothing but a ChatGPT OAuth token, so any other credential
    reaching it is both useless and a leak: a local agent configured with a
    placeholder key would otherwise send that key to chatgpt.com.

    Step 1 is the only place a caller's header can change the destination, and
    only ever between the two endpoints this machine is already configured for
    -- never to a host the caller names. It is also why that header is matched
    against the shape of an issued OpenAI key rather than merely being present:
    see `OpenAiApiKey`.

    A public route with no key anywhere fails here rather than reaching the
    provider with a placeholder, so the caller reads why it was rejected instead
    of an opaque upstream 401.
    """

    # LiteLLM builds a provider SDK client before the request leaves this
    # process, and the OpenAI client refuses to be constructed without a key.
    # A loopback server ignores whatever arrives, so this placeholder keeps the
    # SDK path working without inventing a credential the user has to manage.
    LOCAL_PLACEHOLDER_KEY = "local"

    def __init__(
        self,
        endpoints: LocalEndpointPolicy | None = None,
        codex_oauth: CodexOAuthCredentialProvider | None = None,
    ) -> None:
        self._endpoints = endpoints or LocalEndpointPolicy()
        self._codex_oauth = codex_oauth or CodexOAuthCredentialProvider()

    async def resolve(self, route: ModelRoute, request: Request) -> UpstreamTarget:
        """Return where this call goes and what it carries."""
        normalized_base = self._configured(route, "api_base")
        if CodexNativeRoute.matches(route.model_info):
            return await self._native_codex_target(route, request)
        if normalized_base is not None and self._endpoints.is_local(normalized_base):
            return UpstreamTarget(api_base=normalized_base)
        if CanonicalCodexEndpoint.matches(normalized_base):
            return await self._chatgpt_target(route, normalized_base)
        stored_key = self._configured(route, "api_key")
        if stored_key is not None:
            return UpstreamTarget(api_base=normalized_base, api_key=stored_key)
        caller_key = self.caller_credential(request)
        if caller_key is None:
            raise MissingUpstreamCredential(
                f"model '{route.model_name}' has no stored key and the request carried none"
            )
        return UpstreamTarget(api_base=normalized_base, api_key=caller_key)

    async def _native_codex_target(self, route: ModelRoute, request: Request) -> UpstreamTarget:
        """Pick the service a Codex native model is served from, from the key.

        The credential decides the destination here, because these two backends
        accept nothing but their own kind of credential:

        1. A key stored on the route is Tokiie's own choice for this model and
           is spent on the route's endpoint, whatever the caller sent.
        2. Otherwise a caller who brought an OpenAI-shaped key gets the API-key
           endpoint -- the route's own, which is the one the Codex CLI is
           configured to call, or OpenAI's public API when it names none.
        3. A caller who brought nothing usable gets the ChatGPT backend, paid
           for by the user's `codex login`.

        The route's endpoint is read from `~/.codex/config.toml` rather than
        chosen per model, so it describes where API-key traffic goes on this
        machine and says nothing about whether this turn has a key. That is why
        it cannot outrank the credential: a user with a relay configured for the
        CLI still has a ChatGPT subscription, and a keyless turn must reach it
        instead of failing at a relay that would only answer 401.
        """
        configured_base = self._configured(route, "api_base")
        stored_key = self._configured(route, "api_key")
        if stored_key is not None:
            return UpstreamTarget(
                api_base=configured_base or OpenAiApiEndpoint.BASE_URL,
                api_key=stored_key,
            )
        caller_key = self.caller_credential(request)
        if OpenAiApiKey.looks_like(caller_key):
            return UpstreamTarget(
                api_base=configured_base or OpenAiApiEndpoint.BASE_URL,
                api_key=caller_key,
            )
        return await self._chatgpt_target(route, CanonicalCodexEndpoint.BASE_URL)

    @staticmethod
    def _configured(route: ModelRoute, name: str) -> str | None:
        """Read one route parameter, treating blank and absent alike."""
        value = route.litellm_params.get(name)
        return value.strip() if isinstance(value, str) and value.strip() else None

    async def _chatgpt_target(self, route: ModelRoute, api_base: str) -> UpstreamTarget:
        """Spend the user's ChatGPT login, failing before any upstream request."""
        try:
            tokens = await self._codex_oauth.tokens()
        except CodexOAuthUnavailable as error:
            raise MissingUpstreamCredential(
                f"model '{route.model_name}' uses the ChatGPT Codex backend, but {error}"
            ) from error
        return UpstreamTarget(
            api_base=api_base,
            api_key=tokens.access_token,
            headers={"chatgpt-account-id": tokens.account_id},
        )

    @staticmethod
    def caller_credential(request: Request) -> str | None:
        """Read the caller's own key from either protocol's header form."""
        authorization = request.headers.get("authorization", "")
        if authorization.startswith("Bearer "):
            bearer = authorization.removeprefix("Bearer ").strip()
            if bearer:
                return bearer
        # Anthropic clients authenticate with x-api-key instead of a bearer token.
        return request.headers.get("x-api-key", "").strip() or None
