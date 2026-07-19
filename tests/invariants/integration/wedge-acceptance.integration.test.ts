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
 * Canonical cutover (RFC 0005): the aggregator bill no longer writes the
 * Ledger directly; it projects Raw -> canonical -> Ledger. Vendor identity is
 * canonical-source-keyed and link-not-merge, so the doc and bill vendors are
 * distinct observations unified by Phase-4 counterparty_duplicate resolution,
 * and obligation_duplicate matches across that resolved counterparty link.
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

import {
  LedgerService,
  persistMatch,
  rebuildAccountTransactionProjectionFromCanonical,
  ReconciliationService,
  rebuildAparProjectionFromCanonical,
  resolveCounterpartyView,
  resolveObligationView,
} from "@brain/ledger";
import { runProjectionCycle } from "@brain/canonical";
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
    // Post-cutover (RFC 0005): the document obligation projects through canonical
    // too (Raw -> canonical -> Ledger), staying low-trust so the §6 gate still
    // refuses it. normalizeFromRaw validates + consumes the row but writes no
    // Ledger rows; the projection materializes the obligation + counterparty.
    await ledger.normalizeFromRaw(ctx, doc.prsId);
    await runProjectionCycle({ pool, audit }, { batchSize: 50 });
    await rebuildAparProjectionFromCanonical(pool, audit, ctx);

    const obligation = await obligationByEvidence(doc.prsId);
    expect(obligation.provenance).toBe("agent_contributed");
    expect(obligation.confidence).toBeLessThanOrEqual(0.5); // §3.2 ceiling preserved through canonical
    expect(obligation.direction).toBe("payable");
    // Evidence references: the payable traces to the invoice document.
    expect(obligation.source_ids).toContain(doc.rawId);
    expect(obligation.evidence_ids).toContain(doc.prsId);
  });

  it("2 — the aggregator's open bill PROJECTS from canonical as an extracted payable with GL coding", async () => {
    // Post-cutover (RFC 0005): Merge invoices/contacts no longer write the
    // Ledger directly. They land in raw_parsed, the canonical projector promotes
    // them to the rich AP/AR domain, and the Ledger projection materializes the
    // obligation + counterparty. The aggregator syncs a contacts partition, so
    // the vendor arrives as its own contact page (the obligation references it
    // by the Merge contact id, not an embedded name).
    await landParsedArtifact({
      sourceType: "merge_accounting",
      sourceSchema: "merge_accounting.contacts.v1",
      parser: "merge_accounting_v1",
      extracted: {
        object_type: "contact",
        merge_integration: "NetSuite",
        objects: [
          { id: "merge_con_acme", remote_id: "ns-301", name: VENDOR_NAME, is_supplier: true },
        ],
      },
      confidence: null,
    });
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
            contact: "merge_con_acme",
            number: "BILL-2031",
            // Net-terms drift vs the document's stated due date keeps the bill a
            // distinct observation; Phase 4 resolution (step 4.5) unifies them.
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

    // Drive the real projection pipeline: Raw -> canonical -> Ledger.
    await runProjectionCycle({ pool, audit }, { batchSize: 50 });
    await rebuildAparProjectionFromCanonical(pool, audit, ctx);

    const billObligation = await obligationByEvidence(bill.prsId);
    expect(billObligation.provenance).toBe("extracted");
    expect(billObligation.direction).toBe("payable");
    const merge = (billObligation.metadata as { merge?: Record<string, unknown> }).merge!;
    expect(merge["gl_accounts"]).toEqual(["gl-6100-equipment"]); // GL coding preserved
    expect(merge["remote_id"]).toBe("netsuite-4411"); // original source visible

    // Identity is canonical-source-keyed and link-not-merge (§13): the bill's
    // vendor is a DISTINCT observation from the document tier's, sharing a
    // normalized name. Phase 4 counterparty resolution (step 7) unifies them
    // into one organization — they are no longer collapsed at creation time.
    const docObligation = await obligationByEvidence(doc.prsId);
    expect(billObligation.counterparty_id).not.toBe(docObligation.counterparty_id);
    const names = await withTenantScope(pool, TENANT, async (c) => {
      const { rows } = await c.query<{ normalized_name: string }>(
        `SELECT normalized_name FROM ledger_counterparties WHERE id = ANY($1::text[])`,
        [[billObligation.counterparty_id, docObligation.counterparty_id]],
      );
      return rows.map((r) => r.normalized_name);
    });
    expect(new Set(names).size).toBe(1); // same normalized name = the resolution join key
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
    await runProjectionCycle({ pool, audit }, { batchSize: 50 });
    await rebuildAparProjectionFromCanonical(pool, audit, ctx);
    await rebuildAccountTransactionProjectionFromCanonical(pool, ctx.tenantId);

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

  it("4.5 — Phase 4: the doc payable and the aggregator bill resolve into ONE reconciled fact, observations retained", async () => {
    const docObligation = await obligationByEvidence(doc.prsId);
    const billObligation = await obligationByEvidence(bill.prsId);

    // The REAL resolution pipeline: ReconciliationService runs the
    // obligation_duplicate matcher over Ledger state.
    const recon = new ReconciliationService({ pool, audit });
    // Counterparty resolution first: under canonical projection the doc and bill
    // vendors are distinct observations, so obligation matching across sources
    // follows the resolved counterparty link (link, don't merge).
    await recon.run(ctx, { match_types: ["counterparty_duplicate"] });
    await recon.run(ctx, { match_types: ["obligation_duplicate"] });

    const view = await resolveObligationView(pool, ctx, docObligation.id);
    expect(view).not.toBeNull();

    // One economic event, three sources, one reconciled fact — with ALL
    // observations retained (the Phase 4 AC).
    expect(view!.observations.map((o) => o.obligation_id).sort()).toEqual(
      [docObligation.id, billObligation.id].sort(),
    );
    expect(view!.matches).toHaveLength(1);

    // Field-level authority (§13): the accounting observation owns the
    // billing terms and GL coding.
    expect(view!.resolved.due_date.authority_obligation_id).toBe(billObligation.id);
    expect(view!.resolved.due_date.authority_provenance).toBe("extracted");
    expect(view!.resolved.gl_accounts?.value).toEqual(["gl-6100-equipment"]);
    expect(Number(view!.resolved.amount_due.value)).toBe(1250); // NUMERIC scale varies

    // The due-date disagreement (document says 07-01, ERP says 07-03) is
    // LISTED as a conflict, never overwritten on either row.
    expect(view!.conflicts.map((c) => c.field)).toEqual(["due_date"]);
    expect(view!.conflicts[0]!.values).toHaveLength(2);

    // Resolution corroborated the doc payable from the bill (independent,
    // extracted): provenance promoted before the bank evidence even arrives.
    const promoted = await obligationByEvidence(doc.prsId);
    expect(promoted.provenance).toBe("extracted");
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
    expect(promoted.provenance).toBe("extracted");
    // Upward-only across BOTH corroborations (resolution lift, then bank).
    expect(promoted.confidence).toBeGreaterThanOrEqual(0.82);
    expect(promoted.confidence).toBeLessThanOrEqual(0.9);

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
    //  - the aggregator bill backs the extracted payable (a distinct vendor
    //    observation, unified with the doc vendor by Phase-4 resolution),
    expect(billObligation.evidence_ids).toContain(bill.prsId);
    expect(billObligation.counterparty_id).not.toBe(docObligation.counterparty_id);
    //  - and the bank's prior payment backs the corroboration match row.
    const matchRow = await withTenantScope(pool, TENANT, async (c) => {
      const { rows } = await c.query(
        `SELECT evidence_ids FROM ledger_reconciliation_matches
          WHERE left_entity_id = $1 AND match_type = 'invoice_payment' LIMIT 1`,
        [docObligation.id],
      );
      return rows[0] as { evidence_ids: string[] };
    });
    expect(matchRow.evidence_ids).toEqual(expect.arrayContaining([doc.prsId, bank.prsId]));

    // Phase 4 landed: the two rows REMAIN distinct observations (never
    // destructively merged) and the obligation_duplicate match + resolved
    // view (step 4.5) are what unify them into one reconciled fact.
    expect(docObligation.id).not.toBe(billObligation.id);
  });

  it("7 — entity resolution: the Plaid merchant and the vendor record resolve to ONE organization", async () => {
    const docObligation = await obligationByEvidence(doc.prsId);

    // Plaid's extractor landed the prior payment's merchant as its own
    // counterparty row (type merchant); the vendor record came from the
    // document + aggregator. Same organization, two observations.
    const recon = new ReconciliationService({ pool, audit });
    await recon.run(ctx, { match_types: ["counterparty_duplicate"] });

    const view = await resolveCounterpartyView(pool, ctx, docObligation.counterparty_id);
    expect(view).not.toBeNull();
    expect(view!.observations.length).toBeGreaterThanOrEqual(2);
    expect(view!.resolved.types).toEqual(expect.arrayContaining(["merchant", "vendor"]));
    // Every observation retained; the link is reversible, nothing merged.
    expect(view!.resolved.member_ids).toContain(docObligation.counterparty_id);
    expect(view!.matches.length).toBeGreaterThanOrEqual(1);
    // The canonical name comes from an independent observation with authority.
    expect(view!.resolved.name.value).toBe(VENDOR_NAME);
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
