import { describe, expect, it } from "vitest";
import { listResources, parseBrainUri } from "./resources.js";

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

describe("listResources", () => {
  it("declares the v0.3 surface", () => {
    const r = listResources();
    const uris = r.resources.map((d) => d.uri);
    expect(uris).toContain("brain://ledger/accounts/{account_id}");
    expect(uris).toContain("brain://wiki/pages/{slug}");
    expect(uris).toContain("brain://proofs/{action_id}");
    expect(r.resources.length).toBe(6);
  });
});
