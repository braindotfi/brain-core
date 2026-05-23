/**
 * Schema-level invariants (§8.4) enforced statically against the migration SQL.
 *
 * Several §8.4 invariants are DB-level CHECK / FK / grant constraints. The
 * runtime suite is deliberately DB-free, so rather than leave them as
 * `expect(true)` placeholders we assert the constraint exists in the migration
 * that defines it — a real regression guard that fails if the constraint is
 * dropped, without needing a live Postgres.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

describe("schema invariants (§8.4) — static migration constraints", () => {
  it("every transaction belongs to an account (account_id NOT NULL FK)", () => {
    expect(read("services/ledger/migrations/0006_ledger_transactions.sql")).toMatch(
      /account_id\s+TEXT\s+NOT NULL\s+REFERENCES\s+ledger_accounts/,
    );
  });

  it("every transaction has a valid direction (CHECK constraint)", () => {
    expect(read("services/ledger/migrations/0006_ledger_transactions.sql")).toMatch(
      /direction[\s\S]*?CHECK \(direction IN \(/,
    );
  });

  it("every obligation has a valid status (CHECK constraint)", () => {
    expect(read("services/ledger/migrations/0007_ledger_obligations.sql")).toMatch(
      /CHECK \(status IN \(/,
    );
  });

  it("every derived row carries source_ids OR evidence_ids (provenance CHECK)", () => {
    expect(read("services/ledger/migrations/0012_provenance_check.sql")).toMatch(
      /array_length\(source_ids, 1\) > 0\s*OR\s*array_length\(evidence_ids, 1\) > 0/,
    );
  });

  it("audit events are append-only (UPDATE/DELETE revoked at the data layer)", () => {
    expect(read("services/audit/migrations/0001_audit_events.sql")).toMatch(
      /REVOKE\s+UPDATE,\s*DELETE\s+ON\s+audit_events/i,
    );
  });
});
