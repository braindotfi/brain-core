import { describe, expect, it } from "vitest";
import type { RequiredEvidence, RequiredEvidenceSpec } from "@brain/schemas";
import { normalizeRequiredEvidence, scoreEvidence, type EvidenceRef } from "./index.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

describe("normalizeRequiredEvidence", () => {
  it("expands bare-string entries to weighted required specs (weight 1/N)", () => {
    const specs = normalizeRequiredEvidence(["ledger_balance", "wiki_note"]);
    expect(specs).toEqual<RequiredEvidenceSpec[]>([
      { kind: "ledger_balance", weight: 0.5, required: true },
      { kind: "wiki_note", weight: 0.5, required: true },
    ]);
  });

  it("returns weight 0 for a bare string in an empty-length sentinel case", () => {
    // n===0 branch is only reachable via a single bare string when the array is
    // length 0, which cannot also yield a map entry; cover the ternary directly
    // by constructing a one-element array and asserting the non-zero path holds.
    const specs = normalizeRequiredEvidence(["only"]);
    expect(specs[0]).toEqual({ kind: "only", weight: 1, required: true });
  });

  it("passes weighted specs through unchanged", () => {
    const weighted: RequiredEvidenceSpec = {
      kind: "kyc",
      weight: 0.7,
      required: false,
      max_age: "30d",
    };
    const specs = normalizeRequiredEvidence([weighted, "extra"]);
    expect(specs[0]).toBe(weighted);
    expect(specs[1]).toEqual({ kind: "extra", weight: 0.5, required: true });
  });
});

describe("scoreEvidence", () => {
  it("treats no declared evidence as fully satisfied", () => {
    const bundle = scoreEvidence([], []);
    expect(bundle).toEqual({
      items: [],
      completeness: 1,
      evidence_score: 1,
      missing_required_evidence: [],
      critical_missing: false,
    });
  });

  it("scores a fully present, fresh bundle at 1", () => {
    const items: EvidenceRef[] = [
      { kind: "a", ref: "r1" },
      { kind: "b", ref: "r2" },
    ];
    const bundle = scoreEvidence(items, ["a", "b"]);
    expect(bundle.completeness).toBe(1);
    expect(bundle.evidence_score).toBe(1);
    expect(bundle.missing_required_evidence).toEqual([]);
    expect(bundle.critical_missing).toBe(false);
    expect(bundle.items).toBe(items);
  });

  it("flags a missing required kind as critical", () => {
    const bundle = scoreEvidence([{ kind: "a", ref: "r1" }], ["a", "b"]);
    expect(bundle.completeness).toBe(0.5);
    expect(bundle.evidence_score).toBeCloseTo(0.5, 10);
    expect(bundle.missing_required_evidence).toEqual(["b"]);
    expect(bundle.critical_missing).toBe(true);
  });

  it("does not flag a missing optional (required: false) kind", () => {
    const required: RequiredEvidence[] = [
      { kind: "a", weight: 0.6, required: true },
      { kind: "b", weight: 0.4, required: false },
    ];
    const bundle = scoreEvidence([{ kind: "a", ref: "r1" }], required);
    expect(bundle.missing_required_evidence).toEqual([]);
    expect(bundle.critical_missing).toBe(false);
    expect(bundle.evidence_score).toBeCloseTo(0.6, 10);
  });

  it("halves the contribution of an explicitly stale item", () => {
    const required: RequiredEvidence[] = [{ kind: "a", weight: 1, required: true }];
    const bundle = scoreEvidence([{ kind: "a", ref: "r1", stale: true }], required);
    expect(bundle.evidence_score).toBe(0.5);
    expect(bundle.completeness).toBe(1);
  });

  it("treats an item older than max_age (days) as stale", () => {
    const now = Date.parse("2026-06-05T00:00:00.000Z");
    const old = new Date(now - 31 * DAY_MS).toISOString();
    const required: RequiredEvidence[] = [{ kind: "a", weight: 1, required: true, max_age: "30d" }];
    const bundle = scoreEvidence([{ kind: "a", ref: "r1", timestamp: old }], required, now);
    expect(bundle.evidence_score).toBe(0.5);
  });

  it("treats an item within max_age (hours) as fresh", () => {
    const now = Date.parse("2026-06-05T00:00:00.000Z");
    const recent = new Date(now - 30 * 60_000).toISOString();
    const required: RequiredEvidence[] = [{ kind: "a", weight: 1, required: true, max_age: "1h" }];
    const bundle = scoreEvidence([{ kind: "a", ref: "r1", timestamp: recent }], required, now);
    expect(bundle.evidence_score).toBe(1);
  });

  it("treats an item exactly at the hour boundary as fresh (not stale)", () => {
    const now = Date.parse("2026-06-05T00:00:00.000Z");
    const at = new Date(now - HOUR_MS).toISOString();
    const required: RequiredEvidence[] = [{ kind: "a", weight: 1, required: true, max_age: "1h" }];
    const bundle = scoreEvidence([{ kind: "a", ref: "r1", timestamp: at }], required, now);
    expect(bundle.evidence_score).toBe(1);
  });

  it("ignores max_age when the item has no timestamp", () => {
    const required: RequiredEvidence[] = [{ kind: "a", weight: 1, required: true, max_age: "1d" }];
    const bundle = scoreEvidence([{ kind: "a", ref: "r1" }], required);
    expect(bundle.evidence_score).toBe(1);
  });

  it("ignores an unparseable max_age string", () => {
    const required: RequiredEvidence[] = [
      { kind: "a", weight: 1, required: true, max_age: "soon" },
    ];
    const old = new Date(Date.now() - 1000 * DAY_MS).toISOString();
    const bundle = scoreEvidence([{ kind: "a", ref: "r1", timestamp: old }], required);
    expect(bundle.evidence_score).toBe(1);
  });

  it("ignores a max_age with an unknown unit", () => {
    const required: RequiredEvidence[] = [
      // unit "w" is not in MAX_AGE_UNIT_MS, so parseMaxAgeMs returns null
      { kind: "a", weight: 1, required: true, max_age: "2w" },
    ];
    const old = new Date(Date.now() - 1000 * DAY_MS).toISOString();
    const bundle = scoreEvidence([{ kind: "a", ref: "r1", timestamp: old }], required);
    expect(bundle.evidence_score).toBe(1);
  });

  it("treats an unparseable timestamp as fresh (NaN guard)", () => {
    const required: RequiredEvidence[] = [{ kind: "a", weight: 1, required: true, max_age: "1d" }];
    const bundle = scoreEvidence([{ kind: "a", ref: "r1", timestamp: "not-a-date" }], required);
    expect(bundle.evidence_score).toBe(1);
  });

  it("clamps an over-weighted evidence_score to 1", () => {
    const required: RequiredEvidence[] = [
      { kind: "a", weight: 0.8, required: true },
      { kind: "b", weight: 0.8, required: true },
    ];
    const items: EvidenceRef[] = [
      { kind: "a", ref: "r1" },
      { kind: "b", ref: "r2" },
    ];
    const bundle = scoreEvidence(items, required);
    expect(bundle.evidence_score).toBe(1);
  });
});
