"""Tests for the inbound HMAC auth dependency on Python /run/* routes."""

from collections.abc import AsyncGenerator
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from brain_agents.anomaly.agent import AnomalyAgent
from brain_agents.auth import expected_signature, verify_signature
from brain_agents.client import BrainApiClient
from brain_agents.deps import AppDeps
from brain_agents.document_extractor.agent import DocumentExtractorAgent
from brain_agents.payment.agent import PaymentAgent
from brain_agents.plaid_extractor.agent import PlaidExtractorAgent
from brain_agents.reconciliation.agent import ReconciliationAgent
from brain_agents.server import create_app

SECRET = "test-shared-secret"


def _deps() -> AppDeps:
    recon = AsyncMock(spec=ReconciliationAgent)
    recon.analyze.return_value = {"kind": "reconciliation"}
    brain = AsyncMock(spec=BrainApiClient)
    brain.propose.return_value = {
        "id": "prop_01TEST",
        "proposing_agent_id": "agent_01TEST",
        "action": {"kind": "reconciliation"},
        "policy_decision_id": "dec_01TEST",
        "status": "pending",
        "approvers_signed": [],
        "created_at": "2025-01-01T00:00:00Z",
    }
    return AppDeps(
        brain_client=brain,
        recon_agent=recon,
        payment_agent=AsyncMock(spec=PaymentAgent),
        anomaly_agent=AsyncMock(spec=AnomalyAgent),
        plaid_extractor_agent=MagicMock(spec=PlaidExtractorAgent),
        document_extractor_agent=AsyncMock(spec=DocumentExtractorAgent),
    )


@pytest.fixture
async def app_client(monkeypatch: pytest.MonkeyPatch) -> AsyncGenerator[httpx.AsyncClient, None]:
    monkeypatch.setenv("BRAIN_AGENTS_INBOUND_SECRET", SECRET)
    monkeypatch.setenv("BRAIN_ENV", "production")
    monkeypatch.delenv("BRAIN_AGENTS_ALLOW_UNAUTHENTICATED", raising=False)
    app = create_app(deps=_deps())
    app.state.deps = _deps()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),  # type: ignore[arg-type]
        base_url="http://test",
    ) as c:
        yield c


# ---------------------------------------------------------------------------
# Pure signature helpers
# ---------------------------------------------------------------------------


def test_expected_signature_is_stable_for_the_same_body() -> None:
    body = b'{"k":"v"}'
    a = expected_signature(SECRET, body)
    b = expected_signature(SECRET, body)
    assert a == b
    assert a.startswith("sha256=")


def test_verify_signature_rejects_a_different_body() -> None:
    a = expected_signature(SECRET, b'{"a":1}')
    assert verify_signature(SECRET, b'{"a":1}', a)
    assert not verify_signature(SECRET, b'{"a":2}', a)


def test_verify_signature_rejects_missing_prefix() -> None:
    body = b"x"
    digest = expected_signature(SECRET, body)[len("sha256=") :]
    assert verify_signature(SECRET, body, "sha256=" + digest)
    assert not verify_signature(SECRET, body, digest)  # missing prefix
    assert not verify_signature(SECRET, body, None)


# ---------------------------------------------------------------------------
# Route-level behavior under the dependency
# ---------------------------------------------------------------------------


async def test_unauthenticated_request_rejected_in_production(
    app_client: httpx.AsyncClient,
) -> None:
    resp = await app_client.post(
        "/run/reconciliation",
        json={"agent_id": "agent_x", "action": {}, "tenant_id": "tnt_x"},
    )
    assert resp.status_code == 401
    body = resp.json()
    assert body["detail"]["code"] == "agents_auth_invalid"


async def test_invalid_signature_rejected(app_client: httpx.AsyncClient) -> None:
    resp = await app_client.post(
        "/run/reconciliation",
        headers={"X-Brain-Auth": "sha256=00" * 32},
        json={"agent_id": "agent_x", "action": {}, "tenant_id": "tnt_x"},
    )
    assert resp.status_code == 401


async def test_valid_signature_accepted(app_client: httpx.AsyncClient) -> None:
    payload = b'{"agent_id":"agent_x","action":{},"tenant_id":"tnt_x"}'
    resp = await app_client.post(
        "/run/reconciliation",
        headers={
            "X-Brain-Auth": expected_signature(SECRET, payload),
            "content-type": "application/json",
        },
        content=payload,
    )
    assert resp.status_code == 200


async def test_health_route_is_not_gated(app_client: httpx.AsyncClient) -> None:
    """The /health probe must remain reachable for liveness checks."""
    resp = await app_client.get("/health")
    assert resp.status_code == 200


def test_missing_secret_in_production_fails_at_boot(monkeypatch: pytest.MonkeyPatch) -> None:
    """create_app() refuses to construct the FastAPI app when the secret
    is unset in production. The orchestrator (k8s, ECS, etc.) will surface
    this as a CrashLoopBackoff rather than a quiet wave of 503s."""
    monkeypatch.delenv("BRAIN_AGENTS_INBOUND_SECRET", raising=False)
    monkeypatch.setenv("BRAIN_ENV", "production")
    monkeypatch.delenv("BRAIN_AGENTS_ALLOW_UNAUTHENTICATED", raising=False)
    with pytest.raises(RuntimeError, match="BRAIN_AGENTS_INBOUND_SECRET is required"):
        create_app(deps=_deps())


def test_boot_succeeds_in_production_when_secret_is_set(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BRAIN_AGENTS_INBOUND_SECRET", SECRET)
    monkeypatch.setenv("BRAIN_ENV", "production")
    # Should NOT raise.
    app = create_app(deps=_deps())
    assert app is not None


def test_dev_override_ignored_in_production_at_boot(monkeypatch: pytest.MonkeyPatch) -> None:
    """BRAIN_AGENTS_ALLOW_UNAUTHENTICATED must NOT bypass the boot fence."""
    monkeypatch.delenv("BRAIN_AGENTS_INBOUND_SECRET", raising=False)
    monkeypatch.setenv("BRAIN_ENV", "production")
    monkeypatch.setenv("BRAIN_AGENTS_ALLOW_UNAUTHENTICATED", "true")
    with pytest.raises(RuntimeError, match="BRAIN_AGENTS_INBOUND_SECRET is required"):
        create_app(deps=_deps())


async def test_dev_override_allows_unauthenticated(monkeypatch: pytest.MonkeyPatch) -> None:
    """Outside production, no secret + override=true ⇒ open routes (dev path)."""
    monkeypatch.delenv("BRAIN_AGENTS_INBOUND_SECRET", raising=False)
    monkeypatch.setenv("BRAIN_ENV", "development")
    monkeypatch.setenv("BRAIN_AGENTS_ALLOW_UNAUTHENTICATED", "true")
    app = create_app(deps=_deps())
    app.state.deps = _deps()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),  # type: ignore[arg-type]
        base_url="http://test",
    ) as c:
        resp = await c.post(
            "/run/reconciliation",
            json={"agent_id": "agent_x", "action": {}, "tenant_id": "tnt_x"},
        )
    assert resp.status_code == 200


async def test_every_run_route_is_gated(app_client: httpx.AsyncClient) -> None:
    """All four /run/* routes must require auth — peer review's coverage demand."""
    paths = ["/run/reconciliation", "/run/payment", "/run/anomaly", "/run/plaid_extract"]
    for p in paths:
        resp = await app_client.post(p, json={})
        assert resp.status_code in (
            401,
            422,
        ), f"{p} returned {resp.status_code}; expected 401 auth or 422 schema, never 200"
