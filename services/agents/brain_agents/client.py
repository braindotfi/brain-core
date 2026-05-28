"""HTTP client for the Brain API."""

import base64
from typing import Any

import httpx


class BrainApiClient:
    def __init__(self, base_url: str, token: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token

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
