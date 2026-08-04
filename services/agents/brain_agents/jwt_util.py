"""Read JWT claims without verifying the signature.

Verification is the API's job; the agents only ever need to read a claim out
of a token they already hold (to say something useful before it lapses, or to
know which tenant it is scoped to) or to reason about whether it is still
usable. Shared by server.py (boot-time expiry check) and client.py (runtime
refresh, RFC F4) -- a leaf module so client.py can import it without a cycle
through server.py (which imports BrainApiClient from client.py).
"""

from __future__ import annotations

import base64
import binascii
import json

_JWT_SEGMENTS = 3


def jwt_claims(token: str) -> dict[str, object] | None:
    """Return the decoded claims of `token`, or None if it is not a readable JWT."""
    parts = token.split(".")
    if len(parts) != _JWT_SEGMENTS:
        return None
    payload = parts[1]
    try:
        decoded = base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))
        claims = json.loads(decoded)
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return None
    return claims if isinstance(claims, dict) else None


def jwt_expiry_epoch(token: str) -> int | None:
    """Return the `exp` claim, or None when unreadable / absent."""
    claims = jwt_claims(token)
    if claims is None:
        return None
    exp = claims.get("exp")
    return exp if isinstance(exp, int) else None


def jwt_tenant_id(token: str) -> str | None:
    """Return the `tenant_id` claim (shared/src/auth/jwt.ts's claim name), or None."""
    claims = jwt_claims(token)
    if claims is None:
        return None
    tenant_id = claims.get("tenant_id")
    return tenant_id if isinstance(tenant_id, str) and tenant_id != "" else None
