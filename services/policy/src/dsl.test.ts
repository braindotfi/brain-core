import { describe, expect, it } from "vitest";
import { allowedActionsFor, canonicalize, contentHashHex } from "./dsl.js";

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
