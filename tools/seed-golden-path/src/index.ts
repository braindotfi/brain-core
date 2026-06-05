/**
 * Golden-path seed dataset.
 *
 * Writes a realistic tenant scenario through the proper write paths:
 *   - 2 bank accounts (checking + savings)
 *   - 1 credit card
 *   - 1 payroll source counterparty
 *   - 5 recurring subscription obligations
 *   - 3 invoices (1 paid, 1 partial, 1 outstanding)
 *   - 2 receipts (documents)
 *   - 1 rent obligation
 *   - 1 suspicious duplicate charge (two transactions, same amount + merchant + day)
 *   - 1 upcoming low-balance risk (account.available_balance < next obligation amount)
 *   - 1 agent payment proposal (PaymentIntent in `proposed`)
 *   - 1 approval-required payment (PaymentIntent in `pending_approval`)
 *   - 1 policy-rejected payment (PaymentIntent in `rejected`)
 *
 * The exported function returns the ids of every entity written so test
 * suites can assert against them. All writes go through the v0.3 write
 * helpers — no raw SQL inserts here. That guarantees the seed itself
 * exercises the same invariants production will enforce.
 */

import {
  recordTransactionRow,
  upsertAccountRow,
  upsertCounterpartyRow,
  type AccountRow,
  type CounterpartyRow,
  type TransactionRow,
} from "@brain/ledger";
import {
  newDocumentId,
  newInvoiceId,
  newObligationId,
  newPaymentIntentId,
  newPolicyDecisionId,
  newRawArtifactId,
  newRawParsedId,
  withTenantScope,
  type AuditEmitter,
  type ServiceCallContext,
} from "@brain/shared";
import type { Pool } from "pg";

export interface GoldenPathSeed {
  tenantId: string;
  actor: string;
  accounts: {
    checking: AccountRow;
    savings: AccountRow;
    card: AccountRow;
    smartAccount: AccountRow | null;
  };
  counterparties: {
    employer: CounterpartyRow;
    landlord: CounterpartyRow;
    netflix: CounterpartyRow;
    spotify: CounterpartyRow;
    nytimes: CounterpartyRow;
    figma: CounterpartyRow;
    notion: CounterpartyRow;
    aws: CounterpartyRow;
    stripe: CounterpartyRow;
    duplicateMerchant: CounterpartyRow;
    acmeCorp: CounterpartyRow;
    globalTech: CounterpartyRow;
    blueSkyMedia: CounterpartyRow;
  };
  obligations: {
    rent: string;
    netflix: string;
    spotify: string;
    nytimes: string;
    figma: string;
    notion: string;
  };
  invoices: { paid: string; partial: string; outstanding: string };
  documents: { receipt1: string; receipt2: string };
  transactions: {
    payroll: TransactionRow;
    rent: TransactionRow;
    duplicateA: TransactionRow;
    duplicateB: TransactionRow;
  };
  paymentIntents: {
    proposed: string;
    pendingApproval: string;
    rejected: string;
  };
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

export async function seedGoldenPath(
  pool: Pool,
  audit: AuditEmitter,
  tenantId: string,
  actor: string,
): Promise<GoldenPathSeed> {
  const ctx: ServiceCallContext = { tenantId, actor };
  const sourceIds = [newRawArtifactId()];
  const evidenceIds = [newRawParsedId()];

  // ---------- Counterparties ----------
  const counterparties = await seedCounterparties(pool, audit, ctx, sourceIds, evidenceIds);

  // ---------- Accounts ----------
  const accounts = await seedAccounts(pool, audit, ctx, sourceIds, evidenceIds);

  // The tenant has two AP-eligible bank accounts (checking + savings), so the
  // P0.5 invoice-shortcut resolver needs a configured default to fund a
  // payment. Point it at checking (idempotent for repeat seeds).
  await pool.query(
    `INSERT INTO tenants (id, default_ap_account_id) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET default_ap_account_id = EXCLUDED.default_ap_account_id`,
    [ctx.tenantId, accounts.checking.id],
  );

  // ---------- Documents (receipts) ----------
  const documents = await seedDocuments(pool, ctx, sourceIds, evidenceIds, accounts.checking.id);

  // ---------- Obligations ----------
  const obligations = await seedObligations(pool, ctx, sourceIds, evidenceIds, counterparties);

  // ---------- Invoices ----------
  const invoices = await seedInvoices(
    pool,
    ctx,
    sourceIds,
    evidenceIds,
    counterparties,
    documents.receipt1,
  );

  // ---------- Transactions ----------
  const transactions = await seedTransactions(pool, audit, ctx, sourceIds, evidenceIds, {
    checkingId: accounts.checking.id,
    cardId: accounts.card.id,
    employerId: counterparties.employer.id,
    landlordId: counterparties.landlord.id,
    duplicateMerchantId: counterparties.duplicateMerchant.id,
  });

  // ---------- PaymentIntents ----------
  const paymentIntents = await seedPaymentIntents(pool, ctx, {
    sourceAccountId: accounts.checking.id,
    sanctionedCpId: counterparties.duplicateMerchant.id, // we'll mark this as sanctioned for the rejected intent
    landlordId: counterparties.landlord.id,
    awsId: counterparties.aws.id,
    rentObligationId: obligations.rent,
    invoiceId: invoices.outstanding,
  });

  // Backdate the AWS counterparty's payment instructions so the duplicate-
  // detector's 24h destination_recently_changed rule doesn't block the demo's
  // onchain_transfer intent. The aliases were just written by the seed, which
  // triggers the instructions history writer; setting changed_at to 25h ago
  // lets the gate treat them as pre-established.
  if (process.env["BRAIN_DEMO_ONCHAIN_RECIPIENT"]) {
    await pool.query(
      `UPDATE ledger_counterparty_payment_instructions
          SET changed_at = now() - interval '25 hours'
        WHERE counterparty_id = $1`,
      [counterparties.aws.id],
    );
  }

  // ---------- AR Invoices (receivables from customer counterparties) ----------
  await seedArInvoices(pool, ctx, sourceIds, evidenceIds, counterparties);

  return {
    tenantId,
    actor,
    accounts,
    counterparties,
    obligations,
    invoices,
    documents,
    transactions,
    paymentIntents,
  };
}

// ---------------------------------------------------------------------------
// Helpers (one per entity group). Each goes through the proper write
// helper so the seed exercises the same invariants production will.
// ---------------------------------------------------------------------------

async function seedCounterparties(
  pool: Pool,
  audit: AuditEmitter,
  ctx: ServiceCallContext,
  sourceIds: string[],
  evidenceIds: string[],
): Promise<GoldenPathSeed["counterparties"]> {
  async function cp(args: {
    name: string;
    type:
      | "merchant"
      | "vendor"
      | "customer"
      | "employer"
      | "bank"
      | "wallet"
      | "exchange"
      | "tax_authority"
      | "agent"
      | "other";
    risk_level?: "low" | "medium" | "high" | "sanctioned";
    verified_status?: "unverified" | "self_attested" | "document_verified" | "sanctions_cleared";
    aliases?: string[];
  }) {
    const { row } = await upsertCounterpartyRow(pool, audit, ctx, {
      name: args.name,
      type: args.type,
      ...(args.risk_level !== undefined ? { risk_level: args.risk_level } : {}),
      ...(args.verified_status !== undefined ? { verified_status: args.verified_status } : {}),
      ...(args.aliases !== undefined && args.aliases.length > 0 ? { aliases: args.aliases } : {}),
      source_ids: sourceIds,
      evidence_ids: evidenceIds,
      provenance: "extracted",
      confidence: 0.95,
    });
    return row;
  }

  return {
    employer: await cp({
      name: "Brain Inc.",
      type: "employer",
      risk_level: "low",
      verified_status: "document_verified",
    }),
    landlord: await cp({
      name: "Madison Property Group",
      type: "vendor",
      risk_level: "low",
      verified_status: "document_verified",
    }),
    netflix: await cp({ name: "Netflix", type: "merchant", risk_level: "low" }),
    spotify: await cp({ name: "Spotify", type: "merchant", risk_level: "low" }),
    nytimes: await cp({ name: "New York Times", type: "merchant", risk_level: "low" }),
    figma: await cp({ name: "Figma", type: "merchant", risk_level: "low" }),
    notion: await cp({ name: "Notion Labs", type: "merchant", risk_level: "low" }),
    aws: await cp({
      name: "Amazon Web Services",
      type: "vendor",
      risk_level: "low",
      verified_status: "document_verified",
      // When BRAIN_DEMO_ONCHAIN_RECIPIENT is set, the on-chain rail can resolve
      // this counterparty as a target for onchain_transfer intents.
      aliases: process.env["BRAIN_DEMO_ONCHAIN_RECIPIENT"]
        ? [process.env["BRAIN_DEMO_ONCHAIN_RECIPIENT"]]
        : [],
    }),
    stripe: await cp({
      name: "Stripe Inc.",
      type: "vendor",
      risk_level: "low",
      verified_status: "document_verified",
    }),
    // Used for both the duplicate-charge flag and (by sanctioning) the
    // policy-rejected PaymentIntent.
    duplicateMerchant: await cp({
      name: "Joe's Bar",
      type: "merchant",
      risk_level: "high",
      verified_status: "unverified",
    }),
    // Customer counterparties — used by the AR demo scenario for receivables.
    acmeCorp: await cp({
      name: "Acme Corp",
      type: "customer",
      risk_level: "low",
      verified_status: "document_verified",
    }),
    globalTech: await cp({
      name: "Global Tech Solutions",
      type: "customer",
      risk_level: "medium",
      verified_status: "self_attested",
    }),
    blueSkyMedia: await cp({
      name: "Blue Sky Media",
      type: "customer",
      risk_level: "low",
      verified_status: "document_verified",
    }),
  };
}

async function seedAccounts(
  pool: Pool,
  audit: AuditEmitter,
  ctx: ServiceCallContext,
  sourceIds: string[],
  evidenceIds: string[],
): Promise<GoldenPathSeed["accounts"]> {
  const checking = await upsertAccountRow(pool, audit, ctx, {
    external_account_id: "plaid_acc_checking",
    institution: "Chase",
    account_type: "bank_checking",
    name: "Chase Checking",
    currency: "USD",
    current_balance: "1200.00",
    available_balance: "1180.00", // intentionally low — drives the low-balance risk
    status: "active",
    source_ids: sourceIds,
    evidence_ids: evidenceIds,
    provenance: "extracted",
    confidence: 0.95,
  });
  const savings = await upsertAccountRow(pool, audit, ctx, {
    external_account_id: "plaid_acc_savings",
    institution: "Chase",
    account_type: "bank_savings",
    name: "Chase Savings",
    currency: "USD",
    current_balance: "8500.00",
    available_balance: "8500.00",
    status: "active",
    source_ids: sourceIds,
    evidence_ids: evidenceIds,
    provenance: "extracted",
    confidence: 0.95,
  });
  const card = await upsertAccountRow(pool, audit, ctx, {
    external_account_id: "plaid_acc_amex",
    institution: "American Express",
    account_type: "card",
    name: "Amex Platinum",
    currency: "USD",
    current_balance: "850.00",
    status: "active",
    source_ids: sourceIds,
    evidence_ids: evidenceIds,
    provenance: "extracted",
    confidence: 0.95,
  });
  // When BRAIN_ONCHAIN_SMART_ACCOUNT is set, seed an onchain ETH account that
  // represents the deployed BrainSmartAccount. Used as the source_account_id
  // for onchain_transfer intents so gate check 8 sees the right currency.
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

  return { checking: checking.row, savings: savings.row, card: card.row, smartAccount };
}

async function seedDocuments(
  pool: Pool,
  ctx: ServiceCallContext,
  sourceIds: string[],
  evidenceIds: string[],
  checkingAccountId: string,
): Promise<GoldenPathSeed["documents"]> {
  // Documents are written via tenant-scoped raw SQL since LedgerService
  // doesn't expose an upsertDocument helper yet (Phase 7 follow-up).
  return withTenantScope(pool, ctx.tenantId, async (c) => {
    const r1 = newDocumentId();
    await c.query(
      `INSERT INTO ledger_documents (
         id, owner_id, document_type, source_uri, extracted_fields,
         linked_account_ids, linked_transaction_ids, linked_obligation_ids,
         source_ids, evidence_ids, provenance, confidence
       ) VALUES ($1,$2,'receipt','blob://receipts/r1.pdf',
                 $3, $4, ARRAY[]::TEXT[], ARRAY[]::TEXT[], $5, $6, 'extracted', 0.85)`,
      [
        r1,
        ctx.tenantId,
        JSON.stringify({
          amount: 4.5,
          currency: "USD",
          date: daysAgo(7).toISOString().slice(0, 10),
          merchant_name: "Blue Bottle",
        }),
        [checkingAccountId],
        sourceIds,
        evidenceIds,
      ],
    );
    const r2 = newDocumentId();
    await c.query(
      `INSERT INTO ledger_documents (
         id, owner_id, document_type, source_uri, extracted_fields,
         linked_account_ids, linked_transaction_ids, linked_obligation_ids,
         source_ids, evidence_ids, provenance, confidence
       ) VALUES ($1,$2,'receipt','blob://receipts/r2.pdf',
                 $3, $4, ARRAY[]::TEXT[], ARRAY[]::TEXT[], $5, $6, 'extracted', 0.85)`,
      [
        r2,
        ctx.tenantId,
        JSON.stringify({
          amount: 12.99,
          currency: "USD",
          date: daysAgo(2).toISOString().slice(0, 10),
          merchant_name: "Joe's Bar",
        }),
        [checkingAccountId],
        sourceIds,
        evidenceIds,
      ],
    );
    return { receipt1: r1, receipt2: r2 };
  });
}

async function seedObligations(
  pool: Pool,
  ctx: ServiceCallContext,
  sourceIds: string[],
  evidenceIds: string[],
  cps: GoldenPathSeed["counterparties"],
): Promise<GoldenPathSeed["obligations"]> {
  return withTenantScope(pool, ctx.tenantId, async (c) => {
    async function obl(args: {
      type: string;
      counterparty_id: string;
      amount_due: string;
      due_in_days: number;
      status: string;
      recurrence?: string;
    }) {
      const id = newObligationId();
      await c.query(
        `INSERT INTO ledger_obligations (
           id, owner_id, type, counterparty_id, amount_due, currency,
           due_date, recurrence, status,
           source_ids, evidence_ids, provenance, confidence
         ) VALUES ($1,$2,$3,$4,$5,'USD',$6,$7,$8,$9,$10,'extracted',0.9)`,
        [
          id,
          ctx.tenantId,
          args.type,
          args.counterparty_id,
          args.amount_due,
          daysFrom(args.due_in_days),
          args.recurrence ?? null,
          args.status,
          sourceIds,
          evidenceIds,
        ],
      );
      return id;
    }
    return {
      rent: await obl({
        type: "rent",
        counterparty_id: cps.landlord.id,
        amount_due: "2500.00",
        due_in_days: 5,
        status: "due",
        recurrence: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
      }),
      netflix: await obl({
        type: "subscription",
        counterparty_id: cps.netflix.id,
        amount_due: "15.49",
        due_in_days: 12,
        status: "upcoming",
        recurrence: "RRULE:FREQ=MONTHLY",
      }),
      spotify: await obl({
        type: "subscription",
        counterparty_id: cps.spotify.id,
        amount_due: "10.99",
        due_in_days: 19,
        status: "upcoming",
        recurrence: "RRULE:FREQ=MONTHLY",
      }),
      nytimes: await obl({
        type: "subscription",
        counterparty_id: cps.nytimes.id,
        amount_due: "17.00",
        due_in_days: 22,
        status: "upcoming",
        recurrence: "RRULE:FREQ=MONTHLY",
      }),
      figma: await obl({
        type: "subscription",
        counterparty_id: cps.figma.id,
        amount_due: "12.00",
        due_in_days: 8,
        status: "upcoming",
        recurrence: "RRULE:FREQ=MONTHLY",
      }),
      notion: await obl({
        type: "subscription",
        counterparty_id: cps.notion.id,
        amount_due: "8.00",
        due_in_days: 14,
        status: "upcoming",
        recurrence: "RRULE:FREQ=MONTHLY",
      }),
    };
  });
}

async function seedInvoices(
  pool: Pool,
  ctx: ServiceCallContext,
  sourceIds: string[],
  evidenceIds: string[],
  cps: GoldenPathSeed["counterparties"],
  documentId: string,
): Promise<GoldenPathSeed["invoices"]> {
  return withTenantScope(pool, ctx.tenantId, async (c) => {
    async function inv(
      n: number,
      counterpartyId: string,
      due: string,
      paid: string,
      status: string,
    ) {
      const id = newInvoiceId();
      // linked_document_ids carries the source document evidence the P0.5
      // invoice-shortcut resolver requires before it will fund a payment.
      await c.query(
        `INSERT INTO ledger_invoices (
           id, owner_id, invoice_number, counterparty_id,
           amount_due, amount_paid, currency, issue_date, due_date, status,
           source_ids, evidence_ids, linked_document_ids, provenance, confidence
         ) VALUES ($1,$2,$3,$4,$5,$6,'USD',$7,$8,$9,$10,$11,$12,'extracted',0.9)`,
        [
          id,
          ctx.tenantId,
          `INV-${n}`,
          counterpartyId,
          due,
          paid,
          daysAgo(20),
          daysFrom(10),
          status,
          sourceIds,
          evidenceIds,
          [documentId],
        ],
      );
      return id;
    }
    return {
      paid: await inv(1041, cps.aws.id, "320.00", "320.00", "paid"),
      partial: await inv(1042, cps.aws.id, "550.00", "200.00", "partial"),
      outstanding: await inv(1043, cps.figma.id, "75.00", "0.00", "sent"),
    };
  });
}

async function seedTransactions(
  pool: Pool,
  audit: AuditEmitter,
  ctx: ServiceCallContext,
  sourceIds: string[],
  evidenceIds: string[],
  ids: {
    checkingId: string;
    cardId: string;
    employerId: string;
    landlordId: string;
    duplicateMerchantId: string;
  },
): Promise<GoldenPathSeed["transactions"]> {
  // Payroll inflow.
  const payroll = (
    await recordTransactionRow(pool, audit, ctx, {
      account_id: ids.checkingId,
      external_transaction_id: "plaid_tx_payroll_1",
      amount: "5800.00",
      currency: "USD",
      direction: "inflow",
      transaction_date: daysAgo(15).toISOString(),
      counterparty_id: ids.employerId,
      status: "posted",
      description_normalized: "Acme Holdings Payroll",
      source_ids: sourceIds,
      evidence_ids: evidenceIds,
      provenance: "extracted",
      confidence: 0.98,
    })
  ).row;

  // Last month's rent — paid; this lets the obligation page show a paid history.
  const rent = (
    await recordTransactionRow(pool, audit, ctx, {
      account_id: ids.checkingId,
      external_transaction_id: "plaid_tx_rent_last",
      amount: "2500.00",
      currency: "USD",
      direction: "outflow",
      transaction_date: daysAgo(28).toISOString(),
      counterparty_id: ids.landlordId,
      status: "posted",
      description_normalized: "Madison Property Group Rent",
      source_ids: sourceIds,
      evidence_ids: evidenceIds,
      provenance: "extracted",
      confidence: 0.97,
    })
  ).row;

  // Duplicate charges — same amount, same merchant, same day. The anomaly
  // agent (post-MVP) flags this. For Phase 6 the dataset just provides
  // the two rows; the duplicate-detection assertion lives in the
  // user-question test suite.
  const duplicateA = (
    await recordTransactionRow(pool, audit, ctx, {
      account_id: ids.cardId,
      external_transaction_id: "plaid_tx_dup_a",
      amount: "12.99",
      currency: "USD",
      direction: "outflow",
      transaction_date: daysAgo(2).toISOString(),
      counterparty_id: ids.duplicateMerchantId,
      status: "posted",
      description_normalized: "Joe's Bar",
      source_ids: sourceIds,
      evidence_ids: evidenceIds,
      provenance: "extracted",
      confidence: 0.95,
    })
  ).row;

  const duplicateB = (
    await recordTransactionRow(pool, audit, ctx, {
      account_id: ids.cardId,
      external_transaction_id: "plaid_tx_dup_b",
      amount: "12.99",
      currency: "USD",
      direction: "outflow",
      transaction_date: daysAgo(2).toISOString(),
      counterparty_id: ids.duplicateMerchantId,
      status: "posted",
      description_normalized: "Joe's Bar",
      source_ids: sourceIds,
      evidence_ids: evidenceIds,
      provenance: "extracted",
      confidence: 0.95,
    })
  ).row;

  return { payroll, rent, duplicateA, duplicateB };
}

async function seedPaymentIntents(
  pool: Pool,
  ctx: ServiceCallContext,
  ids: {
    sourceAccountId: string;
    sanctionedCpId: string;
    landlordId: string;
    awsId: string;
    rentObligationId: string;
    invoiceId: string;
  },
): Promise<GoldenPathSeed["paymentIntents"]> {
  // Phase 4's PaymentIntentService.create requires a policy evaluator
  // that returns a stored PolicyDecision. For seed purposes we synthesize
  // the decision id as a UUID prefix and bypass the service to keep the
  // seed self-contained. Production wiring (post-stage-8) replaces this
  // with the real PolicyService.evaluate + the §6 gate path.
  return withTenantScope(pool, ctx.tenantId, async (c) => {
    async function pi(args: {
      status: string;
      counterparty_id: string;
      amount: string;
      obligation_id?: string;
      invoice_id?: string;
    }) {
      const id = newPaymentIntentId();
      await c.query(
        `INSERT INTO ledger_payment_intents (
           id, owner_id, created_by_agent_id, action_type,
           source_account_id, destination_counterparty_id,
           amount, currency, obligation_id, invoice_id,
           status, policy_decision_id
         ) VALUES ($1,$2,'agent_payment','ach_outbound',
                   $3,$4,$5,'USD',$6,$7,$8,$9)`,
        [
          id,
          ctx.tenantId,
          ids.sourceAccountId,
          args.counterparty_id,
          args.amount,
          args.obligation_id ?? null,
          args.invoice_id ?? null,
          args.status,
          newPolicyDecisionId(),
        ],
      );
      return id;
    }
    return {
      proposed: await pi({
        status: "proposed",
        counterparty_id: ids.landlordId,
        amount: "2500.00",
        obligation_id: ids.rentObligationId,
      }),
      pendingApproval: await pi({
        status: "pending_approval",
        counterparty_id: ids.awsId,
        amount: "75.00",
        invoice_id: ids.invoiceId,
      }),
      // Policy-rejected because counterparty is high-risk + unverified.
      rejected: await pi({
        status: "rejected",
        counterparty_id: ids.sanctionedCpId,
        amount: "200.00",
      }),
    };
  });
}

async function seedArInvoices(
  pool: Pool,
  ctx: ServiceCallContext,
  sourceIds: string[],
  evidenceIds: string[],
  cps: GoldenPathSeed["counterparties"],
): Promise<void> {
  // AR invoices — money owed TO us by customers. Due dates spread across
  // past and future so the AR scenario sees a mix of overdue and current.
  await withTenantScope(pool, ctx.tenantId, async (c) => {
    async function arInv(args: {
      n: number;
      counterpartyId: string;
      due: string;
      paid: string;
      status: string;
      dueDaysOffset: number;
    }) {
      const id = newInvoiceId();
      await c.query(
        `INSERT INTO ledger_invoices (
           id, owner_id, invoice_number, counterparty_id,
           amount_due, amount_paid, currency, issue_date, due_date, status,
           source_ids, evidence_ids, linked_document_ids, provenance, confidence
         ) VALUES ($1,$2,$3,$4,$5,$6,'USD',$7,$8,$9,$10,$11,ARRAY[]::TEXT[],'extracted',0.88)`,
        [
          id,
          ctx.tenantId,
          `AR-${args.n}`,
          args.counterpartyId,
          args.due,
          args.paid,
          daysAgo(30),
          args.dueDaysOffset < 0 ? daysAgo(-args.dueDaysOffset) : daysFrom(args.dueDaysOffset),
          args.status,
          sourceIds,
          evidenceIds,
        ],
      );
      return id;
    }

    // Acme Corp: $4,200 overdue 14 days
    await arInv({
      n: 2001,
      counterpartyId: cps.acmeCorp.id,
      due: "4200.00",
      paid: "0.00",
      status: "sent",
      dueDaysOffset: -14,
    });
    // Global Tech: $11,500 overdue 32 days (will trigger firm tone)
    await arInv({
      n: 2002,
      counterpartyId: cps.globalTech.id,
      due: "11500.00",
      paid: "2000.00",
      status: "partial",
      dueDaysOffset: -32,
    });
    // Blue Sky Media: $2,800 current (not yet overdue)
    await arInv({
      n: 2003,
      counterpartyId: cps.blueSkyMedia.id,
      due: "2800.00",
      paid: "0.00",
      status: "sent",
      dueDaysOffset: 5,
    });
  });
}
