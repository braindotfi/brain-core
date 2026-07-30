import { describe, expect, it } from "vitest";
import { allowedActionsFor, canonicalize, contentHashHex, type PolicyDocument } from "./dsl.js";

describe("canonicalize", () => {
  it("is key-order independent", () => {
    const a = canonicalize({
      version: 1,
      rules: [
        {
          id: "r",
          applies_to: ["any"],
          when: { "amount.lte": { currency: "USD", value: "10" } },
          execute: "auto",
        },
      ],
    });
    const b = canonicalize({
      rules: [
        {
          execute: "auto",
          applies_to: ["any"],
          id: "r",
          when: { "amount.lte": { value: "10", currency: "USD" } },
        },
      ],
      version: 1,
    });
    expect(a).toBe(b);
  });
});

describe("contentHashHex", () => {
  it("is a stable 64-char hex digest", () => {
    const hex = contentHashHex({ version: 1, rules: [] });
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(hex).toBe(contentHashHex({ version: 1, rules: [] }));
  });
  it("changes when the document changes", () => {
    const a = contentHashHex({ version: 1, rules: [] });
    const b = contentHashHex({ version: 2, rules: [] });
    expect(a).not.toBe(b);
  });
  it("covers agent_actions in the signed hash (H-23)", () => {
    const a = contentHashHex({ version: 1, rules: [] });
    const b = contentHashHex({
      version: 1,
      rules: [],
      agent_actions: { payment: ["pay_invoice"] },
    });
    expect(a).not.toBe(b);
  });
});

describe("contentHashHex -- migration 0006 pin (H-P0-4)", () => {
  it("hashes the migration 0006 default document to the hash that migration recomputed and hardcoded", () => {
    // services/policy/migrations/0006_default_policy_agent_action_review.sql
    // upgrades every already-active default policy to this exact document and
    // stores this exact hash. If a future change to canonicalize() ever
    // altered this value, every live upgraded tenant would fail
    // getActive()'s read-time hash verification (repository.ts) and start
    // denying every gate call -- this test exists so that change fails here
    // in CI instead of in production.
    const migratedDoc = {
      version: 1,
      rules: [
        {
          id: "default-money-requires-confirmation",
          applies_to: ["outbound_payment", "onchain_tx"],
          when: { "agent.confidence.gte": 0.6 },
          execute: "confirm",
          require: "single_signer",
        },
        {
          id: "default-agent-action-requires-review",
          applies_to: ["agent_action"],
          when: { "agent.confidence.gte": 0.6 },
          execute: "confirm",
          require: "single_signer",
        },
        {
          id: "default-non-money-confidence-floor",
          applies_to: ["inbound_payment", "ledger_write"],
          when: { "agent.confidence.gte": 0.6 },
          execute: "auto",
        },
      ],
    };
    expect(contentHashHex(migratedDoc as PolicyDocument)).toBe(
      "253834354481d08401efabbe4e0ed643b60d9f5a80169ed9440f05fd25401d6e",
    );
  });
});

describe("allowedActionsFor (H-23)", () => {
  const doc = {
    version: 1,
    rules: [],
    agent_actions: { payment: ["pay_invoice", "pay_obligation"] },
  };
  it("returns the listed actions for a known agent", () => {
    expect(allowedActionsFor(doc, "payment")).toEqual(["pay_invoice", "pay_obligation"]);
  });
  it("returns [] for an agent with no entry (fail-closed)", () => {
    expect(allowedActionsFor(doc, "savings")).toEqual([]);
  });
  it("returns [] when agent_actions is absent entirely", () => {
    expect(allowedActionsFor({ version: 1, rules: [] }, "payment")).toEqual([]);
  });
});
