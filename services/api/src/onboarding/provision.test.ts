import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { isBrainId, ID_PREFIX } from "@brain/shared";
import { contentHash, evaluate, lintPolicy, type Action } from "@brain/policy";
import {
  buildDefaultPolicyDocument,
  DEFAULT_CONFIDENCE_FLOOR,
  provisionTenant,
} from "./provision.js";

interface Captured {
  sql: string;
  values: unknown[];
}

/**
 * Fake pool that records every statement (incl. BEGIN / set_config / COMMIT /
 * ROLLBACK) so the test can assert the transaction shape AND the tenant-scope.
 * `failOn` lets a test simulate a unique-violation on a chosen INSERT.
 */
function makeFakePool(opts: { failOn?: RegExp; failCode?: string } = {}): {
  pool: Pool;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const client = {
    query: vi.fn((sql: string, values?: unknown[]) => {
      calls.push({ sql, values: values ?? [] });
      if (opts.failOn !== undefined && opts.failOn.test(sql)) {
        const err = new Error("duplicate key value violates unique constraint") as Error & {
          code?: string;
        };
        err.code = opts.failCode ?? "23505";
        return Promise.reject(err);
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(() => Promise.resolve(client)) } as unknown as Pool;
  return { pool, calls };
}

const INPUT = {
  email: "founder@example.com",
  passwordHash: "scrypt$32768$8$1$c2FsdA$ZGs",
  emailVerificationTokenHash: "a".repeat(64),
  emailVerificationExpiresAt: new Date("2026-06-01T00:00:00Z"),
};

describe("provisionTenant — RFC 0002 Phase B", () => {
  it("mints fresh tnt_/user_ ids and inserts tenant + owner + verification atomically", async () => {
    const { pool, calls } = makeFakePool();
    const { tenantId, userId } = await provisionTenant(pool, INPUT);

    expect(isBrainId(tenantId, ID_PREFIX.tenant)).toBe(true);
    expect(isBrainId(userId, ID_PREFIX.user)).toBe(true);

    const sqls = calls.map((c) => c.sql);
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls[1]).toBe("SELECT set_config('app.tenant_id', $1, true)");
    expect(sqls.at(-1)).toBe("COMMIT");
    // The four domain inserts, in order: tenant -> user -> verification ->
    // policy (default agent.confidence.gte floor, batch 11).
    expect(sqls.some((s) => /INSERT INTO tenants/.test(s))).toBe(true);
    expect(sqls.some((s) => /INSERT INTO users/.test(s))).toBe(true);
    expect(sqls.some((s) => /INSERT INTO email_verifications/.test(s))).toBe(true);
    expect(sqls.some((s) => /INSERT INTO policies/.test(s))).toBe(true);
  });

  it("scopes the whole transaction to the freshly-minted tenant id (isolation)", async () => {
    const { pool, calls } = makeFakePool();
    const { tenantId, userId } = await provisionTenant(pool, INPUT);

    // RLS scope is set to the new tenant id — never a caller-supplied value.
    const setConfig = calls.find((c) => c.sql.startsWith("SELECT set_config"));
    expect(setConfig?.values[0]).toBe(tenantId);

    // EVERY domain insert carries that same tenant id — the writer cannot touch
    // any other tenant's rows.
    for (const c of calls) {
      if (/INSERT INTO tenants/.test(c.sql)) expect(c.values[0]).toBe(tenantId);
      if (/INSERT INTO users/.test(c.sql)) {
        expect(c.values[0]).toBe(userId);
        expect(c.values[1]).toBe(tenantId);
      }
      if (/INSERT INTO email_verifications/.test(c.sql)) {
        expect(c.values[1]).toBe(userId);
        expect(c.values[2]).toBe(tenantId);
      }
      if (/INSERT INTO policies/.test(c.sql)) {
        // [0]=policyId [1]=tenantId [2]=content json [3]=content_hash [4]=createdBy
        expect(c.values[1]).toBe(tenantId);
        expect(c.values[4]).toBe(userId);
      }
    }
  });

  it("persists the password hash and verification token (never the plaintext)", async () => {
    const { pool, calls } = makeFakePool();
    await provisionTenant(pool, INPUT);
    const userInsert = calls.find((c) => /INSERT INTO users/.test(c.sql));
    expect(userInsert?.values).toContain(INPUT.passwordHash);
    expect(userInsert?.values).toContain(INPUT.email);
    const verifyInsert = calls.find((c) => /INSERT INTO email_verifications/.test(c.sql));
    expect(verifyInsert?.values[0]).toBe(INPUT.emailVerificationTokenHash);
    expect(verifyInsert?.values[3]).toBe(INPUT.emailVerificationExpiresAt);
  });

  it("maps a unique-violation on the email to signup_email_taken (and rolls back)", async () => {
    const { pool, calls } = makeFakePool({ failOn: /INSERT INTO users/, failCode: "23505" });
    await expect(provisionTenant(pool, INPUT)).rejects.toMatchObject({
      code: "signup_email_taken",
    });
    expect(calls.some((c) => c.sql === "ROLLBACK")).toBe(true);
    expect(calls.some((c) => c.sql === "COMMIT")).toBe(false);
  });

  it("rethrows a non-unique DB error unchanged (after rollback)", async () => {
    const { pool, calls } = makeFakePool({ failOn: /INSERT INTO tenants/, failCode: "08006" });
    await expect(provisionTenant(pool, INPUT)).rejects.toMatchObject({ code: "08006" });
    expect(calls.some((c) => c.sql === "ROLLBACK")).toBe(true);
  });

  it("seeds a default agent.confidence.gte floor policy active from request 1 (Opus P1-1)", async () => {
    // Batch 11: a freshly provisioned tenant must arrive with the confidence
    // floor enforced, not dormant. Otherwise document-extracted intents (with
    // their <= 0.5 ceiling at write time) sail past the §6 gate's policy
    // check until an operator hand-writes a rule -- which is exactly the
    // "available but not enforced" pattern Opus' review flagged.
    const { pool, calls } = makeFakePool();
    const { tenantId, userId } = await provisionTenant(pool, INPUT);
    const policyInsert = calls.find((c) => /INSERT INTO policies/.test(c.sql));
    expect(policyInsert).toBeDefined();
    expect(policyInsert?.sql).toContain("'active'");

    // Schema:
    //   [0] policy id  [1] tenant id  [2] content JSON  [3] content_hash buf
    //   [4] created_by
    const [policyId, capturedTenant, contentJson, capturedHash, createdBy] = policyInsert!
      .values as [string, string, string, Buffer, string];
    expect(isBrainId(policyId, ID_PREFIX.policy)).toBe(true);
    expect(capturedTenant).toBe(tenantId);
    expect(createdBy).toBe(userId);

    // The persisted content is exactly the helper's output (so an operator
    // signing a v2 starts from a known-stable v1 they can diff against).
    const parsed = JSON.parse(contentJson);
    expect(parsed).toEqual(buildDefaultPolicyDocument());
    // The rule is the named floor at the configured constant. The floor sits
    // ABOVE the 0.5 agent_contributed write ceiling (see the boundary
    // regression block below) so an uncorroborated 0.5 row cannot satisfy it.
    // Rule 0 gates money movement to human confirmation; rule 1 is the
    // non-money floor. Money is never auto-executed by default (Codex P0).
    expect(parsed.rules[0].when["agent.confidence.gte"]).toBe(DEFAULT_CONFIDENCE_FLOOR);
    expect(parsed.rules[0].applies_to).toEqual(["outbound_payment", "onchain_tx"]);
    expect(parsed.rules[0].execute).toBe("confirm");
    expect(parsed.rules[0].require).toBe("single_signer");
    expect(parsed.rules[1].applies_to).toEqual(["inbound_payment", "ledger_write"]);
    expect(parsed.rules[1].execute).toBe("auto");

    // content_hash is sha256 of the canonical document. Computed in code, not
    // hard-coded -- otherwise a future DSL change to canonicalize() would
    // silently break the on-disk policy without failing this test.
    expect(Buffer.compare(capturedHash, contentHash(parsed))).toBe(0);
  });
});

describe("default confidence floor — boundary enforcement (Codex 2026-06-05 P0)", () => {
  // The defect: the floor was 0.5 and the VM compares inclusively
  // (action.confidence >= bound), while agent-contributed Ledger rows are
  // capped at <= 0.5. So an uncorroborated document-extracted obligation at
  // exactly the 0.5 ceiling satisfied `0.5 >= 0.5`, matched the floor rule,
  // and resolved to `auto` -- the floor was a no-op for the exact case it
  // exists to gate. The fix raises the floor strictly above the 0.5 ceiling
  // (and at/below the ~0.7 minimum reconciliation-corroboration score, so a
  // CORROBORATED obligation still clears it).
  const policy = buildDefaultPolicyDocument();

  function paymentWithConfidence(confidence: number | null): Action {
    return {
      kind: "outbound_payment",
      counterparty_id: null,
      amount: { currency: "USD", value: "100.00" },
      agent_role: null,
      timestamp: new Date("2026-06-05T00:00:00Z"),
      confidence,
    };
  }

  it("the floor sits strictly above the 0.5 agent-contributed ceiling", () => {
    expect(DEFAULT_CONFIDENCE_FLOOR).toBeGreaterThan(0.5);
  });

  it("rejects an uncorroborated agent-contributed payment at the 0.5 ceiling", () => {
    // 0.5 must not satisfy the floor at all (below 0.6 -> no match -> deny).
    expect(evaluate(policy, paymentWithConfidence(0.5)).outcome).toBe("reject");
  });

  it("rejects a missing confidence signal (fail closed)", () => {
    expect(evaluate(policy, paymentWithConfidence(null)).outcome).toBe("reject");
  });

  it("rejects payments below the floor", () => {
    for (const c of [0, 0.25, 0.49, DEFAULT_CONFIDENCE_FLOOR - 0.01]) {
      expect(evaluate(policy, paymentWithConfidence(c)).outcome).toBe("reject");
    }
  });

  it("a corroborated payment at/above the floor requires CONFIRM, not auto allow (Codex P0)", () => {
    // The safe default never auto-executes money; a >= floor payment escalates
    // to human confirmation. A tenant can sign a constrained policy to earn auto.
    expect(evaluate(policy, paymentWithConfidence(DEFAULT_CONFIDENCE_FLOOR)).outcome).toBe(
      "confirm",
    );
    for (const c of [0.7, 0.8, 0.9]) {
      expect(evaluate(policy, paymentWithConfidence(c)).outcome).toBe("confirm");
    }
  });

  it("a newly provisioned tenant cannot AUTO-execute a payment at any confidence", () => {
    for (const c of [0.6, 0.95, 1]) {
      expect(evaluate(policy, paymentWithConfidence(c)).outcome).not.toBe("allow");
    }
  });

  it("non-money actions above the floor still auto-allow (not needlessly gated)", () => {
    const ledgerWrite: Action = { ...paymentWithConfidence(0.8), kind: "ledger_write" };
    expect(evaluate(policy, ledgerWrite).outcome).toBe("allow");
  });

  it("the default policy is lint-clean: lintPolicy returns zero ERROR findings", () => {
    const errors = lintPolicy(buildDefaultPolicyDocument()).filter((f) => f.severity === "ERROR");
    expect(errors).toEqual([]);
  });
});
