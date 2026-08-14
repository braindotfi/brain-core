import { describe, expect, it } from "vitest";
import {
  listResources,
  listResourceTemplates,
  parseBrainUri,
  requiredScopesForBrainUri,
} from "./resources.js";

describe("parseBrainUri", () => {
  it("parses ledger account uris", () => {
    expect(parseBrainUri("brain://ledger/accounts/acct_X")).toEqual({
      kind: "ledger.account",
      id: "acct_X",
    });
  });
  it("parses ledger transaction uris", () => {
    expect(parseBrainUri("brain://ledger/transactions/tx_X")).toEqual({
      kind: "ledger.transaction",
      id: "tx_X",
    });
  });
  it("parses payment-intent uris (kebab-case path)", () => {
    expect(parseBrainUri("brain://ledger/payment-intents/pi_X")).toEqual({
      kind: "ledger.payment_intent",
      id: "pi_X",
    });
  });
  it("parses wiki page uris", () => {
    expect(parseBrainUri("brain://wiki/pages/some-slug")).toEqual({
      kind: "wiki.page",
      id: "some-slug",
    });
  });
  it("parses the collection-level payments action-types catalog uri", () => {
    expect(parseBrainUri("brain://payments/action_types")).toEqual({
      kind: "payments.action_types",
      id: "",
    });
    expect(parseBrainUri("brain://payments/action_types/")).toEqual({
      kind: "payments.action_types",
      id: "",
    });
  });
  it("parses proof uris (2-segment)", () => {
    expect(parseBrainUri("brain://proofs/act_X")).toEqual({ kind: "proof", id: "act_X" });
    expect(parseBrainUri("brain://proofs/act_X/")).toEqual({ kind: "proof", id: "act_X" });
  });
  it("returns null for proof uri missing id", () => {
    expect(parseBrainUri("brain://proofs/")).toBeNull();
  });
  it("strips trailing slash", () => {
    expect(parseBrainUri("brain://ledger/accounts/acct_X/")).toEqual({
      kind: "ledger.account",
      id: "acct_X",
    });
    expect(parseBrainUri("brain://ledger/accounts/acct_X///")).toEqual({
      kind: "ledger.account",
      id: "acct_X",
    });
    expect(parseBrainUri("brain://")).toBeNull();
  });
  it("does not backtrack on a long slash run", () => {
    // The trailing-slash trim used to be `.replace(/\/+$/, "")`, which is
    // unanchored and therefore quadratic: every start position re-walks the
    // whole slash run before `$` fails against the trailing non-slash. `uri`
    // is caller-supplied, so this was a free way to burn CPU in the MCP
    // server. The index scan that replaced it is linear.
    const started = Date.now();
    expect(parseBrainUri(`brain://${"/".repeat(200_000)}x`)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });
  it("returns null for unknown collection", () => {
    expect(parseBrainUri("brain://ledger/widgets/widget_1")).toBeNull();
  });
  it("returns null for non-brain scheme", () => {
    expect(parseBrainUri("https://example.com/x")).toBeNull();
  });
  it("returns null for missing id", () => {
    expect(parseBrainUri("brain://ledger/accounts/")).toBeNull();
  });
});

describe("requiredScopesForBrainUri (BRAIN-96)", () => {
  it("derives the same scope readResource would return, without touching a service", () => {
    expect(requiredScopesForBrainUri("brain://ledger/accounts/acct_X")).toEqual(["ledger:read"]);
    expect(requiredScopesForBrainUri("brain://ledger/payment-intents/pi_X")).toEqual([
      "ledger:read",
    ]);
    expect(requiredScopesForBrainUri("brain://wiki/pages/some-slug")).toEqual(["wiki:read"]);
    expect(requiredScopesForBrainUri("brain://payments/action_types")).toEqual([
      "payment_intent:propose",
    ]);
    expect(requiredScopesForBrainUri("brain://proofs/act_X")).toEqual(["audit:read"]);
  });

  it("returns null for a URI shape parseBrainUri does not recognize", () => {
    expect(requiredScopesForBrainUri("brain://ledger/widgets/widget_1")).toBeNull();
    expect(requiredScopesForBrainUri("https://example.com/x")).toBeNull();
  });
});

describe("listResources", () => {
  it("returns only genuinely readable, concrete resources (BRAIN-102)", () => {
    // Templated URIs (a literal backtick-quoted placeholder segment) belong in
    // resources/templates/list instead -- a generic client that reads a
    // resources/list entry literally would otherwise call
    // resources/read("brain://ledger/accounts/{account_id}") and get back
    // ledger_row_not_found for an id that was never real.
    const r = listResources();
    const uris = r.resources.map((d) => d.uri);
    expect(uris).toEqual(["brain://payments/action_types"]);
    for (const uri of uris) {
      expect(uri).not.toContain("{");
    }
  });
});

describe("listResourceTemplates", () => {
  it("declares the six templated v0.3 resources (BRAIN-102)", () => {
    const r = listResourceTemplates();
    const templates = r.resourceTemplates.map((d) => d.uriTemplate);
    expect(templates).toContain("brain://ledger/accounts/{account_id}");
    expect(templates).toContain("brain://ledger/transactions/{transaction_id}");
    expect(templates).toContain("brain://ledger/obligations/{obligation_id}");
    expect(templates).toContain("brain://ledger/payment-intents/{id}");
    expect(templates).toContain("brain://wiki/pages/{slug}");
    expect(templates).toContain("brain://proofs/{action_id}");
    expect(r.resourceTemplates.length).toBe(6);
    for (const uriTemplate of templates) {
      expect(uriTemplate).toContain("{");
    }
  });
});
