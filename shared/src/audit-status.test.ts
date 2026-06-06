import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { parseAuditStatus, checkIntegrity, evaluateApproval } from "./audit-status.js";

interface CorpusCase {
  name: string;
  doc: unknown;
  integrityOk: boolean;
  approved: boolean;
  reasonSubstr?: string;
}

// The SAME parity corpus the .mjs port's test consumes
// (scripts/__tests__/audit-status-lib.test.mjs). Both ports asserting against
// one fixture file is what makes them un-divergeable.
const corpus = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../scripts/lib/audit-status.fixtures.json", import.meta.url)),
    "utf8",
  ),
) as { cases: CorpusCase[] };

describe("audit-status validator (TS port) — shared parity corpus", () => {
  for (const c of corpus.cases) {
    it(`${c.name}: integrity=${String(c.integrityOk)} approved=${String(c.approved)}`, () => {
      expect(checkIntegrity(c.doc).ok).toBe(c.integrityOk);

      const approval = evaluateApproval(c.doc);
      expect(approval.approved).toBe(c.approved);

      if (!c.approved) {
        expect(approval.reasons.length).toBeGreaterThan(0);
      }
      if (typeof c.reasonSubstr === "string") {
        const substr = c.reasonSubstr;
        expect(approval.reasons.some((r) => r.includes(substr))).toBe(true);
      }
    });
  }
});

describe("audit-status validator (TS port) — unit", () => {
  it("is fail-closed on non-object documents", () => {
    for (const bad of [null, undefined, 42, "approved", []]) {
      const { approved, reasons } = evaluateApproval(bad);
      expect(approved).toBe(false);
      expect(reasons.length).toBeGreaterThan(0);
    }
  });

  it("parseAuditStatus rejects malformed JSON, accepts strings and objects", () => {
    const bad = parseAuditStatus("{ not json");
    expect(bad.ok).toBe(false);
    expect(bad.doc).toBeNull();
    expect(typeof bad.error).toBe("string");

    const good = parseAuditStatus('{"status":"pending"}');
    expect(good.ok).toBe(true);
    expect(good.doc).toEqual({ status: "pending" });
    expect(good.error).toBeNull();

    const obj = parseAuditStatus({ status: "approved" });
    expect(obj.ok).toBe(true);
    expect(obj.doc).toEqual({ status: "approved" });

    const notSupported = parseAuditStatus(123);
    expect(notSupported.ok).toBe(false);
  });

  it("passes the real committed contracts/audit-status.json integrity", () => {
    const real = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../contracts/audit-status.json", import.meta.url)),
        "utf8",
      ),
    );
    expect(checkIntegrity(real).ok).toBe(true);
  });
});
