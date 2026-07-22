import { describe, expect, it } from "vitest";
import { newTenantId, newUserId } from "../ids.js";
import { canonicalize, hashEvent, stableStringify } from "./hash.js";
import type { AuditEventInput } from "./types.js";

describe("stableStringify", () => {
  it("sorts keys alphabetically", () => {
    expect(stableStringify({ b: 1, a: 2 } as unknown as Record<string, number>)).toBe(
      `{"a":2,"b":1}`,
    );
  });
  it("preserves array order", () => {
    expect(stableStringify([3, 1, 2])).toBe("[3,1,2]");
  });
  it("emits no whitespace", () => {
    expect(stableStringify({ a: 1, b: [{ c: 2 }] })).toBe(`{"a":1,"b":[{"c":2}]}`);
  });
  it("handles null, booleans, and strings with escapes", () => {
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(true)).toBe("true");
    expect(stableStringify(`line\nwith\tescapes`)).toBe(`"line\\nwith\\tescapes"`);
  });
});

describe("canonicalize + hashEvent", () => {
  const base: AuditEventInput = {
    tenantId: newTenantId(),
    layer: "raw",
    actor: newUserId(),
    action: "raw.ingest",
    inputs: { sha256: "abcd", source: "plaid" },
    outputs: { raw_id: "raw_1", deduplicated: false },
  };

  it("produces a 64-char hex digest", () => {
    const hash = hashEvent({
      event: base,
      id: "evt_01HQ7K3",
      createdAt: "2026-04-24T00:00:00.000Z",
      prevEventHash: null,
    });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for identical inputs", () => {
    const h1 = hashEvent({
      event: base,
      id: "evt_1",
      createdAt: "2026-04-24T00:00:00.000Z",
      prevEventHash: null,
    });
    const h2 = hashEvent({
      event: base,
      id: "evt_1",
      createdAt: "2026-04-24T00:00:00.000Z",
      prevEventHash: null,
    });
    expect(h1).toBe(h2);
  });

  it("changes when prev_event_hash changes (chain integrity)", () => {
    const a = hashEvent({
      event: base,
      id: "evt_1",
      createdAt: "2026-04-24T00:00:00.000Z",
      prevEventHash: null,
    });
    const b = hashEvent({
      event: base,
      id: "evt_1",
      createdAt: "2026-04-24T00:00:00.000Z",
      prevEventHash: "0".repeat(64),
    });
    expect(a).not.toBe(b);
  });

  it("is order-independent for keys in nested inputs/outputs", () => {
    const a = hashEvent({
      event: { ...base, inputs: { a: 1, b: { x: 2, y: 3 } } },
      id: "evt_1",
      createdAt: "2026-04-24T00:00:00.000Z",
      prevEventHash: null,
    });
    const b = hashEvent({
      event: { ...base, inputs: { b: { y: 3, x: 2 }, a: 1 } },
      id: "evt_1",
      createdAt: "2026-04-24T00:00:00.000Z",
      prevEventHash: null,
    });
    expect(a).toBe(b);
  });

  it("includes action + layer in canonical form", () => {
    const canon = canonicalize({
      event: base,
      id: "evt_1",
      createdAt: "2026-04-24T00:00:00.000Z",
      prevEventHash: null,
    });
    expect(canon).toContain(`"action":"raw.ingest"`);
    expect(canon).toContain(`"layer":"raw"`);
  });

  it("includes audit classification in canonical form", () => {
    const canon = canonicalize({
      event: { ...base, eventType: "assistant_activity", severity: "info" },
      id: "evt_1",
      createdAt: "2026-04-24T00:00:00.000Z",
      prevEventHash: null,
    });
    expect(canon).toContain(`"event_type":"assistant_activity"`);
    expect(canon).toContain(`"severity":"info"`);
  });

  it("serializes missing policy_version as null", () => {
    const canon = canonicalize({
      event: base,
      id: "evt_1",
      createdAt: "2026-04-24T00:00:00.000Z",
      prevEventHash: null,
    });
    expect(canon).toContain(`"policy_version":null`);
  });

  it("includes native policy report fields in canonical form", () => {
    const canon = canonicalize({
      event: { ...base, policyCheckId: "rule_1", outcome: "allow" },
      id: "evt_1",
      createdAt: "2026-04-24T00:00:00.000Z",
      prevEventHash: null,
    });
    expect(canon).toContain(`"policy_check_id":"rule_1"`);
    expect(canon).toContain(`"outcome":"allow"`);
  });
});
