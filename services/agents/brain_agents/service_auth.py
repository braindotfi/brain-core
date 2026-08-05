"""Outbound X-Brain-Service-Auth v2 HMAC (F4/F2).

Signs BrainApiClient's trusted-service POST calls (post_parsed,
propose) that carry a caller-supplied tenant-redirect. This is a
different concern from auth.py's X-Brain-Auth (which authenticates the
Brain api as the caller of THIS service's own /run/* routes and carries
no tenant-redirect header) -- do not conflate the two, and do not reuse
auth.py's expected_signature/verify_signature for this scheme.

Byte-for-byte mirror of the TypeScript canonical implementation in
shared/src/http/service-auth.ts (computeServiceAuthSignatureV2 /
verifyServiceAuthSignatureV2), which services/raw/src/routes/parsed.ts
and services/execution/src/routes.ts both verify against. See that
module's header comment for the full v2 header contract:

  X-Brain-Service-Timestamp: <unix seconds, decimal string, generated
      fresh per request -- never cached or reused>
  X-Brain-Write-Tenant: <target tenant id, or omit the header entirely to
      write into the caller's own JWT tenant>
  X-Brain-Service-Auth: sha256v2=<hex HMAC-SHA256 of
      `${timestamp}.${writeTenant}.` (writeTenant = "" when the header is
      omitted) followed by the raw, exact request body bytes, keyed by the
      shared secret>

A pinned cross-language vector proving this stays byte-for-byte identical
to the TS side lives in services/agents/tests/test_service_auth.py /
shared/src/http/service-auth.test.ts.
"""

from __future__ import annotations

import hmac
from hashlib import sha256

PREFIX_V2 = "sha256v2="
REPLAY_WINDOW_SECONDS = 300


def compute_service_auth_signature_v2(
    secret: str, timestamp: str, write_tenant: str, body: bytes
) -> str:
    """`${timestamp}.${writeTenant}.` (write_tenant = "" for "no redirect
    requested") followed by the raw request body bytes, HMAC-SHA256'd with
    the shared secret. Must match shared/src/http/service-auth.ts's
    computeServiceAuthSignatureV2 exactly.
    """
    mac = hmac.new(secret.encode("utf-8"), digestmod=sha256)
    mac.update(f"{timestamp}.{write_tenant}.".encode())
    mac.update(body)
    return PREFIX_V2 + mac.hexdigest()
