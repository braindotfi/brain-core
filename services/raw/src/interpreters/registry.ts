/**
 * Artifact interpreter registry (ingestion architecture, Appendix B
 * mechanisms 2 and 4).
 *
 * An interpreter is the pure, versioned, replayable function
 * `interpret(bytes, artifact context) -> raw_parsed row content` keyed by the
 * artifact's declared `source_schema`. It has no I/O and no provider client:
 * because raw bytes are retained, history can be replayed through a new or
 * fixed interpreter without recontacting the source.
 *
 * The interpretation worker (workers/interpretWorker.ts) polls landed
 * artifacts whose schema is registered here and writes the produced
 * raw_parsed rows; the Ledger's parser registry then promotes those rows to
 * entities. Artifacts with an unregistered schema simply wait — landing them
 * never required a parser (intake is dumb and uniform).
 */

import { brainError } from "@brain/shared";

export interface InterpreterArtifactContext {
  rawArtifactId: string;
  tenantId: string;
  sourceType: string;
  sourceSchema: string;
  sourceRef: Record<string, unknown>;
  /** raw_sources connection that produced the artifact, when one exists. */
  sourceId: string | null;
  objectType: string | null;
}

export interface InterpretedOutput {
  /** Ledger parser id this row dispatches to (e.g. "stripe_v1"). */
  parser: string;
  parserVersion: string;
  extracted: Record<string, unknown>;
  confidence: number | null;
}

/**
 * Pure interpretation. Returns null when the artifact intentionally yields no
 * parsed row (e.g. an empty delta page) — the worker records it as
 * interpreted either way so it is not re-polled.
 */
export type ArtifactInterpreter = (
  bytes: Buffer,
  ctx: InterpreterArtifactContext,
) => InterpretedOutput | null;

const REGISTRY = new Map<string, ArtifactInterpreter>();

export function registerInterpreter(sourceSchema: string, interpreter: ArtifactInterpreter): void {
  if (REGISTRY.has(sourceSchema)) {
    throw new Error(`interpreter for source_schema '${sourceSchema}' is already registered`);
  }
  REGISTRY.set(sourceSchema, interpreter);
}

export function interpreterForSchema(sourceSchema: string): ArtifactInterpreter | undefined {
  return REGISTRY.get(sourceSchema);
}

/** Schemas the interpretation worker polls for. Stable order for SQL ANY($). */
export function registeredSchemas(): string[] {
  return [...REGISTRY.keys()].sort();
}

function parseJson(bytes: Buffer, schema: string): Record<string, unknown> {
  try {
    return JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw brainError("request_body_invalid", `artifact declared ${schema} but is not JSON`);
  }
}

// ---------------------------------------------------------------------------
// Built-in interpreters for structured provider pages. Each is a thin,
// deterministic reshape of the verbatim provider response into the payload
// shape the corresponding Ledger parser expects.
// ---------------------------------------------------------------------------

/**
 * Plaid transactions/sync page -> plaid_tx_v1 payload {accounts, transactions}.
 * `removed` entries are retained in the raw bytes but not promoted (the
 * plaid_tx_v1 extractor has no tombstone path yet; reconciliation handles
 * disputes/reversals downstream).
 */
registerInterpreter("plaid.transactions_sync.v1", (bytes, ctx) => {
  const page = parseJson(bytes, ctx.sourceSchema);
  const accounts = Array.isArray(page["accounts"]) ? page["accounts"] : [];
  const added = Array.isArray(page["added"]) ? page["added"] : [];
  const modified = Array.isArray(page["modified"]) ? page["modified"] : [];
  if (accounts.length === 0 && added.length === 0 && modified.length === 0) return null;
  return {
    parser: "plaid_tx_v1",
    parserVersion: "1.0.0",
    extracted: { accounts, transactions: [...added, ...modified] },
    confidence: null,
  };
});

/**
 * Stripe list pages -> stripe_v1 payload
 * {object_type, stripe_account_id, objects}. The Stripe account id is part of
 * the artifact context (captured by the pull adapter at sync time), not the
 * page bytes.
 */
const STRIPE_PAGE_SCHEMAS: ReadonlyArray<{ schema: string; objectType: string }> = [
  { schema: "stripe.balance_transactions.v1", objectType: "balance_transaction" },
  { schema: "stripe.charges.v1", objectType: "charge" },
  { schema: "stripe.payouts.v1", objectType: "payout" },
  { schema: "stripe.refunds.v1", objectType: "refund" },
  { schema: "stripe.disputes.v1", objectType: "dispute" },
  { schema: "stripe.customers.v1", objectType: "customer" },
];

for (const { schema, objectType } of STRIPE_PAGE_SCHEMAS) {
  registerInterpreter(schema, (bytes, ctx) => {
    const page = parseJson(bytes, ctx.sourceSchema);
    const objects = Array.isArray(page["data"]) ? page["data"] : [];
    if (objects.length === 0) return null;
    return {
      parser: "stripe_v1",
      parserVersion: "1.0.0",
      extracted: {
        object_type: objectType,
        stripe_account_id: ctx.sourceRef["stripe_account_id"] ?? null,
        objects,
      },
      confidence: null,
    };
  });
}

/**
 * Merge accounting list pages -> merge_accounting_v1 payload
 * {object_type, merge_integration, objects}. The underlying platform name
 * comes from the artifact context (captured by the pull adapter), keeping
 * the original source attached through interpretation.
 */
const MERGE_PAGE_SCHEMAS: ReadonlyArray<{ schema: string; objectType: string }> = [
  { schema: "merge_accounting.gl_accounts.v1", objectType: "gl_account" },
  { schema: "merge_accounting.journal_entries.v1", objectType: "journal_entry" },
  { schema: "merge_accounting.invoices.v1", objectType: "invoice" },
  { schema: "merge_accounting.contacts.v1", objectType: "contact" },
  { schema: "merge_accounting.payments.v1", objectType: "payment" },
  { schema: "merge_accounting.tax_rates.v1", objectType: "tax_rate" },
];

for (const { schema, objectType } of MERGE_PAGE_SCHEMAS) {
  registerInterpreter(schema, (bytes, ctx) => {
    const page = parseJson(bytes, ctx.sourceSchema);
    const objects = Array.isArray(page["results"]) ? page["results"] : [];
    if (objects.length === 0) return null;
    return {
      parser: "merge_accounting_v1",
      parserVersion: "1.0.0",
      extracted: {
        object_type: objectType,
        merge_integration: ctx.sourceRef["merge_integration"] ?? null,
        objects,
      },
      confidence: null,
    };
  });
}
