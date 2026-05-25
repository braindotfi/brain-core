/**
 * P1.2 — defense-in-depth: the MCP surface must NEVER expose payment execution.
 *
 * Execution is Brain-internal behind the §6 gate; the MCP surface is propose-only
 * (`payment_intent.propose`, `agent.action.propose`). A regression that added an
 * execute tool — or the payment_intent:execute capability — would be
 * catastrophic. This test locks that down and snapshots the exposed surface so
 * any tool addition requires an explicit, reviewed snapshot update.
 */

import { describe, expect, it } from "vitest";
import { ALL_TOOLS } from "./registry.js";

describe("MCP tool registry — no execution surface (P1.2)", () => {
  it("exposes no tool whose name contains or ends with 'execute'", () => {
    const offenders = ALL_TOOLS.filter(
      (t) => t.name.includes(".execute") || /execute$/.test(t.name) || t.name.includes("execute"),
    ).map((t) => t.name);
    expect(offenders).toEqual([]);
  });

  it("the capability set does not include payment_intent:execute", () => {
    const capabilities = new Set(ALL_TOOLS.flatMap((t) => t.requiredScopes));
    expect(capabilities.has("payment_intent:execute")).toBe(false);
    // No scope should grant any execute verb on payments.
    const executeScopes = [...capabilities].filter((s) => /payment.*:execute$/.test(s));
    expect(executeScopes).toEqual([]);
  });

  it("snapshots the exposed tool list (additions require explicit review)", () => {
    const names = ALL_TOOLS.map((t) => t.name).sort();
    expect(names).toMatchSnapshot();
  });
});
