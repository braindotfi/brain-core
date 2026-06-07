/**
 * P0.2 — runtime verification of the DB-level invariants that the DB-free
 * src/invariants.test.ts suite can only *enumerate*. These run against a live
 * Postgres (DATABASE_URL); they skip entirely when it is absent so the default
 * `pnpm test` stays hermetic.
 *
 * Harness: a fresh per-run schema, the Brain migration runner, then
 * `FORCE ROW LEVEL SECURITY` on every RLS-enabled table so policies apply even
 * to the schema owner (mirrors infra/db-roles.sql). A dedicated non-owner role
 * with only SELECT/INSERT granted exercises the append-only posture.
 *
 * The five invariants (each fails closed when violated):
 *   1. Audit append-only — UPDATE audit_events as the app role is denied.
 *   2. RLS coverage — every tenant-scoped table has an enabled policy, and a
 *      row written under tenant A is invisible under tenant B.
 *   3. Gate-bypass impossibility — a PaymentIntent cannot reach `executed`
 *      except from `dispatching` (the gate is the only producer of that state).
 *   4. Agent-contributed confidence ceiling — clamped to 0.5.
 *   5. Audit pair on executed intents — exactly one execute.before and one
 *      execute.after/.failed per executed PaymentIntent.
 */

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client, Pool } from "pg";
import {
  PostgresAuditEmitter,
  withTenantScope,
  newTenantId,
  newAgentId,
  newPaymentIntentId,
  brainId,
  hashEvent,
  ID_PREFIX,
  type ServiceCallContext,
} from "@brain/shared";
import { isValidPaymentIntentTransition } from "@brain/execution";
import { checkAuditConsistency } from "@brain/audit";
import { LedgerPaymentIntents, upsertAccountRow, upsertCounterpartyRow } from "@brain/ledger";
import { AGENT_CONTRIBUTED_CONFIDENCE_CEILING } from "../../../schemas/index.js";
import { applyAll, discoverMigrations } from "../../../tools/migrate/src/index.js";

const DB_URL = process.env.DATABASE_URL;
const suite = DB_URL !== undefined && DB_URL !== "" ? describe : describe.skip;

function repoRoot(): string {
  return new URL("../../..", import.meta.url).pathname;
}

let pool: Pool;
let schema: string;
let appRole: string;

async function seedAccountAndCounterparty(tenant: string): Promise<{ acct: string; cp: string }> {
  const audit = new PostgresAuditEmitter(pool);
  const ctx: ServiceCallContext = { tenantId: tenant, actor: "system" };
  const { row: cpRow } = await upsertCounterpartyRow(pool, audit, ctx, {
    name: `Vendor ${newPaymentIntentId()}`,
    type: "vendor",
    source_ids: ["raw_seed"],
    evidence_ids: [],
    provenance: "extracted",
    confidence: 0.9,
  });
  const { row: acctRow } = await upsertAccountRow(pool, audit, ctx, {
    external_account_id: `ext_${newPaymentIntentId()}`,
    account_type: "bank_checking",
    name: "Checking",
    currency: "USD",
    status: "active",
    source_ids: ["raw_seed"],
    evidence_ids: [],
    provenance: "extracted",
    confidence: 0.9,
  });
  return { acct: acctRow.id, cp: cpRow.id };
}

suite("DB invariants (integration — requires DATABASE_URL)", () => {
  beforeAll(async () => {
    schema = `inv_test_${createHash("sha1")
      .update(String(process.pid) + String(Date.now()))
      .digest("hex")
      .slice(0, 12)}`;
    appRole = `${schema}_app`;

    const bootstrap = new Client({ connectionString: DB_URL });
    await bootstrap.connect();
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await bootstrap.end();

    pool = new Pool({ connectionString: DB_URL, max: 5, application_name: `inv-${schema}` });
    pool.on("connect", (c) => {
      void c.query(`SET search_path TO ${schema}, public`);
    });

    const mig = await pool.connect();
    try {
      await mig.query(`SET search_path TO ${schema}, public`);
      const discovered = await discoverMigrations(repoRoot());
      await applyAll(mig as unknown as Parameters<typeof applyAll>[0], discovered, {
        appliedBy: "invariants-integration",
      });

      // FORCE RLS on every RLS-enabled table so policies apply to the owner too.
      const enabled = await mig.query<{ relname: string }>(
        `SELECT c.relname
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relrowsecurity`,
        [schema],
      );
      for (const r of enabled.rows) {
        await mig.query(`ALTER TABLE ${schema}.${r.relname} FORCE ROW LEVEL SECURITY`);
      }

      // Non-owner app role: SELECT/INSERT only — mirrors the append-only posture
      // (REVOKE UPDATE, DELETE ON audit_events FROM PUBLIC in 0001_audit_events).
      await mig.query(`DROP ROLE IF EXISTS ${appRole}`);
      await mig.query(`CREATE ROLE ${appRole} NOLOGIN`);
      await mig.query(`GRANT USAGE ON SCHEMA ${schema} TO ${appRole}`);
      await mig.query(`GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA ${schema} TO ${appRole}`);
    } finally {
      mig.release();
    }
  }, 60_000);

  afterAll(async () => {
    if (pool === undefined) return;
    await pool.end();
    const done = new Client({ connectionString: DB_URL });
    await done.connect();
    await done.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await done.query(`DROP ROLE IF EXISTS ${appRole}`);
    await done.end();
  }, 60_000);

  // 1 — audit append-only.
  it("denies UPDATE audit_events as the app role (append-only)", async () => {
    const tenant = newTenantId();
    const emitter = new PostgresAuditEmitter(pool);
    const ev = await emitter.emit({
      tenantId: tenant,
      layer: "audit",
      actor: "system",
      action: "test.seed",
      inputs: {},
      outputs: {},
    });

    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${schema}, public`);
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${appRole}`);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
      await expect(
        client.query(`UPDATE audit_events SET action = 'tampered' WHERE id = $1`, [ev.id]),
      ).rejects.toThrow(/permission denied/i);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  // 2 — RLS coverage (policy presence) + enforcement probe.
  it("every tenant-scoped table has an enabled RLS policy", async () => {
    const rows = (
      await pool.query<{ relname: string; relrowsecurity: boolean; npol: string }>(
        `SELECT c.relname,
                c.relrowsecurity,
                (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS npol
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relkind = 'r'`,
        [schema],
      )
    ).rows;

    const isTenantScoped = (name: string): boolean =>
      /^(ledger_|wiki_)/.test(name) ||
      name.includes("payment_intents") ||
      ["agents", "proposals", "executions", "audit_events"].includes(name);

    const matches = rows.filter((r) => isTenantScoped(r.relname));
    expect(matches.length).toBeGreaterThan(0);
    const missing = matches
      .filter((r) => !r.relrowsecurity || Number(r.npol) === 0)
      .map((r) => r.relname);
    expect(missing).toEqual([]);
  });

  it("a row written under tenant A is invisible under tenant B (RLS enforced)", async () => {
    const a = newTenantId();
    const b = newTenantId();
    const emitter = new PostgresAuditEmitter(pool);
    const ev = await emitter.emit({
      tenantId: a,
      layer: "audit",
      actor: "system",
      action: "rls.probe",
      inputs: {},
      outputs: {},
    });

    // Read as the NON-OWNER app role so RLS actually applies. The pooled
    // connection runs as the (super)owner, for whom Postgres bypasses RLS
    // regardless of FORCE — withTenantScope alone would see across tenants.
    async function countSeenAs(tenant: string): Promise<number> {
      const c = await pool.connect();
      try {
        await c.query(`SET search_path TO ${schema}, public`);
        await c.query("BEGIN");
        await c.query(`SET LOCAL ROLE ${appRole}`);
        await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
        const res = await c.query(`SELECT id FROM audit_events WHERE id = $1`, [ev.id]);
        await c.query("ROLLBACK");
        return res.rows.length;
      } finally {
        c.release();
      }
    }

    expect(await countSeenAs(b)).toBe(0);
    expect(await countSeenAs(a)).toBe(1);
  });

  // 3 — gate-bypass impossibility.
  it("a PaymentIntent cannot reach 'executed' outside the gated dispatching path", async () => {
    // (a) the state machine has no direct approved → executed edge.
    expect(isValidPaymentIntentTransition("approved", "executed")).toBe(false);
    expect(isValidPaymentIntentTransition("dispatching", "executed")).toBe(true);

    // (b) the atomic repo helper is conditional on the current state: settling
    // (→ executed) requires the row to ALREADY be 'dispatching', which only the
    // §6-gated PaymentIntentService produces. check-gate-bypass.mjs statically
    // forbids any other caller from invoking the 'executed' transition.
    const tenant = newTenantId();
    const { acct, cp } = await seedAccountAndCounterparty(tenant);
    const piId = newPaymentIntentId();
    await withTenantScope(pool, tenant, (c) =>
      LedgerPaymentIntents.insert(c, {
        id: piId,
        ownerId: tenant,
        createdByAgentId: newAgentId(),
        actionType: "ach_outbound",
        sourceAccountId: acct,
        destinationCounterpartyId: cp,
        amount: "10.00",
        currency: "USD",
        status: "approved",
        policyDecisionId: null,
        evidenceIds: [],
      }),
    );

    const jumped = await withTenantScope(pool, tenant, (c) =>
      LedgerPaymentIntents.transition(c, piId, "dispatching", "executed"),
    );
    expect(jumped).toBeNull();

    const after = await withTenantScope(pool, tenant, (c) =>
      c.query<{ status: string }>(`SELECT status FROM ledger_payment_intents WHERE id = $1`, [
        piId,
      ]),
    );
    expect(after.rows[0]?.status).toBe("approved");
  });

  // 4 — agent-contributed confidence ceiling.
  it("clamps agent-contributed Ledger rows to the 0.5 confidence ceiling", async () => {
    const tenant = newTenantId();
    const audit = new PostgresAuditEmitter(pool);
    const { row } = await upsertCounterpartyRow(
      pool,
      audit,
      { tenantId: tenant, actor: "agent_x" },
      {
        name: `Clamp Co ${newPaymentIntentId()}`,
        type: "vendor",
        source_ids: ["raw_seed"],
        evidence_ids: [],
        provenance: "agent_contributed",
        confidence: 0.9,
      },
    );
    expect(row.confidence).toBe(AGENT_CONTRIBUTED_CONFIDENCE_CEILING);
    expect(AGENT_CONTRIBUTED_CONFIDENCE_CEILING).toBe(0.5);
  });

  // 5 — audit pair on executed intents.
  it("every executed PaymentIntent has exactly one execute.before and one execute.after", async () => {
    const tenant = newTenantId();
    const { acct, cp } = await seedAccountAndCounterparty(tenant);
    const piId = newPaymentIntentId();
    await withTenantScope(pool, tenant, (c) =>
      LedgerPaymentIntents.insert(c, {
        id: piId,
        ownerId: tenant,
        createdByAgentId: newAgentId(),
        actionType: "ach_outbound",
        sourceAccountId: acct,
        destinationCounterpartyId: cp,
        amount: "10.00",
        currency: "USD",
        status: "executed",
        policyDecisionId: null,
        evidenceIds: [],
      }),
    );

    const audit = new PostgresAuditEmitter(pool);
    await audit.emit({
      tenantId: tenant,
      layer: "agent",
      actor: "agent_x",
      action: "payment_intent.execute.before",
      inputs: { payment_intent_id: piId },
      outputs: {},
    });
    await audit.emit({
      tenantId: tenant,
      layer: "agent",
      actor: "agent_x",
      action: "payment_intent.execute.after",
      inputs: { payment_intent_id: piId },
      outputs: {},
    });

    const result = await withTenantScope(pool, tenant, (c) =>
      c.query<{ id: string; before_n: string; after_n: string }>(
        `SELECT pi.id,
                count(*) FILTER (WHERE ae.action = 'payment_intent.execute.before') AS before_n,
                count(*) FILTER (
                  WHERE ae.action IN ('payment_intent.execute.after', 'payment_intent.execute.failed')
                ) AS after_n
           FROM ledger_payment_intents pi
           LEFT JOIN audit_events ae
             ON ae.inputs->>'payment_intent_id' = pi.id AND ae.tenant_id = $1
          WHERE pi.status = 'executed'
          GROUP BY pi.id`,
        [tenant],
      ),
    );

    expect(result.rows.length).toBeGreaterThan(0);
    for (const r of result.rows) {
      expect(Number(r.before_n)).toBe(1);
      expect(Number(r.after_n)).toBe(1);
    }
  });

  // 6 — RFC 0002 self-serve onboarding: tenant isolation of the identity tables.
  // Insert a users row under the freshly-minted tenant (the same scope-to-new-id
  // pattern provisionTenant uses); FORCE RLS makes the WITH CHECK apply even to
  // the owner, so the insert is only permitted for that tenant.
  async function insertOwner(tenant: string, email: string): Promise<string> {
    const userId = brainId(ID_PREFIX.user);
    await withTenantScope(pool, tenant, (c) =>
      c.query(
        `INSERT INTO users (id, tenant_id, email, role, password_hash, status)
         VALUES ($1, $2, $3, 'owner', 'scrypt$32768$8$1$c2FsdA$ZGs', 'active')`,
        [userId, tenant, email],
      ),
    );
    return userId;
  }

  it("onboarding identity tables (tenants, users, email_verifications) all enforce RLS", async () => {
    const rows = (
      await pool.query<{ relname: string; relrowsecurity: boolean; npol: string }>(
        `SELECT c.relname,
                c.relrowsecurity,
                (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS npol
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1
            AND c.relkind = 'r'
            AND c.relname IN ('tenants', 'users', 'email_verifications')`,
        [schema],
      )
    ).rows;
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.relrowsecurity).toBe(true);
      expect(Number(r.npol)).toBeGreaterThan(0);
    }
  });

  it("an owner user written under tenant A is invisible under tenant B (RLS enforced)", async () => {
    const a = newTenantId();
    const b = newTenantId();
    const uid = await insertOwner(a, `iso-${a.slice(-8)}@example.com`);

    async function seenAs(tenant: string): Promise<number> {
      const c = await pool.connect();
      try {
        await c.query(`SET search_path TO ${schema}, public`);
        await c.query("BEGIN");
        await c.query(`SET LOCAL ROLE ${appRole}`);
        await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
        const res = await c.query(`SELECT id FROM users WHERE id = $1`, [uid]);
        await c.query("ROLLBACK");
        return res.rows.length;
      } finally {
        c.release();
      }
    }

    expect(await seenAs(b)).toBe(0);
    expect(await seenAs(a)).toBe(1);
  });

  it("rejects the same password-login email across tenants (signup_email_taken basis)", async () => {
    const a = newTenantId();
    const b = newTenantId();
    const email = `dup-${newPaymentIntentId().slice(-10)}@example.com`;
    await insertOwner(a, email);
    // The global partial unique index users_login_email_unique (lower(email) WHERE
    // password_hash IS NOT NULL) is enforced beneath RLS, so a second tenant
    // cannot register the same login email — this is what backs signup_email_taken.
    await expect(insertOwner(b, email)).rejects.toThrow(/duplicate key|unique/i);
  });

  // 6 — concurrent audit emits for one tenant form a SINGLE linear hash chain
  // (Codex 2026-06-07 P1: the per-tenant chain must not fork under concurrency).
  it("concurrent audit emits for one tenant form a single linear hash chain", async () => {
    const tenant = newTenantId();
    const emitter = new PostgresAuditEmitter(pool);
    const N = 24;

    // Fire N emits for the SAME tenant at once. Without the per-tenant advisory
    // lock these race: multiple genesis events (no tail row to lock yet) and/or
    // two events sharing one predecessor (locking the tail is not enough) — a
    // forked structure rather than a chain.
    await Promise.all(
      Array.from({ length: N }, (_unused, i) =>
        emitter.emit({
          tenantId: tenant,
          layer: "audit",
          actor: "system",
          action: "test.concurrent",
          inputs: { i },
          outputs: {},
        }),
      ),
    );

    // Read the chain back under the tenant scope.
    const c = await pool.connect();
    let rows: { eh: string; peh: string | null }[];
    try {
      await c.query(`SET search_path TO ${schema}, public`);
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
      const res = await c.query<{ eh: string; peh: string | null }>(
        `SELECT encode(event_hash, 'hex') AS eh, encode(prev_event_hash, 'hex') AS peh
           FROM audit_events WHERE tenant_id = $1`,
        [tenant],
      );
      await c.query("COMMIT");
      rows = res.rows;
    } finally {
      c.release();
    }

    expect(rows.length).toBe(N);
    // Exactly one genesis event (prev_event_hash = null).
    expect(rows.filter((r) => r.peh === null).length).toBe(1);
    // No two events share a predecessor — that duplication is the fork signature.
    const prevs = rows.map((r) => r.peh).filter((p): p is string => p !== null);
    expect(new Set(prevs).size).toBe(prevs.length);
    // Walking from the genesis must visit every event in one unbranched line.
    const byPrev = new Map(rows.map((r) => [r.peh ?? "__genesis__", r] as const));
    let cur = byPrev.get("__genesis__");
    const visited = new Set<string>();
    while (cur !== undefined) {
      expect(visited.has(cur.eh)).toBe(false);
      visited.add(cur.eh);
      cur = byPrev.get(cur.eh);
    }
    expect(visited.size).toBe(N);
  }, 30_000);

  // 7 — an idempotency key makes audit delivery replay-safe (Codex 2026-06-07
  // P2: replaying one outbox row cannot create a second logical audit event).
  it("an idempotency key dedupes audit events (replay-safe, exactly-once)", async () => {
    const tenant = newTenantId();
    const emitter = new PostgresAuditEmitter(pool);
    const base = {
      tenantId: tenant,
      layer: "audit" as const,
      actor: "system",
      action: "test.idem",
      inputs: {},
      outputs: {},
      idempotencyKey: "dup-key",
    };
    const ev1 = await emitter.emit(base);
    const ev2 = await emitter.emit(base); // a replay with the same key
    expect(ev2.id).toBe(ev1.id); // returned the existing event, not a new one

    const c = await pool.connect();
    try {
      await c.query(`SET search_path TO ${schema}, public`);
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
      const res = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_events
          WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenant, "dup-key"],
      );
      await c.query("COMMIT");
      expect(res.rows[0]!.n).toBe(1); // exactly one physical row
    } finally {
      c.release();
    }
  });

  // 8 — the audit-consistency verifier is a PRIVILEGED-pool detective control.
  // Through the BYPASSRLS pool it sees every tenant and detects a corrupted
  // chain; on a tenant-scoped app-role connection (the request-path role under
  // FORCE RLS) the same queries see ZERO rows and report a permanent
  // false-clean. This is the regression guard for doc A P1.1: the verifier must
  // never be wired to the request-path pool.
  it("audit-consistency verifier detects a gap via the privileged pool but is blind on a tenant-scoped app-role connection", async () => {
    const tenant = newTenantId();
    const emitter = new PostgresAuditEmitter(pool);
    await emitter.emit({
      tenantId: tenant,
      layer: "audit",
      actor: "system",
      action: "chain.genesis",
      inputs: {},
      outputs: {},
    });
    const e2 = await emitter.emit({
      tenantId: tenant,
      layer: "audit",
      actor: "system",
      action: "chain.second",
      inputs: {},
      outputs: {},
    });

    // Corrupt the chain as the (super)owner: point e2 at a predecessor hash that
    // is the event_hash of no event — a gap. (REVOKE UPDATE is on PUBLIC, not
    // the owner, and superusers bypass RLS.)
    await pool.query(`UPDATE audit_events SET prev_event_hash = decode($2, 'hex') WHERE id = $1`, [
      e2.id,
      "aa".repeat(32),
    ]);

    // Privileged pool: sees across tenants, detects the gap, logs critical.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const privileged = await checkAuditConsistency({ privilegedPool: pool });
    expect(privileged.gaps).toBeGreaterThanOrEqual(1);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();

    // Request-path role with no tenant scope set: RLS hides every row, so the
    // identical verifier reports a false-clean. This is exactly the production
    // regression that wiring it to `privilegedPool` prevents.
    const blind = await pool.connect();
    try {
      await blind.query(`SET search_path TO ${schema}, public`);
      await blind.query("BEGIN");
      await blind.query(`SET LOCAL ROLE ${appRole}`);
      // deliberately NO set_config('app.tenant_id', ...) — mirrors the verifier,
      // which scans all tenants and sets no scope.
      const res = await checkAuditConsistency({ privilegedPool: blind as unknown as Pool });
      await blind.query("ROLLBACK");
      expect(res).toEqual({ forks: 0, gaps: 0, invalidGenesis: 0 });
    } finally {
      blind.release();
    }
  });

  // 9 — two genesis (null-predecessor) events for one tenant escape both the
  // fork check (which excludes null predecessors) and the gap check (each
  // genesis is self-consistent). The genesis-cardinality check catches them.
  // Validated against real SQL — the unit fakePool cannot exercise the
  // `FILTER (WHERE prev_event_hash IS NULL) <> 1` semantics. (doc A P2.1)
  it("detects a tenant with two genesis events via the privileged pool", async () => {
    const tenant = newTenantId();
    const emitter = new PostgresAuditEmitter(pool);
    await emitter.emit({
      tenantId: tenant,
      layer: "audit",
      actor: "system",
      action: "genesis.one",
      inputs: {},
      outputs: {},
    });
    const second = await emitter.emit({
      tenantId: tenant,
      layer: "audit",
      actor: "system",
      action: "genesis.two",
      inputs: {},
      outputs: {},
    });

    // Sever the second event's predecessor as the (super)owner: now the tenant
    // has two null-predecessor events — a duplicated chain head.
    await pool.query(`UPDATE audit_events SET prev_event_hash = NULL WHERE id = $1`, [second.id]);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await checkAuditConsistency({ privilegedPool: pool });
    errSpy.mockRestore();
    expect(res.invalidGenesis).toBeGreaterThanOrEqual(1);
  });

  // 10 — reusing an idempotency key with DIFFERENT content fails loudly instead
  // of returning a phantom event. Validated against real Postgres: the stored
  // event_hash comes from a real prior emit, so this also proves the conflict
  // recompute round-trips created_at / prev_event_hash exactly. (doc A P1.2)
  it("rejects an idempotency-key reuse whose payload differs (audit_idempotency_conflict)", async () => {
    const tenant = newTenantId();
    const emitter = new PostgresAuditEmitter(pool);
    const key = "reuse-key";
    await emitter.emit({
      tenantId: tenant,
      layer: "audit",
      actor: "system",
      action: "first.action",
      inputs: {},
      outputs: {},
      idempotencyKey: key,
    });
    await expect(
      emitter.emit({
        tenantId: tenant,
        layer: "audit",
        actor: "system",
        action: "second.action", // different payload, same key
        inputs: {},
        outputs: {},
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({ code: "audit_idempotency_conflict" });

    // The conflicting emit wrote no second physical row.
    const c = await pool.connect();
    try {
      await c.query(`SET search_path TO ${schema}, public`);
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
      const res = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_events
          WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenant, key],
      );
      await c.query("COMMIT");
      expect(res.rows[0]!.n).toBe(1);
    } finally {
      c.release();
    }
  });

  // 11 — a NON-GENESIS idempotent replay must dedupe to the existing event, not
  // throw a false audit_idempotency_conflict. Real-pg regression guard for the
  // BYTEA predecessor-hash bug: the write-time hash and the conflict recompute
  // must use the same hex representation of prev_event_hash. node-pg returns
  // BYTEA as a Buffer, which only this real-DB path exercises. (Codex c96283d P1)
  it("replays a non-genesis idempotent audit event without a false conflict", async () => {
    const tenant = newTenantId();
    const emitter = new PostgresAuditEmitter(pool);
    const genesis = await emitter.emit({
      tenantId: tenant,
      layer: "audit",
      actor: "system",
      action: "chain.head",
      inputs: {},
      outputs: {},
    });
    const key = `${tenant}:nongenesis`;
    const evtInput = {
      tenantId: tenant,
      layer: "audit" as const,
      actor: "system",
      action: "chain.second",
      inputs: { a: 1 },
      outputs: {},
      idempotencyKey: key,
    };
    const second = await emitter.emit(evtInput);
    // The predecessor link is the genesis HEX hash, not a Buffer-shaped value.
    expect(second.prevEventHash).toBe(genesis.eventHash);

    // Replay the SAME non-genesis event (same key + content): must dedupe to the
    // same id, never throw. (Pre-fix this raised audit_idempotency_conflict.)
    const replay = await emitter.emit(evtInput);
    expect(replay.id).toBe(second.id);
    expect(replay.eventHash).toBe(second.eventHash);

    // The persisted hash recomputes exactly from logical fields + hex prev.
    const recomputed = hashEvent({
      event: evtInput,
      id: second.id,
      createdAt: second.createdAt,
      prevEventHash: genesis.eventHash,
    });
    expect(recomputed).toBe(second.eventHash);
  });
});
