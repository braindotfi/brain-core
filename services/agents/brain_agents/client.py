"""HTTP client for the Brain API."""

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
