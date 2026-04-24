import { describe, expect, it } from "vitest";
import {
  ID_PREFIX,
  brainId,
  isBrainId,
  newAgentId,
  newAuditEventId,
  newExecutionId,
  newPolicyId,
  newProposalId,
  newRequestId,
  newTenantId,
  newTokenId,
  newUserId,
  parseBrainId,
} from "./ids.js";

const ULID_LEN = 26;

describe("brainId", () => {
  it("returns a {prefix}_{ulid} string for every kind", () => {
    for (const [kind, prefix] of Object.entries(ID_PREFIX)) {
      const id = brainId(prefix);
      expect(id.startsWith(`${prefix}_`), `kind=${kind}`).toBe(true);
      expect(id.slice(prefix.length + 1)).toHaveLength(ULID_LEN);
    }
  });

  it("monotonically generates distinct ULIDs within the same ms", () => {
    const ids = new Set(Array.from({ length: 100 }, () => brainId("req")));
    expect(ids.size).toBe(100);
  });
});

describe("convenience generators", () => {
  it("each uses its expected prefix", () => {
    expect(newTenantId().startsWith("tnt_")).toBe(true);
    expect(newUserId().startsWith("user_")).toBe(true);
    expect(newAgentId().startsWith("agent_")).toBe(true);
    expect(newTokenId().startsWith("token_")).toBe(true);
    expect(newRequestId().startsWith("req_")).toBe(true);
    expect(newAuditEventId().startsWith("evt_")).toBe(true);
    expect(newProposalId().startsWith("prop_")).toBe(true);
    expect(newExecutionId().startsWith("exec_")).toBe(true);
    expect(newPolicyId().startsWith("pol_")).toBe(true);
  });
});

describe("parseBrainId", () => {
  it("splits prefix and ulid for a valid id", () => {
    const id = newRequestId();
    const parsed = parseBrainId(id);
    expect(parsed).not.toBeNull();
    expect(parsed?.prefix).toBe("req");
    expect(parsed?.ulid).toHaveLength(ULID_LEN);
  });

  it("rejects missing underscore", () => {
    expect(parseBrainId("notanid")).toBeNull();
  });

  it("rejects empty prefix", () => {
    expect(parseBrainId("_01HQ7K3ABCDEFGHJKMNPQRSTV")).toBeNull();
  });

  it("rejects trailing empty part", () => {
    expect(parseBrainId("req_")).toBeNull();
  });

  it("rejects non-ULID body (lower-case letters)", () => {
    expect(parseBrainId("req_abcdefghijklmnopqrstuvwxyz")).toBeNull();
  });

  it("rejects ULID body with disallowed characters (I, L, O, U)", () => {
    expect(parseBrainId("req_01HQ7K3IIIIIIIIIIIIIIIII")).toBeNull();
    expect(parseBrainId("req_01HQ7K3LLLLLLLLLLLLLLLLL")).toBeNull();
    expect(parseBrainId("req_01HQ7K3OOOOOOOOOOOOOOOOO")).toBeNull();
    expect(parseBrainId("req_01HQ7K3UUUUUUUUUUUUUUUUU")).toBeNull();
  });
});

describe("isBrainId", () => {
  it("accepts matching prefix", () => {
    expect(isBrainId(newTenantId(), "tnt")).toBe(true);
  });
  it("rejects mismatched prefix", () => {
    expect(isBrainId(newTenantId(), "req")).toBe(false);
  });
  it("rejects malformed IDs", () => {
    expect(isBrainId("bogus", "tnt")).toBe(false);
  });
});
