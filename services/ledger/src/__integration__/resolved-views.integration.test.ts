/**
 * Integration test for the resolved-view service methods (Phase 6 PR-2).
 *
 * Exercises the real resolution SQL (the match transitive-closure + observation
 * assembly) behind LedgerService.resolveObligation / resolveCounterparty against
 * a live database -- the path the new /resolved endpoints expose. The matcher
 * logic itself is unit-tested with a fake pool; this proves the SQL is valid and
 * the envelope assembles end to end. Requires DATABASE_URL.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  InMemoryAuditEmitter,
  newAccountId,
  newCounterpartyId,
  newObligationId,
  newTenantId,
  type ServiceCallContext,
} from "@brain/shared";
import { LedgerService } from "../service/LedgerService.js";

const DESCRIBE = process.env.DATABASE_URL !== undefined ? describe : describe.skip;

DESCRIBE("ledger resolved-view service methods (requires DATABASE_URL)", () => {
  let pool: Pool;
  let service: LedgerService;
  const tenant = newTenantId();
  const ctx: ServiceCallContext = { tenantId: tenant, actor: "user_test" };
  const cpId = newCounterpartyId();
  const oblId = newObligationId();
  const acctId = newAccountId();

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    service = new LedgerService({ pool, audit: new InMemoryAuditEmitter() });
    await pool.query(
      `INSERT INTO ledger_counterparties (
         id, owner_id, name, normalized_name, type, provenance, confidence, source_ids
       )
       VALUES ($1,$2,'Acme Industrial Supply','acme_industrial_supply','vendor','extracted',0.8,$3::text[])`,
      [cpId, tenant, ["raw_counterparty"]],
    );
    await pool.query(
      `INSERT INTO ledger_accounts (
         id, owner_id, account_type, name, currency, status, provenance, confidence, source_ids
       )
       VALUES ($1,$2,'bank_checking','Operating Checking','USD','active','extracted',0.9,$3::text[])`,
      [acctId, tenant, ["raw_account"]],
    );
    await pool.query(
      `INSERT INTO ledger_obligations
         (id, owner_id, type, counterparty_id, amount_due, currency, due_date, status,
          direction, provenance, confidence, source_ids)
       VALUES ($1,$2,'bill',$3,'1250.00','USD','2026-07-01','due','payable','extracted',0.85,$4::text[])`,
      [oblId, tenant, cpId, ["raw_obligation"]],
    );
  }, 60_000);

  afterAll(async () => {
    if (pool === undefined) return;
    await pool.query(`DELETE FROM ledger_obligations WHERE owner_id = $1`, [tenant]);
    await pool.query(`DELETE FROM ledger_accounts WHERE owner_id = $1`, [tenant]);
    await pool.query(`DELETE FROM ledger_counterparties WHERE owner_id = $1`, [tenant]);
    await pool.end();
  });

  it("resolveObligation returns the obligation as one observation, authoritative for itself", async () => {
    const view = await service.resolveObligation(ctx, oblId);
    expect(view).not.toBeNull();
    expect(view!.observations.map((o) => o.obligation_id)).toEqual([oblId]);
    expect(view!.observations[0]!.source_ids).toEqual(["raw_obligation"]);
    expect(view!.resolved.amount_due.authority_obligation_id).toBe(oblId);
    expect(Number(view!.resolved.amount_due.value)).toBe(1250);
    expect(view!.conflicts).toEqual([]); // no second observation, no disagreement
    expect(view!.matches).toEqual([]);
  });

  it("resolveCounterparty returns the org with the subject as a member", async () => {
    const view = await service.resolveCounterparty(ctx, cpId);
    expect(view).not.toBeNull();
    expect(view!.resolved.member_ids).toContain(cpId);
    expect(view!.resolved.types).toContain("vendor");
    expect(view!.observations[0]!.source_ids).toEqual(["raw_counterparty"]);
  });

  it("resolveAccount returns the account with the subject as a member", async () => {
    const view = await service.resolveAccount(ctx, acctId);
    expect(view).not.toBeNull();
    expect(view!.resolved.member_ids).toContain(acctId);
    expect(view!.observations[0]!.source_ids).toEqual(["raw_account"]);
  });

  it("returns null for an unknown id", async () => {
    expect(await service.resolveObligation(ctx, newObligationId())).toBeNull();
    expect(await service.resolveCounterparty(ctx, newCounterpartyId())).toBeNull();
    expect(await service.resolveAccount(ctx, newAccountId())).toBeNull();
  });
});
