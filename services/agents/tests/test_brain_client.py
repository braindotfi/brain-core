"""Unit tests for BrainApiClient response parsing.

The anomaly scheduler shipped a parse bug: the Ledger route returns
{ transactions: [...] } but the client read `items` / `data`. In production
that means every scheduled scan saw an empty list and silently skipped.
These tests pin the real response shape so the bug cannot recur.
"""

import base64
import json
from typing import Any

import httpx
import pytest
import respx

from brain_agents.client import BrainApiClient

BASE = "http://localhost:3001"
TOKEN = "test-token"
TENANT = "tnt_01TESTAAAAAAAAAAAAAAAAAA"


async def test_list_recent_transactions_reads_the_ledger_response_shape() -> None:
    """services/ledger/src/routes/index.ts returns
    { transactions: result.items, next_cursor: ... } — the client MUST read
    the `transactions` key, not `items` / `data`.
    """
    canonical: dict[str, Any] = {
        "transactions": [
            {"id": "tx_1", "amount": "10.00", "currency": "USD"},
            {"id": "tx_2", "amount": "20.00", "currency": "USD"},
        ],
        "next_cursor": None,
    }
    with respx.mock() as mock:
        mock.get(f"{BASE}/v1/ledger/transactions").respond(200, json=canonical)
        client = BrainApiClient(BASE, TOKEN)
        result = await client.list_recent_transactions(TENANT, limit=100)
    assert [r["id"] for r in result] == ["tx_1", "tx_2"]


async def test_list_recent_transactions_legacy_items_fallback() -> None:
    """Forwards-compat: if a hypothetical older route returns `items`,
    the client still parses it (so a future ledger route rename never
    silently breaks the scheduler again)."""
    legacy: dict[str, Any] = {"items": [{"id": "tx_legacy"}]}
    with respx.mock() as mock:
        mock.get(f"{BASE}/v1/ledger/transactions").respond(200, json=legacy)
        client = BrainApiClient(BASE, TOKEN)
        result = await client.list_recent_transactions(TENANT, limit=10)
    assert [r["id"] for r in result] == ["tx_legacy"]


async def test_list_recent_transactions_empty_when_no_known_key() -> None:
    """Defensive: an unrecognized payload yields [], not a crash."""
    with respx.mock() as mock:
        mock.get(f"{BASE}/v1/ledger/transactions").respond(200, json={"unrelated": "x"})
        client = BrainApiClient(BASE, TOKEN)
        result = await client.list_recent_transactions(TENANT, limit=10)
    assert result == []


async def test_list_recent_transactions_passes_tenant_and_auth_headers() -> None:
    seen_headers: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen_headers.update(dict(request.headers))
        return httpx.Response(200, json={"transactions": []})

    with respx.mock() as mock:
        mock.get(f"{BASE}/v1/ledger/transactions").mock(side_effect=handler)
        client = BrainApiClient(BASE, TOKEN)
        await client.list_recent_transactions(TENANT, limit=25)

    assert seen_headers.get("authorization") == f"Bearer {TOKEN}"
    assert seen_headers.get("x-brain-tenant") == TENANT


async def test_propose_hits_execution_endpoint_with_expected_body() -> None:
    captured_body: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured_body.update(json.loads(request.content.decode("utf-8")))
        return httpx.Response(200, json={"id": "prop_01TEST", "status": "pending"})

    with respx.mock() as mock:
        mock.post(f"{BASE}/v1/execution/propose").mock(side_effect=handler)
        client = BrainApiClient(BASE, TOKEN)
        await client.propose({"kind": "payment", "amount": "5.00"}, "agent_01TEST")

    assert captured_body["agent_id"] == "agent_01TEST"
    assert captured_body["action"]["amount"] == "5.00"


async def test_raw_ingest_encodes_bytes_body_as_base64() -> None:
    captured_body: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured_body.update(json.loads(request.content.decode("utf-8")))
        return httpx.Response(200, json={"rawId": "raw_01TEST"})

    payload_bytes = b'{"transaction_id":"tx_1"}'
    with respx.mock() as mock:
        mock.post(f"{BASE}/v1/raw/ingest").mock(side_effect=handler)
        client = BrainApiClient(BASE, TOKEN)
        await client.raw_ingest(
            {
                "sourceType": "anomaly_finding",
                "sourceRef": "tnt_x:tx_1",
                "mimeType": "application/json",
                "body": payload_bytes,
            }
        )

    assert captured_body["sourceType"] == "anomaly_finding"
    assert captured_body["sourceRef"] == "tnt_x:tx_1"
    assert captured_body["mimeType"] == "application/json"
    # bytes ⇒ base64 wire encoding
    assert captured_body["body_b64"] == base64.b64encode(payload_bytes).decode("ascii")
    assert "body" not in captured_body


async def test_raw_ingest_inlines_str_body_verbatim() -> None:
    captured_body: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured_body.update(json.loads(request.content.decode("utf-8")))
        return httpx.Response(200, json={"rawId": "raw_01TEST"})

    with respx.mock() as mock:
        mock.post(f"{BASE}/v1/raw/ingest").mock(side_effect=handler)
        client = BrainApiClient(BASE, TOKEN)
        await client.raw_ingest(
            {
                "sourceType": "text",
                "sourceRef": "ref_1",
                "mimeType": "text/plain",
                "body": "hello world",
            }
        )

    assert captured_body["body"] == "hello world"
    assert "body_b64" not in captured_body


@pytest.mark.parametrize("status", [400, 404, 500])
async def test_list_recent_transactions_raises_on_non_2xx(status: int) -> None:
    with respx.mock() as mock:
        mock.get(f"{BASE}/v1/ledger/transactions").respond(status, json={"error": "x"})
        client = BrainApiClient(BASE, TOKEN)
        with pytest.raises(httpx.HTTPStatusError):
            await client.list_recent_transactions(TENANT, limit=10)
