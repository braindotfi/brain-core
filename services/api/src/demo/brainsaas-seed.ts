/**
 * BrainSaaS demo seed — provisions the three-scenario SaaS business that the
 * "Brain Playground" demo runs on, so brain-core is the single source of
 * truth and BrainSaaS carries no business seed data of its own.
 *
 * This dataset mirrors the reference formerly hard-coded in
 * `BrainSaaS/artifacts/api-server/src/lib/brain/seed.ts` (now being deleted),
 * mapped onto real brain-core layers:
 *
 *   Ledger    — 6 vendor + 4 customer counterparties, 2 bank accounts
 *               (operating + reserve), 3 AP invoices (the "inbox"), 3 AR
 *               invoices (overdue + current) that drive computed
 *               outstanding/days-overdue, and a per-customer monthly inflow
 *               history (cleared transactions) so the AR anomaly is derived from
 *               real payment-timing drift, not a flag.
 *   Metadata  — the scenario fields with no native ledger column live in the
 *               Ledger `metadata` JSONB (v0.3: truth lives in Ledger): per-vendor
 *               monthly ceiling + approved flag on the counterparty, per-customer
 *               relationship enrichment (tenure / MRR / late history)
 *               on the counterparty, per-AP-invoice flags + PO on the invoice.
 *               The operating buffer is a Treasury *policy* parameter; the
 *               yield-venue catalog is a global reference endpoint, not seeded.
 *   Policy    — one active policy whose rules express the AP / Treasury / AR
 *               behaviour the demo proves (approved≤$50k auto, approved>$50k
 *               confirm, unapproved reject, onchain + agent_action auto).
 *   Agent     — a registered Demo Payment Agent (onchain_address = the shared
 *               BrainSmartAccount when BRAIN_ONCHAIN_SMART_ACCOUNT is set).
 *
 * Off-chain only: on-chain policy registration + settlement are layered on in
 * later phases (the demo's provision-run endpoint / the onchain_base rail).
 * Ledger writes go through the v0.3 write helpers; invoices, documents, the
 * policy and the agent use tenant-scoped SQL (no helper exists yet), exactly as
 * the golden-path seed does.
 */

import { createHash } from "node:crypto";
import {
  recordTransactionRow,
  upsertAccountRow,
  upsertCounterpartyRow,
  type AccountRow,
  type CounterpartyRow,
} from "@brain/ledger";
import {
  computeAgentScopeHash,
  newAgentId,
  newDocumentId,
  newInvoiceId,
  newPolicyId,
  newRawArtifactId,
  newRawParsedId,
  PAYMENT_AGENT_SCOPES,
  withTenantScope,
  type AuditEmitter,
  type ServiceCallContext,
} from "@brain/shared";
import { insertAgentProposal, type InsertAgentProposalInput } from "@brain/execution";
import type { Pool } from "pg";
import { insertBootstrapAdminMember } from "../onboarding/bootstrap-member.js";

// ---------------------------------------------------------------------------
// Reference dataset (mirrors the former BrainSaaS seed.ts).
// ---------------------------------------------------------------------------

interface VendorSpec {
  key: string;
  name: string;
  monthly_ceiling: number;
  approved: boolean;
}

/** 5 approved vendors + 1 unapproved ("Quick Pay Solutions") used as the
 *  flagged/suspicious AP invoice that the policy rejects. */
const VENDORS: VendorSpec[] = [
  { key: "cloudops", name: "CloudOps Inc", monthly_ceiling: 25000, approved: true },
  { key: "stripelike", name: "Stripe-Like Co", monthly_ceiling: 8000, approved: true },
  { key: "legal", name: "Legal Partners LLP", monthly_ceiling: 40000, approved: true },
  { key: "office", name: "Office Supplies Direct", monthly_ceiling: 3000, approved: true },
  { key: "datacenter", name: "Datacenter Hosting Ltd", monthly_ceiling: 60000, approved: true },
  { key: "quickpay", name: "Quick Pay Solutions", monthly_ceiling: 0, approved: false },
];

interface CustomerSpec {
  key: string;
  name: string;
  terms: string;
  /** Drives the AR invoice amount (outstanding is computed from invoices). */
  outstanding_usd: number;
  /** Drives the AR invoice due_date (days_overdue is computed from it). */
  days_overdue: number;
  tenure_months: number;
  mrr_usd: number;
  late_payment_history: number;
  usage_trend: "growing" | "stable" | "declining";
  last_contact_days_ago: number;
  notes: string;
  risk_level: "low" | "medium" | "high";
  verified_status: "document_verified" | "self_attested" | "unverified";
  /**
   * Day-of-month each monthly inflow settled, oldest→newest. When set, the seed
   * inserts one `cleared` inflow ledger_transaction per entry so the AR anomaly
   * check is data-derived (drift = the day-of-month creeping later) rather than a
   * scripted flag. Omit for customers with no seeded payment history.
   */
  payment_days?: number[];
  /** Per-cycle inflow amount; defaults to `mrr_usd`. */
  monthly_payment?: number;
}

const CUSTOMERS: CustomerSpec[] = [
  {
    key: "bigco",
    name: "BigCo Industries",
    terms: "net-30",
    outstanding_usd: 145000,
    days_overdue: 0,
    tenure_months: 38,
    mrr_usd: 48000,
    late_payment_history: 1,
    usage_trend: "growing",
    last_contact_days_ago: 12,
    notes:
      "Strategic enterprise account. Pays on time historically. Procurement is slow but reliable.",
    risk_level: "low",
    verified_status: "document_verified",
    // Payment window creeps later each cycle (day 10 → 26) — the live AR drift signal.
    payment_days: [10, 13, 17, 21, 26],
  },
  {
    key: "midmarket",
    name: "Midmarket Solutions",
    terms: "net-30",
    outstanding_usd: 42000,
    days_overdue: 18,
    tenure_months: 14,
    mrr_usd: 14000,
    late_payment_history: 3,
    usage_trend: "stable",
    last_contact_days_ago: 21,
    notes: "Reliable mid-market. Occasional 2-3 week lag during quarter-end.",
    risk_level: "medium",
    verified_status: "self_attested",
  },
  {
    key: "startupx",
    name: "StartupX",
    terms: "net-15",
    outstanding_usd: 8000,
    days_overdue: 32,
    tenure_months: 6,
    mrr_usd: 2400,
    late_payment_history: 5,
    usage_trend: "declining",
    last_contact_days_ago: 38,
    notes: "Series A startup. Cash-strapped. Two prior payment plans negotiated.",
    risk_level: "medium",
    verified_status: "self_attested",
  },
  {
    key: "enterprise",
    name: "Enterprise Holdings",
    terms: "net-45",
    outstanding_usd: 290000,
    days_overdue: 0,
    tenure_months: 52,
    mrr_usd: 96000,
    late_payment_history: 0,
    usage_trend: "stable",
    last_contact_days_ago: 4,
    notes: "Anchor account. Pays reliably on day 44 of every cycle.",
    risk_level: "low",
    verified_status: "document_verified",
    // Pays the same day every cycle — clean control: no drift, no anomaly.
    payment_days: [14, 14, 14, 14, 14],
  },
];

interface ApInvoiceSpec {
  vendorKey: string;
  invoice_number: string;
  po: string | null;
  amount: number;
  due_in_days: number;
  flags: string[];
}

/** The AP "inbox". PO has no native column, so it is carried in the invoice
 *  `metadata` alongside the document-analysis flags. */
const AP_INVOICES: ApInvoiceSpec[] = [
  {
    vendorKey: "cloudops",
    invoice_number: "INV-CLOUDOPS-001",
    po: "PO-2387",
    amount: 19400,
    due_in_days: 7,
    flags: [],
  },
  {
    vendorKey: "datacenter",
    invoice_number: "INV-DATACENTER-002",
    po: "PO-9912",
    amount: 187000,
    due_in_days: 4,
    flags: [],
  },
  {
    vendorKey: "quickpay",
    invoice_number: "INV-QUICKPAY-003",
    po: null,
    amount: 4800,
    due_in_days: -4,
    flags: ["urgency_language", "new_wire_instructions", "no_po"],
  },
];

// Yield venues + buffer note: the yield-venue catalog is public market data
// served by a brain-core reference endpoint (Phase B), not seeded per tenant.
// The operating buffer below is a Treasury *policy* parameter (see seedPolicy).

const OPERATING_BALANCE = "1687200.00";
const RESERVE_BALANCE = "1200000.00";
const OPERATING_BUFFER_MIN = "250000.00";

// Demo on-chain settlement recipient. Approved vendors carry this as an ETH
// `aliases` entry so the onchain_base rail's param resolver (main.ts) finds a
// transfer target; the AP "marquee" payment settles a tiny symbolic ETH amount
// here on Base Sepolia (Phase D). It MUST equal the address the BrainSmartAccount
// session key is granted to send to (allowedTargets), set via the
// BRAIN_DEMO_ONCHAIN_RECIPIENT env var — otherwise executeViaSessionKey reverts
// with TargetNotAllowed. The amount is symbolic (the USD figure is the business
// amount; the tx is settlement-rail proof). Fallback is the testnet demo holder.
const DEMO_SETTLEMENT_RECIPIENT_FALLBACK = "0x41D4ce9D9Fe968Ca1230bDc296B28fdc9AA6FF6E";

// ---------------------------------------------------------------------------

export interface BrainSaasSeed {
  tenantId: string;
  actor: string;
  vendors: Record<string, string>; // key -> counterparty id
  customers: Record<string, string>; // key -> counterparty id
  accounts: { operating: string; reserve: string; smartAccount: string | null };
  apInvoices: Record<string, string>; // vendorKey -> invoice id
  arInvoices: Record<string, string>; // customerKey -> invoice id
  policyId: string;
  agentId: string;
}

const NOW = new Date();
function daysAgo(n: number): Date {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}
function daysFrom(n: number): Date {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}
/** `monthsBack` calendar months before NOW, pinned to the given day-of-month. */
function monthsAgoOnDay(monthsBack: number, day: number): Date {
  const d = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - monthsBack, day));
  return d;
}

export async function seedBrainSaasDemo(
  pool: Pool,
  audit: AuditEmitter,
  tenantId: string,
  actor: string,
): Promise<BrainSaasSeed> {
  const ctx: ServiceCallContext = { tenantId, actor };
  const sourceIds = [newRawArtifactId()];
  const evidenceIds = [newRawParsedId()];
  const settlementRecipient =
    process.env["BRAIN_DEMO_ONCHAIN_RECIPIENT"] ?? DEMO_SETTLEMENT_RECIPIENT_FALLBACK;

  // ---------- Counterparties (vendors + customers) ----------
  const vendors: Record<string, CounterpartyRow> = {};
  for (const v of VENDORS) {
    const { row } = await upsertCounterpartyRow(pool, audit, ctx, {
      name: v.name,
      type: "vendor",
      risk_level: v.approved ? "low" : "high",
      verified_status: v.approved ? "document_verified" : "unverified",
      // Approved vendors carry the demo ETH settlement target so the onchain_base
      // rail can dispatch a real Base Sepolia transfer (Phase D). Unapproved
      // vendors get none — they're rejected by policy and never settle.
      aliases: v.approved ? [settlementRecipient] : [],
      // Non-native AP fields live on the counterparty (v0.3: truth in Ledger).
      metadata: { scenario: "ap", monthly_ceiling: v.monthly_ceiling, approved: v.approved },
      source_ids: sourceIds,
      evidence_ids: evidenceIds,
      provenance: "extracted",
      confidence: 0.95,
    });
    vendors[v.key] = row;
  }
  const customers: Record<string, CounterpartyRow> = {};
  for (const c of CUSTOMERS) {
    const { row } = await upsertCounterpartyRow(pool, audit, ctx, {
      name: c.name,
      type: "customer",
      risk_level: c.risk_level,
      verified_status: c.verified_status,
      // AR relationship enrichment used for tone-matching + the anomaly branch.
      metadata: {
        scenario: "ar",
        terms: c.terms,
        tenure_months: c.tenure_months,
        mrr_usd: c.mrr_usd,
        late_payment_history: c.late_payment_history,
        usage_trend: c.usage_trend,
        last_contact_days_ago: c.last_contact_days_ago,
        notes: c.notes,
      },
      source_ids: sourceIds,
      evidence_ids: evidenceIds,
      provenance: "extracted",
      confidence: 0.95,
    });
    customers[c.key] = row;
  }

  // The counterparty INSERT trigger (migration 0027) stamps a payment-instruction
  // history row at now() for every counterparty, which the §6 gate check 11.5
  // rule 6 (destination_recently_changed) reads as a 24h fraud signal. But these
  // are long-established demo vendors (see the tenure metadata), not a recent
  // account swap — so backdate the seed-time rows out of the fraud window. A real
  // destination change during a run still stamps now() and is still flagged.
  await withTenantScope(pool, tenantId, async (c) => {
    await c.query(
      `UPDATE ledger_counterparty_payment_instructions
         SET changed_at = now() - interval '30 days'
       WHERE owner_id = $1`,
      [tenantId],
    );
  });

  // ---------- Accounts (operating + reserve, optional onchain) ----------
  const operating = (
    await upsertAccountRow(pool, audit, ctx, {
      external_account_id: "brainsaas_operating",
      institution: "Mercury",
      account_type: "bank_checking",
      name: "Operating",
      currency: "USD",
      current_balance: OPERATING_BALANCE,
      available_balance: OPERATING_BALANCE,
      status: "active",
      source_ids: sourceIds,
      evidence_ids: evidenceIds,
      provenance: "extracted",
      confidence: 0.95,
    })
  ).row;
  const reserve = (
    await upsertAccountRow(pool, audit, ctx, {
      external_account_id: "brainsaas_reserve",
      institution: "Mercury",
      account_type: "bank_savings",
      name: "Reserve",
      currency: "USD",
      current_balance: RESERVE_BALANCE,
      available_balance: RESERVE_BALANCE,
      status: "active",
      source_ids: sourceIds,
      evidence_ids: evidenceIds,
      provenance: "extracted",
      confidence: 0.95,
    })
  ).row;

  const smartAccountAddr = process.env["BRAIN_ONCHAIN_SMART_ACCOUNT"];
  let smartAccount: AccountRow | null = null;
  if (smartAccountAddr) {
    smartAccount = (
      await upsertAccountRow(pool, audit, ctx, {
        external_account_id: smartAccountAddr,
        institution: "Base Sepolia",
        account_type: "onchain",
        name: "Brain Smart Account (ETH)",
        currency: "ETH",
        current_balance: "0.005",
        available_balance: "0.005",
        status: "active",
        source_ids: sourceIds,
        evidence_ids: evidenceIds,
        provenance: "extracted",
        confidence: 0.99,
      })
    ).row;
  }

  // Registered demo payment agent. Agents are propose-only principals and must
  // never be member-resolvable. The bootstrap admin member is the human actor
  // passed by the provision-run route, which receives a separate user session.
  const agentId = await seedAgent(pool, tenantId);

  // Default AP funding account — the P0.5 invoice-shortcut resolver needs one.
  // Tenant-scoped: the `tenants` RLS write policy is WITH CHECK (id =
  // app.tenant_id), so the row must be inserted inside the tenant's scope (the
  // app role has RLS forced on — a raw pool.query would violate the policy).
  await withTenantScope(pool, tenantId, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, kind, default_ap_account_id) VALUES ($1, 'demo', $2)
       ON CONFLICT (id) DO UPDATE SET default_ap_account_id = EXCLUDED.default_ap_account_id`,
      [tenantId, operating.id],
    );
    await insertBootstrapAdminMember(c, {
      tenantId,
      memberId: actor,
      email: null,
      displayName: "Bootstrap Admin",
    });
  });

  // ---------- Invoices (AP inbox + AR receivables) + per-AP-invoice docs ----------
  const apInvoices: Record<string, string> = {};
  const arInvoices: Record<string, string> = {};
  const apInvoiceDocs: Record<string, string> = {};

  await withTenantScope(pool, tenantId, async (c) => {
    // AP invoices — money WE owe vendors. One source document each so the
    // invoice-shortcut resolver can fund a payment in Phase D.
    for (const inv of AP_INVOICES) {
      const docId = newDocumentId();
      await c.query(
        `INSERT INTO ledger_documents (
           id, owner_id, document_type, source_uri, extracted_fields,
           linked_account_ids, linked_transaction_ids, linked_obligation_ids,
           source_ids, evidence_ids, provenance, confidence
         ) VALUES ($1,$2,'invoice','blob://invoices/' || $1 || '.pdf',
                   $3, $4, ARRAY[]::TEXT[], ARRAY[]::TEXT[], $5, $6, 'extracted', 0.9)`,
        [
          docId,
          tenantId,
          JSON.stringify({
            amount: inv.amount,
            currency: "USD",
            po: inv.po,
            vendor: VENDORS.find((v) => v.key === inv.vendorKey)?.name,
          }),
          [operating.id],
          sourceIds,
          evidenceIds,
        ],
      );
      apInvoiceDocs[inv.vendorKey] = docId;

      const id = newInvoiceId();
      await c.query(
        `INSERT INTO ledger_invoices (
           id, owner_id, invoice_number, counterparty_id,
           amount_due, amount_paid, currency, issue_date, due_date, status,
           source_ids, evidence_ids, linked_document_ids, provenance, confidence, metadata
         ) VALUES ($1,$2,$3,$4,$5,'0.00','USD',$6,$7,$8,$9,$10,$11,'extracted',0.9,$12::jsonb)`,
        [
          id,
          tenantId,
          inv.invoice_number,
          vendors[inv.vendorKey]!.id,
          inv.amount.toFixed(2),
          daysAgo(14),
          inv.due_in_days < 0 ? daysAgo(-inv.due_in_days) : daysFrom(inv.due_in_days),
          inv.due_in_days < 0 ? "overdue" : "sent",
          sourceIds,
          evidenceIds,
          [docId],
          // Document-analysis flags + PO (no native ledger column).
          JSON.stringify({ scenario: "ap", po: inv.po, flags: inv.flags }),
        ],
      );
      apInvoices[inv.vendorKey] = id;
    }

    // AR invoices — money owed TO us. Amount = outstanding, due_date set so the
    // computed days_overdue matches the customer spec.
    for (const cust of CUSTOMERS) {
      const id = newInvoiceId();
      await c.query(
        `INSERT INTO ledger_invoices (
           id, owner_id, invoice_number, counterparty_id,
           amount_due, amount_paid, currency, issue_date, due_date, status,
           source_ids, evidence_ids, linked_document_ids, provenance, confidence
         ) VALUES ($1,$2,$3,$4,$5,'0.00','USD',$6,$7,$8,$9,$10,ARRAY[]::TEXT[],'extracted',0.88)`,
        [
          id,
          tenantId,
          `AR-${cust.key.toUpperCase()}-001`,
          customers[cust.key]!.id,
          cust.outstanding_usd.toFixed(2),
          daysAgo(cust.days_overdue + 30),
          cust.days_overdue > 0 ? daysAgo(cust.days_overdue) : daysFrom(15),
          cust.days_overdue > 0 ? "overdue" : "sent",
          sourceIds,
          evidenceIds,
        ],
      );
      arInvoices[cust.key] = id;
    }
  });

  // ---------- Monthly inflow history (AR anomaly signal) ----------
  // For each customer with a seeded `payment_days`, post one `cleared` inflow per
  // cycle onto the operating account. The wiki Q&A grounds in these rows, and the
  // BrainSaaS AR agent derives the payment-window-drift anomaly from the dates —
  // so the "agent noticed the drift" is data-derived, not a scripted flag. The
  // memo names the customer because the wiki evidence row only carries `cp=<id>`.
  for (const cust of CUSTOMERS) {
    if (cust.payment_days === undefined) continue;
    const amount = (cust.monthly_payment ?? cust.mrr_usd).toFixed(2);
    const cpId = customers[cust.key]!.id;
    // Oldest cycle first: payment_days[0] is the furthest back.
    const cycles = cust.payment_days.length;
    for (let i = 0; i < cycles; i++) {
      const monthsBack = cycles - i;
      await recordTransactionRow(pool, audit, ctx, {
        account_id: operating.id,
        external_transaction_id: `brainsaas_${cust.key}_inflow_${monthsBack}`,
        amount,
        currency: "USD",
        direction: "inflow",
        transaction_date: monthsAgoOnDay(monthsBack, cust.payment_days[i]!).toISOString(),
        counterparty_id: cpId,
        status: "cleared",
        description_normalized: `${cust.name} monthly payment`,
        source_ids: sourceIds,
        evidence_ids: evidenceIds,
        provenance: "extracted",
        confidence: 0.95,
      });
    }
  }

  // ---------- Active policy (off-chain; on-chain registration is a later phase) ----------
  const approvedVendorCpIds = VENDORS.filter((v) => v.approved).map((v) => vendors[v.key]!.id);
  const policyId = await seedPolicy(pool, tenantId, actor, approvedVendorCpIds);

  // ---------- Non-financial agent proposals (BRAIN-CORE-ORCHESTRATION-GAP.md §3) ----------
  await seedAgentProposals(pool, tenantId, agentId, { vendors, customers });

  return {
    tenantId,
    actor,
    vendors: mapIds(vendors),
    customers: mapIds(customers),
    accounts: {
      operating: operating.id,
      reserve: reserve.id,
      smartAccount: smartAccount?.id ?? null,
    },
    apInvoices,
    arInvoices,
    policyId,
    agentId,
  };
}

function mapIds(rows: Record<string, CounterpartyRow>): Record<string, string> {
  return Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.id]));
}

// ---------------------------------------------------------------------------
// Policy — AP / Treasury / AR rules in one active policy document. Reproduces
// the scenario governance the pre-integration BrainSaaS seed expressed, mapped
// onto the brain-core DSL primitives the standalone evaluator can check.
//   AP (outbound_payment): approved & ≤$50k → auto(allow); approved & >$50k →
//        confirm(escalate, ≈ dual_key_above_50k); unapproved → reject
//        (≈ vendor_approved).
//   Treasury (onchain_tx): large deploy >$250k USD → confirm (≈ buffer /
//        concentration breach escalation); otherwise auto. The marquee AP
//        settlement is a symbolic ETH transfer — its currency never matches the
//        USD threshold, so it stays auto and the verified money path is intact.
//   AR (agent_action): outstanding >$500k → confirm (≈ approval_above_500k);
//        otherwise auto.
// The buffer minimum, per-venue concentration cap, approved-venue list, the
// 7-day chase window, and relationship tone are NOT brain-core gate primitives
// (no DSL/Ledger column expresses them) — they remain advisory, orchestrator-
// side checks in BrainSaaS. `params.operating_buffer_min` below is the one such
// value carried in the policy doc for the demo to read.
// Off-chain insert (mirrors the golden-path demo-governance seed). On-chain
// registration to BrainPolicyRegistry is layered on by the provision-run path.
// ---------------------------------------------------------------------------

async function seedPolicy(
  pool: Pool,
  tenantId: string,
  actor: string,
  approvedVendorCpIds: string[],
): Promise<string> {
  const policy = {
    version: 1,
    lists: { "vendors.approved": approvedVendorCpIds },
    // Treasury policy parameter (the VM ignores non-rule keys; read by the demo).
    params: { operating_buffer_min: OPERATING_BUFFER_MIN },
    rules: [
      {
        id: "ap-auto-approved-within",
        applies_to: ["outbound_payment"],
        when: {
          "counterparty.in": "vendors.approved",
          "amount.lte": { currency: "USD", value: "50000.00" },
        },
        execute: "auto",
      },
      {
        id: "ap-confirm-approved-large",
        applies_to: ["outbound_payment"],
        when: {
          "counterparty.in": "vendors.approved",
          "amount.gt": { currency: "USD", value: "50000.00" },
        },
        // Dual-key above $50k (≈ the old dual_key_above_50k): two distinct
        // approver roles must sign, not one.
        require: "owner_and_cfo",
        execute: "confirm",
      },
      {
        id: "ap-reject-unapproved",
        applies_to: ["outbound_payment"],
        when: { "counterparty.not_in": "vendors.approved" },
        execute: "reject",
      },
      // Treasury — a large on-chain deploy escalates (proxy for an operating-
      // buffer or per-venue concentration breach, which the DSL can't express
      // directly). USD-denominated so the symbolic ETH marquee settlement never
      // matches it and stays auto via treasury-auto-onchain below.
      {
        id: "treasury-confirm-large-deploy",
        applies_to: ["onchain_tx"],
        when: { "amount.gt": { currency: "USD", value: "250000.00" } },
        require: "owner_approval",
        execute: "confirm",
      },
      { id: "treasury-auto-onchain", applies_to: ["onchain_tx"], when: {}, execute: "auto" },
      // AR — chasing an account with very large outstanding requires approval
      // before any counterparty-facing action (≈ the old approval_above_500k).
      {
        id: "ar-confirm-above-500k",
        applies_to: ["agent_action"],
        when: { "amount.gt": { currency: "USD", value: "500000.00" } },
        require: "owner_approval",
        execute: "confirm",
      },
      { id: "ar-auto-agent-action", applies_to: ["agent_action"], when: {}, execute: "auto" },
    ],
  };
  const policyJson = JSON.stringify(policy);
  const policyHash = createHash("sha256").update(policyJson).digest();
  const policyId = newPolicyId();

  await withTenantScope(pool, tenantId, async (c) => {
    const v = await c.query<{ next: number }>(
      `SELECT COALESCE(MAX(version) + 1, 1) AS next FROM policies WHERE tenant_id = $1`,
      [tenantId],
    );
    await c.query(
      `UPDATE policies SET state = 'deactivated', deactivated_at = now() WHERE state = 'active'`,
    );
    await c.query(
      `INSERT INTO policies (id, tenant_id, version, content, content_hash, quorum_required, state, created_by, activated_at, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, 1, 'active', $6, now(), now())`,
      [policyId, tenantId, v.rows[0]?.next ?? 1, policyJson, policyHash, actor],
    );
  });
  return policyId;
}

async function seedAgent(pool: Pool, tenantId: string): Promise<string> {
  const smartAccount =
    process.env["BRAIN_ONCHAIN_SMART_ACCOUNT"] ?? "0x0000000000000000000000000000000000000000";
  // keccak256 over the sorted-joined payment scope set — the SAME value the
  // on-chain BrainMCPAgentRegistry holds (scripts/ops/register-prod-agent.ts)
  // and that MCP auth compares against. Written as raw 32 bytes because the
  // auth path hex-encodes this BYTEA column before the on-chain comparison.
  const scopeHash = Buffer.from(computeAgentScopeHash(PAYMENT_AGENT_SCOPES).slice(2), "hex");
  const agentId = newAgentId();
  await withTenantScope(pool, tenantId, async (c) => {
    await c.query(`DELETE FROM agents WHERE display_name = 'Demo Payment Agent'`);
    await c.query(
      `INSERT INTO agents (id, tenant_id, kind, role, display_name, scope_hash, onchain_address, state, registered_at, created_at, contribution_count, quarantine_threshold)
       VALUES ($1, $2, 'internal', 'payment', 'Demo Payment Agent', $3, $4, 'active', now(), now(), 0, 100)`,
      [agentId, tenantId, scopeHash, smartAccount],
    );
  });
  return agentId;
}

// ---------------------------------------------------------------------------
// Non-financial agent proposals (BRAIN-CORE-ORCHESTRATION-GAP.md §3). One row
// per proposal type, grounded in the vendors/customers/invoices seeded above
// (real amounts and names, no invented figures). The three notify_only types
// (compliance, revenue_intel, fraud_anomaly) always land in needs_review since
// notify_only never reaches acknowledged automatically. Four propose-mode
// rows are pre-decided (auto-approved) to show the reviewed/approved end
// state; the rest sit in needs_review awaiting a human decision.
// ---------------------------------------------------------------------------

async function seedAgentProposals(
  pool: Pool,
  tenantId: string,
  agentId: string,
  entities: {
    vendors: Record<string, CounterpartyRow>;
    customers: Record<string, CounterpartyRow>;
  },
): Promise<void> {
  const { vendors, customers } = entities;
  const cloudops = vendors["cloudops"]!;
  const quickpay = vendors["quickpay"]!;
  const datacenter = vendors["datacenter"]!;
  const stripelike = vendors["stripelike"]!;
  const bigco = customers["bigco"]!;
  const startupx = customers["startupx"]!;
  const midmarket = customers["midmarket"]!;

  type ProposalSpec = Omit<InsertAgentProposalInput, "tenantId" | "agentPrincipal"> & {
    approved?: boolean;
  };
  const rows: ProposalSpec[] = [
    {
      type: "vendor_risk",
      riskBand: "elevated",
      executionMode: "propose",
      title: "Elevated exposure: Datacenter Hosting Ltd invoice nears monthly ceiling",
      narrative:
        "INV-DATACENTER-002 ($187,000.00) is more than 3x Datacenter Hosting Ltd's " +
        "$60,000.00 monthly ceiling. Recommend a one-time ceiling exception review " +
        "before this AP invoice is funded.",
      amount: "187000.00",
      confidence: 0.88,
      evidence: [{ text: "INV-DATACENTER-002: $187,000.00 due in 4 days, PO-9912" }],
      links: { counterparty_id: datacenter.id },
    },
    {
      type: "collections",
      riskBand: "standard",
      executionMode: "propose",
      title: "Payment plan proposal: StartupX invoice 32 days overdue",
      narrative:
        "AR-STARTUPX-001 ($8,000.00) is 32 days overdue. StartupX has negotiated two " +
        "prior payment plans; propose a third structured plan rather than escalating " +
        "to collections given the declining usage trend.",
      amount: "8000.00",
      confidence: 0.82,
      evidence: [{ text: "AR-STARTUPX-001: $8,000.00 outstanding, 32 days overdue" }],
      links: { counterparty_id: startupx.id },
    },
    {
      type: "dispute",
      riskBand: "standard",
      executionMode: "propose",
      title: "Disputed duplicate line item: Midmarket Solutions invoice",
      narrative:
        "Midmarket Solutions flagged a $1,800.00 duplicate line item on AR-MIDMARKET-001 " +
        "($42,000.00 outstanding, 18 days overdue). Propose crediting the duplicate line " +
        "and re-issuing the remainder.",
      amount: "1800.00",
      confidence: 0.7,
      evidence: [{ text: "AR-MIDMARKET-001: $42,000.00 outstanding, 18 days overdue" }],
      links: { counterparty_id: midmarket.id },
    },
    {
      type: "cash_forecast",
      riskBand: "standard",
      executionMode: "propose",
      title: "30-day cash forecast: AR/AP mix dips toward the operating buffer",
      narrative:
        `Operating balance is $${OPERATING_BALANCE} against a $${OPERATING_BUFFER_MIN} ` +
        "buffer minimum. Pending AP (CloudOps + Datacenter, $206,400.00) outpaces the AR " +
        "expected to clear in the same window; recommend holding the Treasury sweep " +
        "until the AP batch settles.",
      confidence: 0.75,
      evidence: [
        {
          text: `Operating balance $${OPERATING_BALANCE}, buffer minimum $${OPERATING_BUFFER_MIN}`,
        },
      ],
      links: {},
    },
    {
      type: "compliance",
      riskBand: "high",
      executionMode: "notify_only",
      title: "Compliance flag: Quick Pay Solutions remains unverified",
      narrative:
        "Quick Pay Solutions is still unverified and unapproved. INV-QUICKPAY-003 also " +
        "carries urgency_language and new_wire_instructions flags. No payment has been " +
        "authorized; this is a standing compliance notice pending vendor verification.",
      confidence: 0.9,
      evidence: [{ text: "Quick Pay Solutions: verified_status=unverified, risk_level=high" }],
      links: { counterparty_id: quickpay.id },
    },
    {
      type: "revenue_intel",
      riskBand: "low",
      executionMode: "notify_only",
      title: "Expansion signal: BigCo Industries usage trending up",
      narrative:
        "BigCo Industries (38-month tenure, $48,000.00 MRR) shows a growing usage trend " +
        "with a low late-payment history. Flagging for the account team as an upsell " +
        "candidate.",
      amount: "48000.00",
      confidence: 0.8,
      evidence: [
        { text: "BigCo Industries: 38-month tenure, $48,000.00 MRR, usage_trend=growing" },
      ],
      links: { counterparty_id: bigco.id },
    },
    {
      type: "fraud_anomaly",
      riskBand: "high",
      executionMode: "notify_only",
      title: "Fraud signal: Quick Pay Solutions invoice flags urgency + new wire instructions",
      narrative:
        "INV-QUICKPAY-003 ($4,800.00) combines urgency_language, new_wire_instructions, " +
        "and no_po flags on an unapproved vendor: a classic business-email-compromise " +
        "pattern. No payment has been authorized.",
      amount: "4800.00",
      confidence: 0.93,
      evidence: [
        { text: "INV-QUICKPAY-003: urgency_language, new_wire_instructions, no_po flags" },
      ],
      links: { counterparty_id: quickpay.id },
    },
    {
      type: "payment_batch",
      riskBand: "low",
      executionMode: "propose",
      title: "Batch payment: CloudOps Inc invoice",
      narrative:
        "CloudOps Inc is approved and within its $25,000.00 monthly ceiling. " +
        "Datacenter Hosting Ltd's invoice is excluded from this batch pending the " +
        "ceiling exception review flagged separately. Proposing settlement for " +
        "INV-CLOUDOPS-001 ($19,400.00).",
      amount: "19400.00",
      confidence: 0.97,
      evidence: [{ text: "INV-CLOUDOPS-001: $19,400.00 due in 7 days, PO-2387" }],
      links: { counterparty_id: cloudops.id },
      reversible: true,
      approved: true,
    },
    {
      type: "treasury",
      riskBand: "low",
      executionMode: "propose",
      title: "Sweep $200,000.00 of idle operating cash into Reserve",
      narrative:
        `Operating balance $${OPERATING_BALANCE} sits well above the $${OPERATING_BUFFER_MIN} ` +
        "buffer minimum. Swept $200,000.00 of the surplus into the Reserve account.",
      amount: "200000.00",
      confidence: 0.9,
      evidence: [
        {
          text: `Operating balance $${OPERATING_BALANCE}, buffer minimum $${OPERATING_BUFFER_MIN}`,
        },
      ],
      links: {},
      reversible: true,
      approved: true,
    },
    {
      type: "reconciliation",
      riskBand: "low",
      executionMode: "propose",
      title: "Reconciled: BigCo Industries payment matches invoice AR-BIGCO-001",
      narrative:
        "BigCo Industries' latest $48,000.00 monthly inflow matches AR-BIGCO-001 within " +
        "tolerance. Marked reconciled.",
      amount: "48000.00",
      confidence: 0.96,
      evidence: [{ text: "BigCo Industries: $48,000.00 inflow matched to AR-BIGCO-001" }],
      links: { counterparty_id: bigco.id },
      reversible: false,
      approved: true,
    },
    {
      type: "subscription",
      riskBand: "low",
      executionMode: "propose",
      title: "Right-sized Stripe-Like Co subscription tier, saving $2,000.00/month",
      narrative:
        "Stripe-Like Co's usage has run well under its $8,000.00 monthly ceiling for " +
        "three consecutive cycles. Downgraded to the next tier down, saving $2,000.00/month.",
      amount: "2000.00",
      confidence: 0.83,
      evidence: [
        { text: "Stripe-Like Co: monthly ceiling $8,000.00, usage under tier for 3 cycles" },
      ],
      links: { counterparty_id: stripelike.id },
      reversible: false,
      approved: true,
    },
  ];

  await withTenantScope(pool, tenantId, async (c) => {
    for (const { approved, ...spec } of rows) {
      await insertAgentProposal(c, {
        ...spec,
        tenantId,
        agentPrincipal: agentId,
        ...(approved === true
          ? {
              status: "approved" as const,
              decision: "approved" as const,
              decidedBy: agentId,
              decidedAt: NOW,
              createdAt: NOW,
            }
          : {}),
      });
    }
  });
}
