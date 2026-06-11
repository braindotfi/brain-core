import { describe, expect, it } from "vitest";
import { capabilityHash, computeAgentScopeHash } from "./capability.js";
import { PAYMENT_AGENT_SCOPES } from "../auth/scopes.js";

describe("capabilityHash", () => {
  it("matches the known keccak256 vector for the empty string", () => {
    // keccak256("") — canonical Ethereum empty-input hash.
    expect(capabilityHash("")).toBe(
      "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    );
  });

  it("returns a 0x-prefixed 32-byte lowercase hex string", () => {
    expect(capabilityHash("collections_followup")).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    expect(capabilityHash("treasury_sweep")).toBe(capabilityHash("treasury_sweep"));
  });

  it("distinguishes different capabilities", () => {
    expect(capabilityHash("collections_followup")).not.toBe(capabilityHash("treasury_sweep"));
  });
});

describe("computeAgentScopeHash", () => {
  it("is the keccak256 of the scopes sorted and joined with '|'", () => {
    const scopes = ["wiki:read", "ledger:read"];
    expect(computeAgentScopeHash(scopes)).toBe(capabilityHash("ledger:read|wiki:read"));
  });

  it("is order-independent (sorts before hashing)", () => {
    expect(computeAgentScopeHash(["b:read", "a:read", "c:read"])).toBe(
      computeAgentScopeHash(["c:read", "a:read", "b:read"]),
    );
  });

  it("pins the payment-agent scope hash (drift guard for seed ↔ on-chain ↔ auth)", () => {
    // This value is committed on-chain by scripts/ops/register-prod-agent.ts and
    // into agents.scope_hash by the demo seed. If this assertion changes, the
    // golden agent must be re-registered on-chain or MCP auth fails closed.
    expect(computeAgentScopeHash(PAYMENT_AGENT_SCOPES)).toBe(
      "0xe5c560b489fa55c2a55066435093cf43a818e91b1f573b5be27c9df64571a9d4",
    );
  });
});
