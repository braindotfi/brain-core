/**
 * Wedge acceptance test — the ingestion architecture's definition of done for
 * the MVP (Appendix A): a vendor invoice ingested through the document tier,
 * the open bill from the accounting aggregator with its vendor record, and
 * the live cash position + prior payments from Plaid, reconciled into one
 * payable — with the §6 gate refusing to auto-execute on document-only
 * evidence until corroboration, and the confirm (explicit user approval)
 * flow open throughout.
 *
 * Runs against a live Postgres (DATABASE_URL); skips hermetically otherwise,
 * mirroring db-invariants.integration.test.ts. Every step uses the REAL
 * pipeline pieces: LedgerService.normalizeFromRaw dispatching through the
 * parser registry (doc_obligation_v1, merge_accounting_v1, plaid_tx_v1), the
 * real provenance-validating writers, persistMatch corroboration, and
 * runPreExecutionGate with SQL-backed evidence/provenance loaders mirroring
 * the api composition.
 *
 * Phase 4 entry point (flagged, not hidden): no matcher yet joins the
 * document-extracted obligation to the aggregator bill obligation-to-
 * obligation; today they meet at the shared vendor counterparty and the
 * corroboration path runs obligation-vs-bank-transaction. The final
 * assertion documents that boundary.
 */

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, Pool } from "pg";
import {
  newRawArtifactId,
  newRawParsedId,
  newTenantId,
  runPreExecutionGate,
  withTenantScope,
  type GateAccount,
  type GateAgent,
  type GateApprovalState,
  type GateCounterparty,
  type GateDependencies,
  type GatePaymentIntent,
  type GatePolicyDecision,
  type GatePrincipal,
  type ResolvedEvidence,
  type ServiceCallContext,
  PostgresAuditEmitter,
} from "@brain/shared";

import { LedgerService, persistMatch } from "@brain/ledger";
import { applyAll, discoverMigrations } from "../../../tools/migrate/src/index.js";

const DB_URL = process.env.DATABASE_URL;
const suite = DB_URL !== undefined && DB_URL !== "" ? describe : describe.skip;

function repoRoot(): string {
  return fileURLToPath(new URL("../../..", import.meta.url));
}

let pool: Pool;
let schema: string;

const TENANT = newTenantId();
const ctx: ServiceCallContext = { tenantId: TENANT, actor: "user_wedge_reviewer" };
const VENDOR_NAME = "Acme Industrial Supply";

/** Land a raw artifact + its parsed row, exactly as ingest + interpretation would. */
async function landParsedArtifact(input: {
  sourceType: string;
  sourceSchema: string;
  parser: string;
  extracted: Record<string, unknown>;
  confidence: number | null;
}): Promise<{ rawId: string; prsId: string }> {
  const rawId = newRawArtifactId();
  const prsId = newRawParsedId();
  const body = JSON.stringify(input.extracted);
  const sha = createHash("sha256").update(rawId).update(body).digest();
  await withTenantScope(pool, TENANT, async (c) => {
    await c.query(
      `INSERT INTO raw_artifacts
         (id, tenant_id, sha256, source_type, source_ref, blob_uri, mime_type, bytes, ingested_by, source_schema)
       VALUES ($1,$2,$3,$4,'{}','blob://wedge','application/json',$5,'user_wedge_reviewer',$6)`,
      [rawId, TENANT, sha, input.sourceType, body.length, input.sourceSchema],
    );
    await c.query(
      `INSERT INTO raw_parsed
         (id, raw_artifact_id, tenant_id, parser, parser_version, extracted, confidence)
       VALUES ($1,$2,$3,$4,'1.0.0',$5,$6)`,
      [prsId, rawId, TENANT, input.parser, body, input.confidence],
    );
  });
  return { rawId, prsId };
}

async function obligationByEvidence(prsId: string): Promise<{
  id: string;
  provenance: string;
  confidence: number;
  direction: string | null;
  counterparty_id: string;
  source_ids: string[];
  evidence_ids: string[];
  metadata: Record<string, unknown>;
}> {
  return withTenantScope(pool, TENANT, async (c) => {
    const { rows } = await c.query(
      `SELECT id, provenance, confidence, direction, counterparty_id, source_ids, evidence_ids,
              COALESCE(metadata, '{}'::jsonb) AS metadata
         FROM ledger_obligations WHERE $1 = ANY(evidence_ids) LIMIT 1`,
      [prsId],
    );
    expect(rows[0]).toBeDefined();
    return rows[0] as never;
  });
}

suite("Wedge acceptance (ingestion architecture, Appendix A definition of done)", () => {
  let ledger: LedgerService;
  let audit: PostgresAuditEmitter;

  // Landed evidence ids per source.
  let doc: { rawId: string; prsId: string };
  let bill: { rawId: string; prsId: string };
  let bank: { rawId: string; prsId: string };

  beforeAll(async () => {
    schema = `wedge_test_${createHash("sha1")
      .update(String(process.pid) + String(Date.now()))
      .digest("hex")
      .slice(0, 12)}`;
    const bootstrap = new Client({ connectionString: DB_URL });
    await bootstrap.connect();
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await bootstrap.end();

    pool = new Pool({ connectionString: DB_URL, max: 5, application_name: schema });
    pool.on("connect", (c) => {
      void c.query(`SET search_path TO ${schema}, public`);
    });

    const mig = await pool.connect();
    try {
      const discovered = await discoverMigrations(repoRoot());
      await applyAll(mig as unknown as Parameters<typeof applyAll>[0], discovered, {
        appliedBy: "wedge-acceptance",
      });
    } finally {
      mig.release();
    }

    audit = new PostgresAuditEmitter(pool);
    ledger = new LedgerService({ pool, audit });
  }, 120_000);

  afterAll(async () => {
    if (pool !== undefined) {
      const c = await pool.connect();
      try {
        await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        c.release();
      }
      await pool.end();
    }
  });

  it("1 — the vendor invoice lands through the document tier as a capped, low-trust payable", async () => {
    doc = await landParsedArtifact({
      sourceType: "pdf_upload",
      sourceSchema: "doc.invoice.v1",
      parser: "doc_obligation_v1",
      extracted: {
        counterparty_name: VENDOR_NAME,
        direction: "payable",
        type: "bill",
        amount: "1250.00",
        currency: "USD",
        due_date: "2026-07-01T00:00:00Z",
        status: "due",
      },
      confidence: 0.45,
    });
    await ledger.normalizeFromRaw(ctx, doc.prsId);

    const obligation = await obligationByEvidence(doc.prsId);
    expect(obligation.provenance).toBe("agent_contributed");
    expect(obligation.confidence).toBeLessThanOrEqual(0.5); // §3.2 ceiling
    expect(obligation.direction).toBe("payable");
    // Evidence references: the payable traces to the invoice document.
    expect(obligation.source_ids).toContain(doc.rawId);
    expect(obligation.evidence_ids).toContain(doc.prsId);
  });

  it("2 — the aggregator's open bill lands as an extracted payable with GL coding, on the SAME vendor", async () => {
    bill = await landParsedArtifact({
      sourceType: "merge_accounting",
      sourceSchema: "merge_accounting.invoices.v1",
      parser: "merge_accounting_v1",
      extracted: {
        object_type: "invoice",
        merge_integration: "NetSuite",
        objects: [
          {
            id: "merge_inv_77",
            remote_id: "netsuite-4411",
            type: "ACCOUNTS_PAYABLE",
            contact: VENDOR_NAME,
            number: "BILL-2031",
            // Net-terms drift vs the document's stated due date: keeps the
            // bill a distinct observation row. With IDENTICAL (counterparty,
            // type, amount, currency, due_date) the obligation writer's dedup
            // key collapses the two observations into one row — discovered on
            // this test's first live run; Phase 4 resolution makes that merge
            // explicit and evidence-preserving instead of key-coincidental.
            due_date: "2026-07-03T00:00:00Z",
            total_amount: "1250.00",
            balance: "1250.00",
            currency: "USD",
            status: "OPEN",
            line_items: [{ account: "gl-6100-equipment", description: "Hydraulic press parts" }],
          },
        ],
      },
      confidence: null,
    });
    await ledger.normalizeFromRaw(ctx, bill.prsId);

    const billObligation = await obligationByEvidence(bill.prsId);
    expect(billObligation.provenance).toBe("extracted");
    expect(billObligation.direction).toBe("payable");
    const merge = (billObligation.metadata as { merge?: Record<string, unknown> }).merge!;
    expect(merge["gl_accounts"]).toEqual(["gl-6100-equipment"]); // GL coding preserved
    expect(merge["remote_id"]).toBe("netsuite-4411"); // original source visible

    // The vendor record: document tier and aggregator resolved to ONE
    // counterparty (normalized-name + type dedup) — the wedge's join point.
    const docObligation = await obligationByEvidence(doc.prsId);
    expect(billObligation.counterparty_id).toBe(docObligation.counterparty_id);
  });

  it("3 — Plaid lands the live cash position and prior payments to the vendor as extracted truth", async () => {
    bank = await landParsedArtifact({
      sourceType: "plaid",
      sourceSchema: "plaid.transactions_sync.v1",
      parser: "plaid_tx_v1",
      extracted: {
        accounts: [
          {
            account_id: "plaid_acc_ops",
            name: "Operating Checking",
            type: "depository",
            iso_currency_code: "USD",
            balances: { current: 84000, available: 84000 },
          },
        ],
        transactions: [
          {
            transaction_id: "plaid_tx_prior_1",
            account_id: "plaid_acc_ops",
            amount: 1250,
            iso_currency_code: "USD",
            date: "2026-05-01",
            name: "ACH ACME INDUSTRIAL SUPPLY",
            merchant_name: VENDOR_NAME,
          },
        ],
      },
      confidence: null,
    });
    await ledger.normalizeFromRaw(ctx, bank.prsId);

    const { account, tx } = await withTenantScope(pool, TENANT, async (c) => {
      const a = await c.query(
        `SELECT id, available_balance, provenance FROM ledger_accounts
          WHERE external_account_id = 'plaid_acc_ops' LIMIT 1`,
      );
      const t = await c.query(
        `SELECT id, direction, provenance, amount FROM ledger_transactions
          WHERE external_transaction_id = 'plaid_tx_prior_1' LIMIT 1`,
      );
      return { account: a.rows[0], tx: t.rows[0] };
    });
    expect(account.provenance).toBe("extracted");
    expect(Number(account.available_balance)).toBe(84000); // live cash position
    expect(tx.provenance).toBe("extracted");
    expect(tx.direction).toBe("outflow"); // a prior payment to the vendor
  });

  it("4 — the gate REFUSES auto-execution on document-only evidence, keeping confirm open", async () => {
    const docObligation = await obligationByEvidence(doc.prsId);
    const deps = gateDeps(docObligation.counterparty_id, "allow");
    const result = await runPreExecutionGate(deps, {
      ctx,
      principal: AGENT_PRINCIPAL,
      intent: intentFor(docObligation),
      dryRun: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedCheck.index).toBe(9.5);
      const failures = (result.failedCheck.detail as { failures: Array<{ rule: string }> })
        .failures;
      expect(failures.map((f) => f.rule)).toContain("low_trust_auto_execution");
    }

    // The confirm flow stays open: explicit user approval is the wedge's
    // required path before any write rail executes a payment.
    const confirm = await runPreExecutionGate(gateDeps(docObligation.counterparty_id, "confirm"), {
      ctx,
      principal: AGENT_PRINCIPAL,
      intent: intentFor(docObligation),
      dryRun: true,
    });
    expect(confirm.ok).toBe(true);
    if (confirm.ok) expect(confirm.outcome).toBe("confirm");
  });

  it("5 — corroboration against the bank's prior payment promotes the payable; the gate then allows", async () => {
    const docObligation = await obligationByEvidence(doc.prsId);
    const txId = await withTenantScope(pool, TENANT, async (c) => {
      const { rows } = await c.query(
        `SELECT id FROM ledger_transactions WHERE external_transaction_id = 'plaid_tx_prior_1' LIMIT 1`,
      );
      return (rows[0] as { id: string }).id;
    });

    // The corroboration write-back (RFC 0004 §7.1). The matcher that pairs an
    // AP bill with its bank debit end-to-end is Phase 4 resolution work; the
    // write-back contract it will call is exercised here directly.
    const match = await persistMatch(pool, audit, ctx, {
      matchType: "invoice_payment",
      leftEntityType: "obligation",
      leftEntityId: docObligation.id,
      rightEntityType: "transaction",
      rightEntityId: txId,
      confidenceScore: 0.82,
      evidenceIds: [doc.prsId, bank.prsId],
      explanation:
        "document invoice amount/vendor matches the bank's prior ACH payment to the same vendor",
    });
    expect(match.created).toBe(true);

    const promoted = await obligationByEvidence(doc.prsId);
    expect(promoted.provenance).toBe("extracted"); // agent_contributed -> extracted
    expect(promoted.confidence).toBeCloseTo(0.82, 5); // lifted toward the match score

    const result = await runPreExecutionGate(gateDeps(promoted.counterparty_id, "allow"), {
      ctx,
      principal: AGENT_PRINCIPAL,
      intent: intentFor(promoted),
      dryRun: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outcome).toBe("allow");
      expect(result.checks.find((c) => c.index === 9.5)?.passed).toBe(true);
    }
  });

  it("6 — the reconciled payable carries evidence references to every source", async () => {
    const docObligation = await obligationByEvidence(doc.prsId);
    const billObligation = await obligationByEvidence(bill.prsId);

    // One review surface, three sources:
    //  - the invoice document backs the doc payable,
    expect(docObligation.evidence_ids).toContain(doc.prsId);
    //  - the aggregator bill backs the extracted payable on the same vendor,
    expect(billObligation.evidence_ids).toContain(bill.prsId);
    expect(billObligation.counterparty_id).toBe(docObligation.counterparty_id);
    //  - and the bank's prior payment backs the corroboration match row.
    const matchRow = await withTenantScope(pool, TENANT, async (c) => {
      const { rows } = await c.query(
        `SELECT evidence_ids FROM ledger_reconciliation_matches
          WHERE left_entity_id = $1 LIMIT 1`,
        [docObligation.id],
      );
      return rows[0] as { evidence_ids: string[] };
    });
    expect(matchRow.evidence_ids).toEqual(expect.arrayContaining([doc.prsId, bank.prsId]));

    // Phase 4 boundary, stated rather than hidden: the doc payable and the
    // aggregator bill are still two obligation rows joined by the vendor;
    // obligation-to-obligation resolution (one reconciled fact with all
    // observations retained) is the Phase 4 resolution stage's AC.
    expect(docObligation.id).not.toBe(billObligation.id);
  });

  // ---------------------------------------------------------------------
  // Gate wiring: SQL-backed loaders mirroring services/api gate-loaders.
  // ---------------------------------------------------------------------

  const AGENT_PRINCIPAL: GatePrincipal = {
    id: "agent_wedge",
    type: "agent",
    scopes: ["payment_intent:execute"],
  };

  function intentFor(obligation: { id: string; counterparty_id: string }): GatePaymentIntent {
    return {
      id: "pi_WEDGE",
      owner_id: TENANT,
      created_by_agent_id: "agent_wedge",
      action_type: "ach_outbound",
      source_account_id: "acct_ops",
      destination_counterparty_id: obligation.counterparty_id,
      amount: "1250.00",
      currency: "USD",
      status: "approved",
      policy_decision_id: null,
      evidence_ids: [doc.prsId],
      obligation_id: obligation.id,
    };
  }

  function gateDeps(counterpartyId: string, outcome: "allow" | "confirm"): GateDependencies {
    const agent: GateAgent = {
      id: "agent_wedge",
      state: "active",
      scope: { canExecutePayments: true },
      max_risk_level: "low",
    };
    const account: GateAccount = {
      id: "acct_ops",
      status: "active",
      currency: "USD",
      available_balance: "84000.00",
    };
    const counterparty: GateCounterparty = {
      id: counterpartyId,
      type: "vendor",
      risk_level: "low",
      verified_status: "document_verified",
    };
    return {
      audit,
      resolveAgent: async () => agent,
      resolveAccount: async () => account,
      resolveCounterparty: async () => counterparty,
      evaluatePolicy: async (): Promise<GatePolicyDecision> => ({
        id: "pd_WEDGE",
        outcome,
        matched_rule_id: "wedge_rule",
        required_approvers: outcome === "confirm" ? ["owner"] : [],
        ledger_snapshot_hash: "0xwedge",
        trace: [],
      }),
      resolveApprovals: async (): Promise<GateApprovalState> => ({ signedRoles: ["owner"] }),
      // Mirrors makeResolveEvidence: trust derives from the artifact's
      // source_type, never the caller-chosen parser label.
      resolveEvidence: async (intent: GatePaymentIntent): Promise<ResolvedEvidence[]> =>
        withTenantScope(pool, TENANT, async (c) => {
          if (intent.evidence_ids.length === 0) return [];
          const { rows } = await c.query(
            `SELECT rp.id, rp.raw_artifact_id, rp.parser, ra.source_type, rp.extracted, rp.extracted_at
               FROM raw_parsed rp JOIN raw_artifacts ra ON ra.id = rp.raw_artifact_id
              WHERE rp.id = ANY($1::text[])`,
            [[...intent.evidence_ids]],
          );
          return rows.map(
            (r: {
              id: string;
              raw_artifact_id: string;
              parser: string;
              source_type: string;
              extracted: Record<string, unknown>;
              extracted_at: Date;
            }) => ({
              id: r.id,
              kind: r.parser,
              extracted: r.extracted,
              sourceArtifactId: r.raw_artifact_id,
              capturedAt: r.extracted_at,
              trustLevel:
                r.source_type === "plaid" || r.source_type === "stripe"
                  ? ("high" as const)
                  : [
                        "agent_contributed",
                        "csv_upload",
                        "pdf_upload",
                        "email_inbound",
                        "other",
                      ].includes(r.source_type)
                    ? ("low" as const)
                    : ("medium" as const),
            }),
          );
        }),
      resolveObligationProvenance: async (intent: GatePaymentIntent) =>
        withTenantScope(pool, TENANT, async (c) => {
          if (intent.obligation_id === null || intent.obligation_id === undefined) return null;
          const { rows } = await c.query(
            `SELECT provenance FROM ledger_obligations WHERE id = $1 LIMIT 1`,
            [intent.obligation_id],
          );
          return (rows[0] as { provenance: string } | undefined)?.provenance ?? null;
        }),
    };
  }
});
