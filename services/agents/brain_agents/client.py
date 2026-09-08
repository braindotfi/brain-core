"""HTTP client for the Brain API."""

import asyncio
import base64
import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import httpx

from brain_agents.jwt_util import jwt_claims
from brain_agents.service_auth import compute_service_auth_signature_v2

_TOKEN_EXCHANGE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange"
_AGENT_API_KEY_SUBJECT_TOKEN_TYPE = "urn:brain:params:oauth:token-type:agent-api-key"
_ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token"
_ACCESS_TOKEN_MAX_TTL_SECONDS = 300
_EARLY_REFRESH_SECONDS = 60
_CLOCK_SKEW_SECONDS = 5
_HTTP_UNAUTHORIZED = 401


class AgentTokenExchangeError(RuntimeError):
    """An agent key could not be exchanged for a valid access token."""


@dataclass(frozen=True)
class _CachedAccessToken:
    value: str
    expires_at: int


class AgentTokenManager:
    """Exchange one durable agent key and cache only short-lived JWTs in memory."""

    def __init__(
        self,
        *,
        agent_api_key: str,
        token_url: str,
        resource: str,
        scope: str,
        now: Callable[[], float] = time.time,
    ) -> None:
        self._agent_api_key = agent_api_key
        self._token_url = token_url
        self._resource = resource
        self._scope = scope
        self._now = now
        self._cached: _CachedAccessToken | None = None
        self._exchange_task: asyncio.Task[_CachedAccessToken] | None = None

    async def start(self) -> None:
        """Fail boot closed unless the initial exchange returns a valid token."""
        await self.get_access_token()

    async def get_access_token(self) -> str:
        cached = self._cached
        if cached is not None and cached.expires_at - self._now() > _EARLY_REFRESH_SECONDS:
            return cached.value
        return (await self._exchange_singleflight()).value

    async def refresh_after_unauthorized(self, failed_token: str) -> str:
        cached = self._cached
        if (
            cached is not None
            and cached.value != failed_token
            and cached.expires_at - self._now() > _EARLY_REFRESH_SECONDS
        ):
            return cached.value
        return (await self._exchange_singleflight()).value

    async def _exchange_singleflight(self) -> _CachedAccessToken:
        task = self._exchange_task
        if task is None:
            task = asyncio.create_task(self._exchange())
            self._exchange_task = task

            def clear(completed: asyncio.Task[_CachedAccessToken]) -> None:
                if self._exchange_task is completed:
                    self._exchange_task = None

            task.add_done_callback(clear)
        return await asyncio.shield(task)

    async def _exchange(self) -> _CachedAccessToken:
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    self._token_url,
                    data={
                        "grant_type": _TOKEN_EXCHANGE_GRANT_TYPE,
                        "subject_token": self._agent_api_key,
                        "subject_token_type": _AGENT_API_KEY_SUBJECT_TOKEN_TYPE,
                        "requested_token_type": _ACCESS_TOKEN_TYPE,
                        "resource": self._resource,
                        "scope": self._scope,
                    },
                    headers={"Accept": "application/json"},
                )
                response.raise_for_status()
                payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise AgentTokenExchangeError("agent API key exchange failed") from exc

        if not isinstance(payload, dict):
            raise AgentTokenExchangeError("agent API key exchange returned an invalid response")
        token = payload.get("access_token")
        expires_in = payload.get("expires_in")
        response_scope = payload.get("scope")
        if (
            not isinstance(token, str)
            or token == ""
            or payload.get("token_type") != "Bearer"
            or payload.get("issued_token_type") != _ACCESS_TOKEN_TYPE
            or not isinstance(expires_in, int)
            or isinstance(expires_in, bool)
            or expires_in <= 0
            or expires_in > _ACCESS_TOKEN_MAX_TTL_SECONDS
            or response_scope != self._scope
            or "refresh_token" in payload
        ):
            raise AgentTokenExchangeError("agent API key exchange returned an invalid response")

        claims = jwt_claims(token)
        now = int(self._now())
        if claims is None:
            raise AgentTokenExchangeError("agent API key exchange returned an invalid access token")
        exp = claims.get("exp")
        iat = claims.get("iat")
        scopes = claims.get("scopes")
        if (
            not isinstance(exp, int)
            or isinstance(exp, bool)
            or not isinstance(iat, int)
            or isinstance(iat, bool)
            or exp <= now
            or exp <= iat
            or iat > now + _CLOCK_SKEW_SECONDS
            or exp - iat > _ACCESS_TOKEN_MAX_TTL_SECONDS
            or exp > now + _ACCESS_TOKEN_MAX_TTL_SECONDS + _CLOCK_SKEW_SECONDS
            or claims.get("aud") != self._resource
            or not isinstance(claims.get("iss"), str)
            or claims.get("iss") == ""
            or claims.get("principal_type") != "agent"
            or not isinstance(claims.get("sub"), str)
            or not str(claims["sub"]).startswith("agent_")
            or not isinstance(claims.get("tenant_id"), str)
            or not str(claims["tenant_id"]).startswith("tnt_")
            or not isinstance(claims.get("credential_id"), str)
            or not str(claims["credential_id"]).startswith("agkey_")
            or not isinstance(claims.get("jti"), str)
            or not str(claims["jti"]).startswith("token_")
            or not isinstance(scopes, list)
            or not all(isinstance(value, str) for value in scopes)
            or scopes != self._scope.split()
        ):
            raise AgentTokenExchangeError("agent API key exchange returned an invalid access token")

        cached = _CachedAccessToken(value=token, expires_at=min(exp, now + expires_in))
        self._cached = cached
        return cached


class TenantBindingUnavailableError(RuntimeError):
    """propose() cannot prove which tenant a write belongs to.

    Raised instead of silently falling back to the static token's own
    tenant (F2): an unproven proposal here is a real proposal, with a real
    execution.propose audit event, potentially auto-approved by policy.
    Landing it in the wrong tenant is a cross-tenant leak, not a degraded-
    mode inconvenience. Configure a service_secret (BrainApiClient's third
    constructor argument, wired from BRAIN_AGENTS_INBOUND_SECRET) to enable
    tenant binding.
    """


class BrainApiClient:
    def __init__(
        self,
        base_url: str,
        token: str = "",
        service_secret: str = "",
        *,
        agent_api_key: str = "",
        auth_token_url: str = "",
        api_resource: str = "https://api.brain.fi/",
        agent_scope: str = "raw:write",
    ) -> None:
        if (token != "") == (agent_api_key != ""):
            raise ValueError("configure exactly one of token or agent_api_key")
        if agent_api_key != "" and auth_token_url == "":
            raise ValueError("auth_token_url is required with agent_api_key")
        self._base_url = base_url.rstrip("/")
        self._static_token = token
        self._service_secret = service_secret
        self._agent_tokens = (
            AgentTokenManager(
                agent_api_key=agent_api_key,
                token_url=auth_token_url,
                resource=api_resource,
                scope=agent_scope,
            )
            if agent_api_key != ""
            else None
        )

    async def start(self) -> None:
        """Perform the initial agent-key exchange before the service is healthy."""
        if self._agent_tokens is not None:
            await self._agent_tokens.start()

    def _service_auth_headers(self, tenant_id: str | None, body_bytes: bytes) -> dict[str, str]:
        """X-Brain-Write-Tenant + X-Brain-Service-Timestamp + X-Brain-Service-Auth
        (v2, F4), proving to the api side that a caller-supplied tenant_id is
        trustworthy (see post_parsed's docstring for the full trust model).
        Empty unless both a service_secret is configured and the caller names
        a tenant_id. The timestamp is generated fresh per call -- never
        cached or reused -- and is itself part of the signed material, so it
        must be sent as-is alongside the signature.
        """
        if tenant_id is None or self._service_secret == "":
            return {}
        timestamp = str(int(time.time()))
        return {
            "X-Brain-Write-Tenant": tenant_id,
            "X-Brain-Service-Timestamp": timestamp,
            "X-Brain-Service-Auth": compute_service_auth_signature_v2(
                self._service_secret, timestamp, tenant_id, body_bytes
            ),
        }

    async def _request(
        self,
        method: str,
        path: str,
        body_bytes: bytes | None = None,
        extra_headers: dict[str, str] | None = None,
        params: dict[str, str | int | float | bool | None] | None = None,
    ) -> httpx.Response:
        """Send with a current token and retry once after a key-mode 401."""

        token = (
            await self._agent_tokens.get_access_token()
            if self._agent_tokens is not None
            else self._static_token
        )

        async def _attempt(access_token: str) -> httpx.Response:
            headers = {
                "Authorization": f"Bearer {access_token}",
                **(extra_headers or {}),
            }
            if body_bytes is not None:
                headers["Content-Type"] = "application/json"
            async with httpx.AsyncClient(timeout=30.0) as client:
                return await client.request(
                    method,
                    f"{self._base_url}{path}",
                    content=body_bytes,
                    headers=headers,
                    params=params,
                )

        response = await _attempt(token)
        if response.status_code == _HTTP_UNAUTHORIZED and self._agent_tokens is not None:
            token = await self._agent_tokens.refresh_after_unauthorized(token)
            response = await _attempt(token)
        return response

    async def _post(
        self,
        path: str,
        body_bytes: bytes,
        extra_headers: dict[str, str] | None = None,
    ) -> httpx.Response:
        return await self._request("POST", path, body_bytes, extra_headers)

    async def propose(
        self, action: dict[str, Any], agent_id: str, tenant_id: str
    ) -> dict[str, Any]:
        """POST /v1/execution/propose and return the ProposalRecord.

        `tenant_id` forwards the caller's real tenant (same mechanism as
        post_parsed) so a static golden-tenant agent JWT writes the proposal
        -- and its execution.propose audit event -- into the caller's own
        tenant, never the token's tenant.

        Fails CLOSED (F2): unlike post_parsed's back-compat fallback,
        propose refuses to run at all when no service_secret is configured,
        rather than risk silently writing a real proposal (policy decision
        and audit event included) into the wrong tenant.
        """
        if self._service_secret == "":
            raise TenantBindingUnavailableError(
                "propose() requires a configured service_secret to prove "
                f"tenant_id={tenant_id!r} via X-Brain-Write-Tenant/"
                "X-Brain-Service-Auth; refusing to propose into the token's "
                "own tenant unproven."
            )
        json_body: dict[str, Any] = {"action": action, "agent_id": agent_id}
        body_bytes = json.dumps(json_body).encode("utf-8")
        resp = await self._post(
            "/v1/execution/propose",
            body_bytes,
            self._service_auth_headers(tenant_id, body_bytes),
        )
        resp.raise_for_status()
        result: dict[str, Any] = resp.json()
        return result

    async def list_recent_transactions(
        self, tenant_id: str, limit: int = 100
    ) -> list[dict[str, Any]]:
        """GET /v1/ledger/transactions filtered to the most recent batch.

        Used by the anomaly scheduler to assemble a scan window. The endpoint
        is tenant-scoped through the JWT; tenant_id here is informational
        (logged with the scan result).
        """
        resp = await self._request(
            "GET",
            "/v1/ledger/transactions",
            extra_headers={"X-Brain-Tenant": tenant_id},
            params={"limit": limit},
        )
        resp.raise_for_status()
        payload: dict[str, Any] = resp.json()
        # GET /v1/ledger/transactions returns { transactions: [...] }
        # (services/ledger/src/routes/index.ts). Older / alternate handlers
        # used `items` or `data`; keep both as fallbacks so a future route
        # rename does not silently turn the scheduler into a no-op.
        items = payload.get(
            "transactions",
            payload.get("items", payload.get("data", [])),
        )
        return list(items) if isinstance(items, list) else []

    async def post_parsed(
        self,
        raw_id: str,
        parser: str,
        parser_version: str,
        extracted: dict[str, Any],
        confidence: float | None = None,
        tenant_id: str | None = None,
    ) -> dict[str, Any]:
        """POST /v1/raw/{raw_id}/parsed — write one stage-3 parsed record.

        The Raw service owns raw_parsed; this is how an extractor agent
        contributes parsed evidence without touching the table directly.
        Naturally idempotent on (raw_artifact_id, parser, parser_version).
        Returns the RawParsed row.

        `tenant_id` forwards the caller's real tenant so a static
        golden-tenant agent JWT can still write into the caller's own
        tenant. Proven via the same HMAC scheme the api uses to sign its
        own outbound X-Brain-Auth calls (see brain_agents.auth.expected_
        signature), so the raw secret never goes over the wire, only a
        signature bound to this exact request body. Only takes effect
        when a service_secret was configured at construction; both
        headers are omitted otherwise (unchanged back-compat behavior:
        write lands in the JWT's own tenant).
        """
        json_body: dict[str, Any] = {
            "parser": parser,
            "parser_version": parser_version,
            "extracted": extracted,
        }
        if confidence is not None:
            json_body["confidence"] = confidence

        # Serialize once and send those exact bytes: the api verifies the
        # HMAC over the raw request body, so signing and sending must agree
        # byte-for-byte (same discipline as the api's own signAgentRequest).
        body_bytes = json.dumps(json_body).encode("utf-8")
        resp = await self._post(
            f"/v1/raw/{raw_id}/parsed",
            body_bytes,
            self._service_auth_headers(tenant_id, body_bytes),
        )
        resp.raise_for_status()
        result: dict[str, Any] = resp.json()
        return result

    async def raw_ingest(self, envelope: dict[str, Any]) -> dict[str, Any]:
        """POST one RawIngestRequest envelope to /v1/raw/ingest.

        The envelope's `body` field accepts either str (UTF-8 inlined) or
        bytes (base64-encoded over the wire). Returns the RawIngestResult.
        """
        body = envelope.get("body")
        json_body: dict[str, Any] = {
            "sourceType": envelope["sourceType"],
            "sourceRef": envelope["sourceRef"],
            "mimeType": envelope.get("mimeType", "application/octet-stream"),
        }
        if isinstance(body, bytes):
            json_body["body_b64"] = base64.b64encode(body).decode("ascii")
        else:
            json_body["body"] = body

        resp = await self._post("/v1/raw/ingest", json.dumps(json_body).encode("utf-8"))
        resp.raise_for_status()
        result: dict[str, Any] = resp.json()
        return result
