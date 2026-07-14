"""HTTP client for the Brain API."""

import base64
import json
from typing import Any

import httpx

from brain_agents.auth import expected_signature


class BrainApiClient:
    def __init__(self, base_url: str, token: str, service_secret: str = "") -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._service_secret = service_secret

    async def propose(self, action: dict[str, Any], agent_id: str) -> dict[str, Any]:
        """POST /v1/execution/propose and return the ProposalRecord."""
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{self._base_url}/v1/execution/propose",
                json={"action": action, "agent_id": agent_id},
                headers={"Authorization": f"Bearer {self._token}"},
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
        headers = {
            "Authorization": f"Bearer {self._token}",
            "Content-Type": "application/json",
        }
        if tenant_id is not None and self._service_secret != "":
            headers["X-Brain-Write-Tenant"] = tenant_id
            headers["X-Brain-Service-Auth"] = expected_signature(self._service_secret, body_bytes)

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{self._base_url}/v1/raw/{raw_id}/parsed",
                content=body_bytes,
                headers=headers,
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
