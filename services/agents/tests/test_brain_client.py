"""Unit tests for BrainApiClient response parsing.

The anomaly scheduler shipped a parse bug: the Ledger route returns
{ transactions: [...] } but the client read `items` / `data`. In production
that means every scheduled scan saw an empty list and silently skipped.
These tests pin the real response shape so the bug cannot recur.
"""

import base64
import json
import time
from typing import Any

import httpx
import pytest
import respx

from brain_agents.client import BrainApiClient, TenantBindingUnavailableError
from brain_agents.service_auth import compute_service_auth_signature_v2

BASE = "http://localhost:3001"
TOKEN = "test-token"
TENANT = "tnt_01TESTAAAAAAAAAAAAAAAAAA"


def _jwt(exp: int, tenant_id: str = TENANT) -> str:
    """Build a structurally valid JWT carrying `exp` and `tenant_id` claims.
    The signature is never verified by this code path (jwt_util.py reads
    claims only), so a placeholder is enough."""
    payload = (
        base64.urlsafe_b64encode(json.dumps({"exp": exp, "tenant_id": tenant_id}).encode())
        .decode()
        .rstrip("=")
    )
    return f"header.{payload}.signature"


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
        client = BrainApiClient(BASE, TOKEN, service_secret="shared-secret")
        await client.propose({"kind": "payment", "amount": "5.00"}, "agent_01TEST", TENANT)

    assert captured_body["agent_id"] == "agent_01TEST"
    assert captured_body["action"]["amount"] == "5.00"


async def test_propose_forwards_signed_tenant_header_when_service_secret_configured() -> None:
    """Same trust model as post_parsed: propose proves tenant_id via a
    body-bound HMAC, never a raw secret over the wire."""
    seen_headers: dict[str, str] = {}
    seen_body: bytes = b""

    def handler(request: httpx.Request) -> httpx.Response:
        seen_headers.update(dict(request.headers))
        nonlocal seen_body
        seen_body = request.content
        return httpx.Response(200, json={"id": "prop_01TEST", "status": "pending"})

    with respx.mock() as mock:
        mock.post(f"{BASE}/v1/execution/propose").mock(side_effect=handler)
        client = BrainApiClient(BASE, TOKEN, service_secret="shared-secret")
        await client.propose({"kind": "reconciliation"}, "agent_01TEST", "tnt_x")

    assert seen_headers.get("x-brain-write-tenant") == "tnt_x"
    assert seen_headers.get("x-brain-service-auth") != "shared-secret"
    timestamp = seen_headers["x-brain-service-timestamp"]
    assert seen_headers.get("x-brain-service-auth") == compute_service_auth_signature_v2(
        "shared-secret", timestamp, "tnt_x", seen_body
    )


async def test_propose_fails_closed_without_service_secret() -> None:
    """RFC F2 regression: propose() must refuse to run rather than default to
    the static token's own tenant when it cannot prove the tenant binding.
    This must fail against pre-fix client.py (propose() had no tenant_id
    parameter and never raised)."""
    client = BrainApiClient(BASE, TOKEN)
    with pytest.raises(TenantBindingUnavailableError):
        await client.propose({"kind": "reconciliation"}, "agent_01TEST", TENANT)


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


async def test_post_parsed_hits_raw_parsed_endpoint_with_expected_body() -> None:
    captured: dict[str, Any] = {}
    captured_url: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content.decode("utf-8")))
        captured_url["url"] = str(request.url)
        return httpx.Response(201, json={"id": "prs_01TEST", "created": True})

    raw_id = "raw_01TESTAAAAAAAAAAAAAAAAAA"
    with respx.mock() as mock:
        mock.post(f"{BASE}/v1/raw/{raw_id}/parsed").mock(side_effect=handler)
        client = BrainApiClient(BASE, TOKEN)
        result = await client.post_parsed(
            raw_id=raw_id,
            parser="doc_obligation_v1",
            parser_version="1.0.0",
            extracted={"counterparty_name": "Acme", "amount": "10.00"},
            confidence=0.4,
        )

    assert captured_url["url"] == f"{BASE}/v1/raw/{raw_id}/parsed"
    assert captured["parser"] == "doc_obligation_v1"
    assert captured["parser_version"] == "1.0.0"
    assert captured["extracted"]["counterparty_name"] == "Acme"
    assert captured["confidence"] == 0.4
    assert result["id"] == "prs_01TEST"


async def test_post_parsed_omits_confidence_when_none() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content.decode("utf-8")))
        return httpx.Response(201, json={"id": "prs_01TEST"})

    raw_id = "raw_01TESTBBBBBBBBBBBBBBBBBB"
    with respx.mock() as mock:
        mock.post(f"{BASE}/v1/raw/{raw_id}/parsed").mock(side_effect=handler)
        client = BrainApiClient(BASE, TOKEN)
        await client.post_parsed(
            raw_id=raw_id,
            parser="doc_obligation_v1",
            parser_version="1.0.0",
            extracted={"amount": "10.00"},
        )

    assert "confidence" not in captured


async def test_post_parsed_forwards_signed_tenant_header_when_service_secret_configured() -> None:
    """With a service_secret AND a tenant_id, post_parsed proves the caller
    to the api side via an HMAC over the exact request body (never the raw
    secret itself) so the write can land in the caller's own tenant instead
    of the static agent JWT's golden tenant."""
    seen_headers: dict[str, str] = {}
    seen_body: bytes = b""

    def handler(request: httpx.Request) -> httpx.Response:
        seen_headers.update(dict(request.headers))
        nonlocal seen_body
        seen_body = request.content
        return httpx.Response(201, json={"id": "prs_01TEST"})

    raw_id = "raw_01TESTCCCCCCCCCCCCCCCCCC"
    with respx.mock() as mock:
        mock.post(f"{BASE}/v1/raw/{raw_id}/parsed").mock(side_effect=handler)
        client = BrainApiClient(BASE, TOKEN, service_secret="shared-secret")
        await client.post_parsed(
            raw_id=raw_id,
            parser="doc_obligation_v1",
            parser_version="1.0.0",
            extracted={"amount": "10.00"},
            tenant_id="tnt_x",
        )

    assert seen_headers.get("x-brain-write-tenant") == "tnt_x"
    # The raw secret must never appear on the wire, only a signature bound
    # to the exact body sent.
    assert seen_headers.get("x-brain-service-auth") != "shared-secret"
    timestamp = seen_headers["x-brain-service-timestamp"]
    assert seen_headers.get("x-brain-service-auth") == compute_service_auth_signature_v2(
        "shared-secret", timestamp, "tnt_x", seen_body
    )


async def test_post_parsed_omits_tenant_headers_when_tenant_id_not_given() -> None:
    """Back-compat: a configured service_secret alone must not add headers
    unless the caller actually names a tenant_id."""
    seen_headers: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen_headers.update(dict(request.headers))
        return httpx.Response(201, json={"id": "prs_01TEST"})

    raw_id = "raw_01TESTDDDDDDDDDDDDDDDDDD"
    with respx.mock() as mock:
        mock.post(f"{BASE}/v1/raw/{raw_id}/parsed").mock(side_effect=handler)
        client = BrainApiClient(BASE, TOKEN, service_secret="shared-secret")
        await client.post_parsed(
            raw_id=raw_id,
            parser="doc_obligation_v1",
            parser_version="1.0.0",
            extracted={"amount": "10.00"},
        )

    assert "x-brain-write-tenant" not in seen_headers
    assert "x-brain-service-auth" not in seen_headers


async def test_post_parsed_omits_tenant_headers_when_no_service_secret_configured() -> None:
    """Back-compat: passing tenant_id without a configured service_secret must
    not leak the tenant header (the api side would ignore it anyway, but the
    client should not send an unproven header)."""
    seen_headers: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen_headers.update(dict(request.headers))
        return httpx.Response(201, json={"id": "prs_01TEST"})

    raw_id = "raw_01TESTEEEEEEEEEEEEEEEEEE"
    with respx.mock() as mock:
        mock.post(f"{BASE}/v1/raw/{raw_id}/parsed").mock(side_effect=handler)
        client = BrainApiClient(BASE, TOKEN)
        await client.post_parsed(
            raw_id=raw_id,
            parser="doc_obligation_v1",
            parser_version="1.0.0",
            extracted={"amount": "10.00"},
            tenant_id="tnt_x",
        )

    assert "x-brain-write-tenant" not in seen_headers
    assert "x-brain-service-auth" not in seen_headers


# ---------------------------------------------------------------------------
# RFC F4: BRAIN_API_TOKEN refresh
# ---------------------------------------------------------------------------


async def test_post_parsed_proactively_refreshes_a_near_expiry_token() -> None:
    """A token inside the refresh margin of its exp claim is swapped for a
    fresh one BEFORE the call is made, rather than waiting to fail with a
    401 first."""
    old_token = _jwt(int(time.time()) + 60)  # inside the 1h refresh margin
    new_token = _jwt(int(time.time()) + 30 * 86400)
    seen_auth: list[str] = []

    def refresh_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"token": new_token})

    def parsed_handler(request: httpx.Request) -> httpx.Response:
        seen_auth.append(request.headers.get("authorization", ""))
        return httpx.Response(201, json={"id": "prs_01TEST"})

    raw_id = "raw_01TESTFFFFFFFFFFFFFFFFFF"
    with respx.mock() as mock:
        mock.post(f"{BASE}/v1/tenants/{TENANT}/agent-token").mock(side_effect=refresh_handler)
        mock.post(f"{BASE}/v1/raw/{raw_id}/parsed").mock(side_effect=parsed_handler)
        client = BrainApiClient(BASE, old_token, platform_service_secret="platform-secret")
        await client.post_parsed(
            raw_id=raw_id, parser="doc_obligation_v1", parser_version="1.0.0", extracted={}
        )

    assert seen_auth == [f"Bearer {new_token}"]


async def test_post_parsed_retries_once_after_401_when_refresh_configured() -> None:
    """A token that isn't near expiry yet but still 401's (already expired
    server-side, or revoked) is retried exactly once after a refresh."""
    live_token = _jwt(int(time.time()) + 30 * 86400)
    new_token = _jwt(int(time.time()) + 31 * 86400)  # distinct exp so the two JWTs differ
    attempts: list[str] = []

    def refresh_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"token": new_token})

    def parsed_handler(request: httpx.Request) -> httpx.Response:
        auth = request.headers.get("authorization", "")
        attempts.append(auth)
        if auth == f"Bearer {live_token}":
            return httpx.Response(401, json={"error": "expired"})
        return httpx.Response(201, json={"id": "prs_01TEST"})

    raw_id = "raw_01TESTGGGGGGGGGGGGGGGGGG"
    with respx.mock() as mock:
        mock.post(f"{BASE}/v1/tenants/{TENANT}/agent-token").mock(side_effect=refresh_handler)
        mock.post(f"{BASE}/v1/raw/{raw_id}/parsed").mock(side_effect=parsed_handler)
        client = BrainApiClient(BASE, live_token, platform_service_secret="platform-secret")
        result = await client.post_parsed(
            raw_id=raw_id, parser="doc_obligation_v1", parser_version="1.0.0", extracted={}
        )

    assert attempts == [f"Bearer {live_token}", f"Bearer {new_token}"]
    assert result["id"] == "prs_01TEST"


async def test_post_parsed_401_propagates_when_refresh_not_configured() -> None:
    """Back-compat: without platform_service_secret, a 401 behaves exactly as
    before this change -- no refresh attempt, no retry."""
    raw_id = "raw_01TESTHHHHHHHHHHHHHHHHHH"
    with respx.mock() as mock:
        mock.post(f"{BASE}/v1/raw/{raw_id}/parsed").respond(401, json={"error": "expired"})
        client = BrainApiClient(BASE, TOKEN)
        with pytest.raises(httpx.HTTPStatusError):
            await client.post_parsed(
                raw_id=raw_id, parser="doc_obligation_v1", parser_version="1.0.0", extracted={}
            )


@pytest.mark.parametrize("status", [400, 404, 500])
async def test_list_recent_transactions_raises_on_non_2xx(status: int) -> None:
    with respx.mock() as mock:
        mock.get(f"{BASE}/v1/ledger/transactions").respond(status, json={"error": "x"})
        client = BrainApiClient(BASE, TOKEN)
        with pytest.raises(httpx.HTTPStatusError):
            await client.list_recent_transactions(TENANT, limit=10)
