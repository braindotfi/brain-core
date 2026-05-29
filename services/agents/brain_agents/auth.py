"""Inbound auth dependency for the /run/* routes.

Shared HMAC: every request must carry
  X-Brain-Auth: sha256=hex(hmac_sha256(secret, body))

The secret is configured via BRAIN_AGENTS_INBOUND_SECRET. The Brain api
(the only legitimate caller) computes the same digest over the same body
before invoking. Without this, anyone on the brain-agents network could
trigger an LLM run (cost burn) or use the configured BrainApiClient token
to propose actions against the Brain api.

In NODE_ENV / BRAIN_ENV=production the secret is REQUIRED at boot — if
it's absent, every request 503's with `agents_auth_unconfigured`, so a
misconfigured deployment fails closed (the route refuses every request)
rather than fails open (silently accepts unauthenticated requests).

For local development: leave the env var unset, set
BRAIN_AGENTS_ALLOW_UNAUTHENTICATED=true (only honored when
BRAIN_ENV != "production"), and the dependency is a no-op.
"""

from __future__ import annotations

import hmac
import os
from hashlib import sha256

from fastapi import HTTPException, Request, status

HEADER = "X-Brain-Auth"
PREFIX = "sha256="


def _is_production() -> bool:
    return (
        os.environ.get("BRAIN_ENV", "").lower() == "production"
        or os.environ.get("NODE_ENV", "").lower() == "production"
    )


def _allow_unauthenticated() -> bool:
    if _is_production():
        return False
    return os.environ.get("BRAIN_AGENTS_ALLOW_UNAUTHENTICATED", "").lower() == "true"


def expected_signature(secret: str, body: bytes) -> str:
    """Compute the canonical signature value for a request body."""
    digest = hmac.new(secret.encode("utf-8"), body, sha256).hexdigest()
    return PREFIX + digest


def verify_signature(secret: str, body: bytes, header_value: str | None) -> bool:
    """Constant-time compare; returns False on shape error."""
    if header_value is None or not header_value.startswith(PREFIX):
        return False
    expected = expected_signature(secret, body)
    return hmac.compare_digest(expected, header_value)


async def require_inbound_auth(request: Request) -> None:
    """FastAPI dependency: rejects unauthenticated/forged requests."""
    if _allow_unauthenticated():
        return  # dev override

    secret = os.environ.get("BRAIN_AGENTS_INBOUND_SECRET", "")
    if secret == "":
        # Fail-closed: in production the absence of a secret means every
        # request 503's rather than every request being accepted.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "agents_auth_unconfigured",
                "message": (
                    "BRAIN_AGENTS_INBOUND_SECRET is unset; refusing every request. "
                    "Set the env var (Brain api uses the same value to sign requests)."
                ),
            },
        )

    body = await request.body()
    header_value = request.headers.get(HEADER)
    if not verify_signature(secret, body, header_value):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "agents_auth_invalid",
                "message": (
                    f"Missing or invalid {HEADER} HMAC. "
                    "Compute sha256=hex(hmac_sha256(BRAIN_AGENTS_INBOUND_SECRET, body))."
                ),
            },
        )
