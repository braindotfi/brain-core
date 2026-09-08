"""Unit tests for BrainApiClient response parsing.

The anomaly scheduler shipped a parse bug: the Ledger route returns
{ transactions: [...] } but the client read `items` / `data`. In production
that means every scheduled scan saw an empty list and silently skipped.
These tests pin the real response shape so the bug cannot recur.
"""

import asyncio
import base64
import json
import time
from typing import Any

import httpx
import pytest
import respx

from brain_agents.client import (
    AgentTokenExchangeError,
    AgentTokenManager,
    BrainApiClient,
    TenantBindingUnavailableError,
)
from brain_agents.service_auth import compute_service_auth_signature_v2

BASE = "http://localhost:3001"
TOKEN = "test-token"
TENANT = "tnt_01TESTAAAAAAAAAAAAAAAAAA"


TOKEN_URL = "http://localhost:3003/token"
RESOURCE = "https://api.brain.fi/"
AGENT_KEY = "brain_ak_test_agkey_01TEST_secret"  # gitleaks:allow


def _agent_jwt(
    *,
    now: int,
    suffix: str = "1",
    expires_in: int = 300,
    audience: str = RESOURCE,
) -> str:
    """Build the exchange claim shape; API verification remains authoritative."""
    payload = (
        base64.urlsafe_b64encode(
            json.dumps(
                {
                    "iss": "https://auth.brain.fi",
                    "aud": audience,
                    "sub": "agent_01TESTAAAAAAAAAAAAAAAA",
                    "tenant_id": TENANT,
                    "principal_type": "agent",
                    "credential_id": "agkey_01TESTAAAAAAAAAAAAAA",
                    "scopes": ["raw:write"],
                    "iat": now,
                    "exp": now + expires_in,
                    "jti": f"token_{suffix}",
                }
            ).encode()
        )
        .decode()
        .rstrip("=")
    )
    return f"header.{payload}.signature"


def _exchange_response(token: str, *, expires_in: int = 300) -> dict[str, object]:
    return {
        "access_token": token,
        "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
        "token_type": "Bearer",
        "expires_in": expires_in,
        "scope": "raw:write",
    }


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
# Agent API key exchange
# ---------------------------------------------------------------------------


async def test_start_exchanges_exact_rfc_8693_form_and_caches_token() -> None:
    now = int(time.time())
    token = _agent_jwt(now=now)
    seen_form: dict[str, str] = {}
    seen_auth: list[str] = []

    def exchange_handler(request: httpx.Request) -> httpx.Response:
        seen_form.update(dict(httpx.QueryParams(request.content.decode())))
        return httpx.Response(200, json=_exchange_response(token))

    def parsed_handler(request: httpx.Request) -> httpx.Response:
        seen_auth.append(request.headers.get("authorization", ""))
        return httpx.Response(201, json={"id": "prs_01TEST"})

    raw_id = "raw_01TESTFFFFFFFFFFFFFFFFFF"
    with respx.mock() as mock:
        exchange = mock.post(TOKEN_URL).mock(side_effect=exchange_handler)
        mock.post(f"{BASE}/v1/raw/{raw_id}/parsed").mock(side_effect=parsed_handler)
        client = BrainApiClient(
            BASE,
            agent_api_key=AGENT_KEY,
            auth_token_url=TOKEN_URL,
            api_resource=RESOURCE,
        )
        await client.start()
        await client.post_parsed(
            raw_id=raw_id, parser="doc_obligation_v1", parser_version="1.0.0", extracted={}
        )

    assert exchange.call_count == 1
    assert seen_auth == [f"Bearer {token}"]
    assert seen_form == {
        "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
        "subject_token": AGENT_KEY,
        "subject_token_type": "urn:brain:params:oauth:token-type:agent-api-key",
        "requested_token_type": "urn:ietf:params:oauth:token-type:access_token",
        "resource": RESOURCE,
        "scope": "raw:write",
    }


async def test_post_parsed_retries_exactly_once_after_401_in_agent_key_mode() -> None:
    now = int(time.time())
    first_token = _agent_jwt(now=now, suffix="first")
    second_token = _agent_jwt(now=now, suffix="second")
    attempts: list[str] = []
    exchanged = [first_token, second_token]

    def exchange_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_exchange_response(exchanged.pop(0)))

    def parsed_handler(request: httpx.Request) -> httpx.Response:
        auth = request.headers.get("authorization", "")
        attempts.append(auth)
        if auth == f"Bearer {first_token}":
            return httpx.Response(401, json={"error": "expired"})
        return httpx.Response(201, json={"id": "prs_01TEST"})

    raw_id = "raw_01TESTGGGGGGGGGGGGGGGGGG"
    with respx.mock() as mock:
        exchange = mock.post(TOKEN_URL).mock(side_effect=exchange_handler)
        mock.post(f"{BASE}/v1/raw/{raw_id}/parsed").mock(side_effect=parsed_handler)
        client = BrainApiClient(BASE, agent_api_key=AGENT_KEY, auth_token_url=TOKEN_URL)
        result = await client.post_parsed(
            raw_id=raw_id, parser="doc_obligation_v1", parser_version="1.0.0", extracted={}
        )

    assert exchange.call_count == 2
    assert attempts == [f"Bearer {first_token}", f"Bearer {second_token}"]
    assert result["id"] == "prs_01TEST"


async def test_static_token_401_behavior_is_unchanged() -> None:
    raw_id = "raw_01TESTHHHHHHHHHHHHHHHHHH"
    with respx.mock() as mock:
        route = mock.post(f"{BASE}/v1/raw/{raw_id}/parsed").respond(401, json={"error": "expired"})
        client = BrainApiClient(BASE, TOKEN)
        with pytest.raises(httpx.HTTPStatusError):
            await client.post_parsed(
                raw_id=raw_id, parser="doc_obligation_v1", parser_version="1.0.0", extracted={}
            )
    assert route.call_count == 1


async def test_agent_key_401_is_not_retried_more_than_once() -> None:
    now = int(time.time())
    exchanged = [
        _agent_jwt(now=now, suffix="first"),
        _agent_jwt(now=now, suffix="second"),
    ]
    raw_id = "raw_01TESTIIIIIIIIIIIIIIIIII"
    with respx.mock() as mock:
        exchange = mock.post(TOKEN_URL).mock(
            side_effect=lambda request: httpx.Response(
                200, json=_exchange_response(exchanged.pop(0))
            )
        )
        route = mock.post(f"{BASE}/v1/raw/{raw_id}/parsed").respond(401, json={"error": "denied"})
        client = BrainApiClient(BASE, agent_api_key=AGENT_KEY, auth_token_url=TOKEN_URL)
        with pytest.raises(httpx.HTTPStatusError):
            await client.post_parsed(
                raw_id=raw_id, parser="doc_obligation_v1", parser_version="1.0.0", extracted={}
            )
    assert exchange.call_count == 2
    assert route.call_count == 2


async def test_early_refresh_and_singleflight_coalesce_concurrent_calls() -> None:
    clock = [1_800_000_000]
    first = _agent_jwt(now=clock[0], suffix="first")
    second = _agent_jwt(now=clock[0] + 241, suffix="second")
    exchanged = [first, second]
    release_second = asyncio.Event()

    async def exchange_handler(request: httpx.Request) -> httpx.Response:
        token = exchanged.pop(0)
        if token == second:
            await release_second.wait()
        return httpx.Response(200, json=_exchange_response(token))

    manager = AgentTokenManager(
        agent_api_key=AGENT_KEY,
        token_url=TOKEN_URL,
        resource=RESOURCE,
        scope="raw:write",
        now=lambda: float(clock[0]),
    )
    with respx.mock() as mock:
        exchange = mock.post(TOKEN_URL).mock(side_effect=exchange_handler)
        assert await manager.get_access_token() == first
        clock[0] += 241
        calls = [asyncio.create_task(manager.get_access_token()) for _ in range(8)]
        await asyncio.sleep(0)
        release_second.set()
        assert await asyncio.gather(*calls) == [second] * 8
    assert exchange.call_count == 2


async def test_exchange_rejects_invalid_claims_without_caching() -> None:
    now = int(time.time())
    wrong_audience = _agent_jwt(now=now, audience="https://wrong.example/")
    with respx.mock() as mock:
        route = mock.post(TOKEN_URL).respond(200, json=_exchange_response(wrong_audience))
        manager = AgentTokenManager(
            agent_api_key=AGENT_KEY,
            token_url=TOKEN_URL,
            resource=RESOURCE,
            scope="raw:write",
        )
        with pytest.raises(AgentTokenExchangeError):
            await manager.start()
        with pytest.raises(AgentTokenExchangeError):
            await manager.get_access_token()
    assert route.call_count == 2


async def test_exchange_rejects_refresh_tokens() -> None:
    now = int(time.time())
    payload = _exchange_response(_agent_jwt(now=now))
    payload["refresh_token"] = "must-not-be-issued"
    with respx.mock() as mock:
        mock.post(TOKEN_URL).respond(200, json=payload)
        manager = AgentTokenManager(
            agent_api_key=AGENT_KEY,
            token_url=TOKEN_URL,
            resource=RESOURCE,
            scope="raw:write",
        )
        with pytest.raises(AgentTokenExchangeError):
            await manager.start()


def test_client_requires_one_unambiguous_credential_mode() -> None:
    with pytest.raises(ValueError, match="exactly one"):
        BrainApiClient(BASE)
    with pytest.raises(ValueError, match="exactly one"):
        BrainApiClient(BASE, TOKEN, agent_api_key=AGENT_KEY, auth_token_url=TOKEN_URL)
    with pytest.raises(ValueError, match="auth_token_url"):
        BrainApiClient(BASE, agent_api_key=AGENT_KEY)


@pytest.mark.parametrize("status", [400, 404, 500])
async def test_list_recent_transactions_raises_on_non_2xx(status: int) -> None:
    with respx.mock() as mock:
        mock.get(f"{BASE}/v1/ledger/transactions").respond(status, json={"error": "x"})
        client = BrainApiClient(BASE, TOKEN)
        with pytest.raises(httpx.HTTPStatusError):
            await client.list_recent_transactions(TENANT, limit=10)
