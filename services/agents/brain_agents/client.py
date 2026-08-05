"""HTTP client for the Brain API."""

import asyncio
import base64
import json
import logging
import time
from typing import Any

import httpx

from brain_agents.jwt_util import jwt_expiry_epoch, jwt_tenant_id
from brain_agents.service_auth import compute_service_auth_signature_v2

_log = logging.getLogger(__name__)

# Proactively refresh BRAIN_API_TOKEN once it is within this many seconds of
# its `exp` claim, rather than waiting for it to fail with a 401 (F4). Small
# relative to server.py's 30-day boot-time warning window -- this is the
# runtime safety net, not the primary signal an operator should rely on.
_REFRESH_MARGIN_SECONDS = 60 * 60
_HTTP_UNAUTHORIZED = 401


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
        token: str,
        service_secret: str = "",
        platform_service_secret: str = "",
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._service_secret = service_secret
        # F4: return-or-rotate token refresh. See _refresh_token.
        self._platform_service_secret = platform_service_secret
        self._refresh_lock = asyncio.Lock()

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

    def _refresh_configured(self) -> bool:
        return self._platform_service_secret != ""

    async def _maybe_refresh_before_call(self) -> None:
        """Proactively refresh self._token when it is expired or close to it.

        No-op when refresh isn't configured (back-compat: the static token
        is used forever, matching pre-F4 behavior) or when the current
        token isn't a readable JWT (nothing to judge expiry from).
        """
        if not self._refresh_configured():
            return
        exp = jwt_expiry_epoch(self._token)
        if exp is not None and exp - time.time() > _REFRESH_MARGIN_SECONDS:
            return
        await self._refresh_token()

    async def _refresh_token(self) -> bool:
        """Mint-or-return a live agent token for self._token's own tenant via
        the return-or-rotate POST /v1/tenants/{tenant_id}/agent-token route,
        and swap it in.

        Returns True on a successful swap, False on any reason it could not
        (not configured, unreadable token, non-2xx response, unexpected
        response shape) -- a refresh failure never raises, so it degrades to
        "keep using the token we have" rather than crashing an in-flight
        request. It is still logged loudly (never silent) so an operator can
        see refresh is broken instead of only ever seeing the downstream 401.
        """
        if not self._refresh_configured():
            return False
        tenant_id = jwt_tenant_id(self._token)
        if tenant_id is None:
            _log.warning(
                "BRAIN_API_TOKEN refresh skipped: current token is not a "
                "readable JWT, so its tenant cannot be determined."
            )
            return False
        async with self._refresh_lock:
            try:
                async with httpx.AsyncClient(timeout=30.0) as client:
                    resp = await client.post(
                        f"{self._base_url}/v1/tenants/{tenant_id}/agent-token",
                        json={},
                        headers={
                            "X-Platform-Service-Auth": self._platform_service_secret,
                            "Content-Type": "application/json",
                        },
                    )
                resp.raise_for_status()
                new_token = resp.json().get("token")
            except (httpx.HTTPError, ValueError) as exc:
                _log.warning("BRAIN_API_TOKEN refresh request failed: %s", exc)
                return False
            if isinstance(new_token, str) and new_token != "":
                self._token = new_token
                return True
            _log.warning("BRAIN_API_TOKEN refresh response carried no usable token")
            return False

    async def _post(
        self,
        path: str,
        body_bytes: bytes,
        extra_headers: dict[str, str] | None = None,
    ) -> httpx.Response:
        """POST body_bytes with a fresh Authorization header.

        Proactively refreshes first (F4); if the attempt still 401's and
        refresh is configured, refreshes once more and retries exactly once
        -- the proactive check covers the common case, this covers the token
        expiring in the gap between the check and the request landing.
        """

        async def _attempt() -> httpx.Response:
            headers = {
                "Authorization": f"Bearer {self._token}",
                "Content-Type": "application/json",
                **(extra_headers or {}),
            }
            async with httpx.AsyncClient(timeout=30.0) as client:
                return await client.post(
                    f"{self._base_url}{path}", content=body_bytes, headers=headers
                )

        await self._maybe_refresh_before_call()
        resp = await _attempt()
        if resp.status_code == _HTTP_UNAUTHORIZED and await self._refresh_token():
            resp = await _attempt()
        return resp

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
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                f"{self._base_url}/v1/ledger/transactions",
                params={"limit": limit},
                headers={
                    "Authorization": f"Bearer {self._token}",
                    "X-Brain-Tenant": tenant_id,
                },
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

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{self._base_url}/v1/raw/ingest",
                json=json_body,
                headers={"Authorization": f"Bearer {self._token}"},
            )
            resp.raise_for_status()
            result: dict[str, Any] = resp.json()
            return result
