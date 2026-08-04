import { describe, expect, it } from "vitest";
import { computeServiceAuthSignatureV2 } from "./service-auth.js";

/**
 * Cross-language equivalence vector for the v2 X-Brain-Service-Auth HMAC.
 * The Python signer (services/agents/brain_agents/service_auth.py) must
 * produce this exact signature for this exact (secret, timestamp,
 * write_tenant, body) tuple -- see
 * services/agents/tests/test_service_auth.py for the mirrored assertion.
 * A mismatch here means the two implementations have drifted, which is
 * exactly the class of bug that made brain_agents.client speak a stale v1
 * scheme against the v2 server after F4.
 */
describe("computeServiceAuthSignatureV2 cross-language vector", () => {
  it("matches the pinned Python vector", () => {
    const secret = "test-vector-shared-secret";
    const timestamp = "1735689600";
    const writeTenant = "tnt_01HQZVECTOR0000000000000";
    const body = Buffer.from(
      JSON.stringify({
        parser: "doc_obligation_v1",
        parser_version: "1.0.0",
        extracted: { amount: "1.00" },
      }),
    );

    const signature = computeServiceAuthSignatureV2(secret, timestamp, writeTenant, body);

    expect(signature).toBe(
      "sha256v2=998607fb16a025f944c6ff0dd307228b7648cf96db56add20f75e083b11acfe6",
    );
  });
});
