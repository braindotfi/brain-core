"""Cross-language equivalence vector for the v2 X-Brain-Service-Auth HMAC.

The TS canonical implementation (shared/src/http/service-auth.ts's
computeServiceAuthSignatureV2, verified by
shared/src/http/service-auth.test.ts) must produce this exact signature for
this exact (secret, timestamp, write_tenant, body) tuple. A mismatch here
means the two implementations have drifted -- exactly the class of bug that
made brain_agents.client speak a stale v1 scheme against the v2 server after
F4 (the client signed body-only while the server verified body+timestamp+
tenant, so every cross-tenant write silently fell back to the wrong tenant
instead of erroring).
"""

from brain_agents.service_auth import compute_service_auth_signature_v2


def test_matches_the_pinned_ts_vector() -> None:
    secret = "test-vector-shared-secret"
    timestamp = "1735689600"
    write_tenant = "tnt_01HQZVECTOR0000000000000"
    body = (
        b'{"parser":"doc_obligation_v1","parser_version":"1.0.0",' b'"extracted":{"amount":"1.00"}}'
    )

    signature = compute_service_auth_signature_v2(secret, timestamp, write_tenant, body)

    assert signature == (
        "sha256v2=998607fb16a025f944c6ff0dd307228b7648cf96db56add20f75e083b11acfe6"
    )
