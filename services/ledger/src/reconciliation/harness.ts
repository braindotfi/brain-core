/**
 * Test-only harness for the reconciliation matchers.
 *
 * Matchers query Postgres exclusively through `withTenantScope(pool, …)`, which
 * checks out a client, runs `BEGIN` / `set_config` / `COMMIT`, and routes every
 * read through `client.query`. This module builds a fake `pg.Pool` whose client
 * returns canned rows keyed by a SQL substring, so each matcher can be exercised
 * end-to-end without a live database.
 *
 * NOTE: this file is test scaffolding (excluded from the coverage gate in
 * `vitest.config.ts`); it is imported only by `*.test.ts` siblings.
 */

import type { Pool } from "pg";
import { vi } from "vitest";
import {
  InMemoryAuditEmitter,
  newTenantId,
  newUserId,
  type ServiceCallContext,
} from "@brain/shared";
import type { MatcherContext, MatcherInput } from "./types.js";

export interface CapturedQuery {
  /** First non-blank line of the SQL, trimmed — handy for assertions. */
  summary: string;
  /** Full SQL text. */
  text: string;
  /** Bound parameters passed alongside the query. */
  values: readonly unknown[];
}

export interface FakePool {
  pool: Pool;
  /** Every query routed through the scoped client, in order. */
  queries: CapturedQuery[];
}

/**
 * Build a fake pool. `routes` maps a SQL substring → the rows that query yields.
 * Transaction-control statements (BEGIN/COMMIT/ROLLBACK/set_config) and any
 * unmatched SELECT resolve to an empty result set.
 */
export function fakePool(routes: Record<string, Array<Record<string, unknown>>> = {}): FakePool {
  const queries: CapturedQuery[] = [];
  const client = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      if (
        text.startsWith("BEGIN") ||
        text === "COMMIT" ||
        text === "ROLLBACK" ||
        text.startsWith("SELECT set_config")
      ) {
        return { rows: [], rowCount: 0 };
      }
      queries.push({
        summary: (text.trim().split("\n")[0] ?? "").trim(),
        text,
        values: values ?? [],
      });
      for (const [pattern, rows] of Object.entries(routes)) {
        if (text.includes(pattern)) return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, queries };
}

/** A fresh matcher dependency bundle backed by the supplied fake pool. */
export function makeDeps(pool: Pool): { deps: MatcherContext; audit: InMemoryAuditEmitter } {
  const audit = new InMemoryAuditEmitter();
  return { deps: { pool, audit }, audit };
}

/** A valid service-call context (a well-formed tenant id is required by `withTenantScope`). */
export function makeCtx(): ServiceCallContext {
  return { tenantId: newTenantId(), actor: newUserId() };
}

/**
 * Standard matcher input with a fixed `since` and generous match cap.
 *
 * `since` is honored exactly when the key is present (even when `null`), so a
 * test can pass `{ since: null }` to drive the matcher's `defaultSince` branch.
 */
export function makeInput(overrides: Partial<MatcherInput> = {}): MatcherInput {
  return {
    ctx: overrides.ctx ?? makeCtx(),
    since: "since" in overrides ? (overrides.since ?? null) : new Date("2026-01-01T00:00:00Z"),
    maxMatches: overrides.maxMatches ?? 100,
  };
}

/** Find the first captured query whose SQL contains `needle`. */
export function findQuery(queries: readonly CapturedQuery[], needle: string): CapturedQuery {
  const q = queries.find((entry) => entry.text.includes(needle));
  if (q === undefined) {
    throw new Error(`no captured query containing: ${needle}`);
  }
  return q;
}
