"""FastAPI application factory for brain-agents."""

import base64
import binascii
import json
import logging
import os
import time
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI
from openai import AsyncOpenAI

from brain_agents.anomaly.agent import AnomalyAgent
from brain_agents.anomaly.routes import router as anomaly_router
from brain_agents.anomaly.scheduler import AnomalyScheduler, SchedulerConfig
from brain_agents.client import BrainApiClient
from brain_agents.config import settings
from brain_agents.deps import AppDeps
from brain_agents.document_extractor.agent import DocumentExtractorAgent
from brain_agents.document_extractor.routes import router as document_router
from brain_agents.payment.agent import PaymentAgent
from brain_agents.payment.routes import router as payment_router
from brain_agents.plaid_extractor.agent import PlaidExtractorAgent
from brain_agents.plaid_extractor.routes import router as plaid_router
from brain_agents.reconciliation.agent import ReconciliationAgent
from brain_agents.reconciliation.routes import router as recon_router


def _is_production() -> bool:
    return (
        os.environ.get("BRAIN_ENV", "").lower() == "production"
        or os.environ.get("NODE_ENV", "").lower() == "production"
    )


def _assert_inbound_auth_configured() -> None:
    """Fail at boot in production when BRAIN_AGENTS_INBOUND_SECRET is unset.

    Without this, the misconfigured deploy 503's every request — operationally
    much noisier than failing fast at process start (k8s won't roll the new
    pod over the old one if the new one cannot start). Honors the same dev
    override the per-request check honors.
    """
    if not _is_production():
        return
    if os.environ.get("BRAIN_AGENTS_INBOUND_SECRET", "") == "":
        raise RuntimeError(
            "BRAIN_AGENTS_INBOUND_SECRET is required in BRAIN_ENV=production. "
            "The api side computes the same HMAC over the request body before "
            "calling /run/* endpoints; without the secret every request 401's. "
            "Refusing to start so the orchestrator surfaces the misconfiguration."
        )


def _assert_runtime_credentials_configured() -> None:
    """Fail at boot in production when the agents' outbound credentials are unset.

    OPENAI_API_KEY backs every reasoning call and BRAIN_API_TOKEN authenticates
    the agents to the Brain API. Both default to "" (see config.Settings); a
    deploy that forgets them would boot, report healthy, then fail every actual
    run. Surface the misconfiguration at process start instead. Honors the same
    production gate as the inbound-secret fence (dev/test boot unaffected).
    """
    if not _is_production():
        return
    missing = [
        name for name in ("OPENAI_API_KEY", "BRAIN_API_TOKEN") if os.environ.get(name, "") == ""
    ]
    if missing:
        raise RuntimeError(
            f"{', '.join(missing)} required in BRAIN_ENV=production. "
            "OPENAI_API_KEY backs every reasoning call; BRAIN_API_TOKEN "
            "authenticates the agents to the Brain API. Refusing to start so "
            "the orchestrator surfaces the misconfiguration rather than failing "
            "every request at runtime."
        )


_TOKEN_EXPIRY_WARN_SECONDS = 30 * 24 * 60 * 60
_JWT_SEGMENTS = 3

_log = logging.getLogger(__name__)


def _jwt_expiry_epoch(token: str) -> int | None:
    """Read the `exp` claim out of a JWT without verifying its signature.

    Verification is the API's job; the agents only need the claim in order to
    say something useful before it lapses. Returns None when the token is not a
    readable JWT, so an opaque or malformed credential degrades to "cannot
    tell" rather than blocking boot on a parsing detail.
    """
    parts = token.split(".")
    if len(parts) != _JWT_SEGMENTS:
        return None
    payload = parts[1]
    try:
        decoded = base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))
        claims = json.loads(decoded)
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return None
    exp = claims.get("exp") if isinstance(claims, dict) else None
    return exp if isinstance(exp, int) else None


def _assert_api_token_not_expired() -> None:
    """Refuse to boot on an already-expired BRAIN_API_TOKEN, warn when it nears.

    An expired token does not stop the service from starting or reporting
    healthy; it fails only at the moment a document extraction tries to write
    its result back, as an upstream 401. That is the most expensive place to
    discover it, because the model call has already been paid for. Checking the
    claim at boot moves the discovery to deploy time, and the warning window
    gives an operator a month of notice before extraction breaks.

    Mirrors the surrounding fences: production only, so dev and test boot are
    unaffected.
    """
    if not _is_production():
        return
    token = os.environ.get("BRAIN_API_TOKEN", "")
    if token == "":
        return  # already covered by _assert_runtime_credentials_configured
    exp = _jwt_expiry_epoch(token)
    if exp is None:
        return  # not a readable JWT; nothing trustworthy to assert
    remaining = exp - int(time.time())
    if remaining <= 0:
        raise RuntimeError(
            "BRAIN_API_TOKEN expired at "
            f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(exp))}. "
            "Every document extraction would run, cost a model call, then fail "
            "when the Brain API rejects the write-back with 401. Refusing to "
            "start so the deploy surfaces this instead of the job queue."
        )
    if remaining <= _TOKEN_EXPIRY_WARN_SECONDS:
        _log.warning(
            "BRAIN_API_TOKEN expires in %d day(s), at %s. Mint a replacement "
            "before then or document extraction will begin failing.",
            remaining // 86400,
            time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(exp)),
        )


def create_app(deps: AppDeps | None = None) -> FastAPI:
    """Return a configured FastAPI app. Pass `deps` to skip live wiring (tests)."""
    # Fail-fast boot fences — must run BEFORE FastAPI is constructed so a
    # misconfigured deploy never serves a single request, not even /health.
    _assert_inbound_auth_configured()
    # Outbound credentials are only consumed on the live-wiring path (deps is
    # None). Tests inject deps and never construct the OpenAI/Brain clients, so
    # the fence would be a false positive there.
    if deps is None:
        _assert_runtime_credentials_configured()
        _assert_api_token_not_expired()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
        scheduler: AnomalyScheduler | None = None
        if deps is not None:
            app.state.deps = deps
        else:
            openai_client = AsyncOpenAI(api_key=settings.openai_api_key)
            brain_client = BrainApiClient(
                settings.brain_api_base_url,
                settings.brain_api_token,
                settings.brain_agents_inbound_secret,
            )
            anomaly_agent = AnomalyAgent(openai_client, settings.openai_model)
            app.state.deps = AppDeps(
                brain_client=brain_client,
                recon_agent=ReconciliationAgent(openai_client, settings.openai_model),
                payment_agent=PaymentAgent(openai_client, settings.openai_model),
                anomaly_agent=anomaly_agent,
                plaid_extractor_agent=PlaidExtractorAgent(),
                document_extractor_agent=DocumentExtractorAgent(
                    openai_client,
                    settings.openai_model,
                    ocr_model=settings.openai_ocr_model,
                ),
            )
            # Anomaly scheduler (autopilot). Stays dormant when no tenant ids
            # are configured, matching the agent's advisory-only contract.
            raw_tenants = settings.brain_anomaly_scan_tenants.strip()
            tenants: tuple[str, ...] = (
                tuple(t.strip() for t in raw_tenants.split(",") if t.strip()) if raw_tenants else ()
            )
            scheduler = AnomalyScheduler(
                anomaly_agent,
                brain_client,
                SchedulerConfig(
                    interval_seconds=settings.brain_anomaly_scan_interval_seconds,
                    tenants=tenants,
                    batch_size=settings.brain_anomaly_scan_batch_size,
                ),
            )
            scheduler.start()
        try:
            yield
        finally:
            if scheduler is not None:
                await scheduler.stop()

    application = FastAPI(
        title="Brain Agents",
        version="0.1.0",
        lifespan=lifespan,
    )
    application.include_router(recon_router)
    application.include_router(payment_router)
    application.include_router(anomaly_router)
    application.include_router(plaid_router)
    application.include_router(document_router)

    @application.get("/health")
    async def health() -> dict[str, Any]:
        return {"ok": True, "service": "brain-agents"}

    return application


app = create_app()
