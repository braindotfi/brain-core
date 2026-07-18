import {
  findAccountById,
  findCounterpartyById,
  findInvoiceById,
  findObligationById,
  findTransactionById,
  type AccountRow,
  type CounterpartyRow,
  type InvoiceRow,
  type ObligationRow,
  type TransactionRow,
} from "@brain/ledger";
import {
  brainError,
  isBrainId,
  withTenantScope,
  type ServiceCallContext,
  type TenantScopedClient,
} from "@brain/shared";
import type { Pool } from "pg";

export const MAX_EVIDENCE_RESOLVE_REFS = 50;

export const RESOLVABLE_EVIDENCE_KINDS = [
  "account",
  "counterparty",
  "invoice",
  "obligation",
  "transaction",
  "wiki_entity",
] as const;

type ResolvableEvidenceKind = (typeof RESOLVABLE_EVIDENCE_KINDS)[number];

const RESOLVABLE_KIND_SET: ReadonlySet<string> = new Set(RESOLVABLE_EVIDENCE_KINDS);

export interface EvidenceResolveRef {
  kind: string;
  ref: string;
}

export interface EvidenceResolveResult {
  kind: string;
  ref: string;
  resolvable: boolean;
  not_found: boolean;
  summary: string | null;
  deep_link: string | null;
  reason?: "unsupported_kind" | "malformed_ref";
}

interface WikiEntitySummaryRow {
  id: string;
  kind: string;
  attributes: Record<string, unknown>;
}

export function isEvidenceKindResolvable(kind: string): boolean {
  return RESOLVABLE_KIND_SET.has(kind);
}

export function unsupportedEvidenceKinds(refs: readonly EvidenceResolveRef[]): string[] {
  return [
    ...new Set(refs.map((item) => item.kind).filter((kind) => !isEvidenceKindResolvable(kind))),
  ].sort();
}

export function parseEvidenceResolveBody(body: unknown): EvidenceResolveRef[] {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw brainError("request_body_invalid", "body must be an object");
  }
  const refs = (body as Record<string, unknown>)["refs"];
  if (!Array.isArray(refs)) {
    throw brainError("request_body_invalid", "refs must be an array");
  }
  if (refs.length > MAX_EVIDENCE_RESOLVE_REFS) {
    throw brainError(
      "request_body_invalid",
      `refs must contain at most ${MAX_EVIDENCE_RESOLVE_REFS} items`,
    );
  }
  return refs.map((item, index) => parseEvidenceRef(item, index));
}

export async function resolveEvidenceRefs(
  pool: Pool,
  ctx: ServiceCallContext,
  refs: readonly EvidenceResolveRef[],
): Promise<EvidenceResolveResult[]> {
  return withTenantScope(pool, ctx.tenantId, async (client) => {
    const out: EvidenceResolveResult[] = [];
    for (const item of refs) {
      out.push(await resolveOne(client, item));
    }
    return out;
  });
}

function parseEvidenceRef(value: unknown, index: number): EvidenceResolveRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw brainError("request_body_invalid", `refs[${index}] must be an object`);
  }
  const record = value as Record<string, unknown>;
  const kind = record["kind"];
  const ref = record["ref"];
  if (typeof kind !== "string" || kind.trim() === "") {
    throw brainError("request_body_invalid", `refs[${index}].kind must be a non-empty string`);
  }
  if (typeof ref !== "string" || ref.trim() === "") {
    throw brainError("request_body_invalid", `refs[${index}].ref must be a non-empty string`);
  }
  return { kind: kind.trim(), ref: ref.trim() };
}

async function resolveOne(
  client: TenantScopedClient,
  item: EvidenceResolveRef,
): Promise<EvidenceResolveResult> {
  if (!isEvidenceKindResolvable(item.kind)) {
    return {
      kind: item.kind,
      ref: item.ref,
      resolvable: false,
      not_found: false,
      summary: null,
      deep_link: null,
      reason: "unsupported_kind",
    };
  }
  if (!hasExpectedPrefix(item.kind as ResolvableEvidenceKind, item.ref)) {
    return {
      kind: item.kind,
      ref: item.ref,
      resolvable: false,
      not_found: false,
      summary: null,
      deep_link: null,
      reason: "malformed_ref",
    };
  }

  switch (item.kind as ResolvableEvidenceKind) {
    case "account": {
      const row = await findAccountById(client, item.ref);
      return row === null
        ? notFound(item)
        : found(item, accountSummary(row), `/ledger/accounts/${item.ref}`);
    }
    case "counterparty": {
      const row = await findCounterpartyById(client, item.ref);
      return row === null
        ? notFound(item)
        : found(item, counterpartySummary(row), `/ledger/counterparties/${item.ref}`);
    }
    case "invoice": {
      const row = await findInvoiceById(client, item.ref);
      return row === null
        ? notFound(item)
        : found(item, invoiceSummary(row), `/ledger/invoices/${item.ref}`);
    }
    case "obligation": {
      const row = await findObligationById(client, item.ref);
      return row === null
        ? notFound(item)
        : found(item, obligationSummary(row), `/ledger/obligations/${item.ref}/resolved`);
    }
    case "transaction": {
      const row = await findTransactionById(client, item.ref);
      return row === null
        ? notFound(item)
        : found(item, transactionSummary(row), `/ledger/transactions/${item.ref}`);
    }
    case "wiki_entity": {
      const row = await findWikiEntity(client, item.ref);
      return row === null
        ? notFound(item)
        : found(item, wikiSummary(row), `/wiki/entity/${item.ref}`);
    }
  }
}

function found(item: EvidenceResolveRef, summary: string, deepLink: string): EvidenceResolveResult {
  return {
    kind: item.kind,
    ref: item.ref,
    resolvable: true,
    not_found: false,
    summary,
    deep_link: deepLink,
  };
}

function notFound(item: EvidenceResolveRef): EvidenceResolveResult {
  return {
    kind: item.kind,
    ref: item.ref,
    resolvable: true,
    not_found: true,
    summary: null,
    deep_link: null,
  };
}

function hasExpectedPrefix(kind: ResolvableEvidenceKind, ref: string): boolean {
  switch (kind) {
    case "account":
      return isBrainId(ref, "acct");
    case "counterparty":
      return isBrainId(ref, "cp");
    case "invoice":
      return isBrainId(ref, "inv");
    case "obligation":
      return isBrainId(ref, "obl");
    case "transaction":
      return isBrainId(ref, "tx");
    case "wiki_entity":
      return isBrainId(ref, "ent");
  }
}

async function findWikiEntity(
  client: TenantScopedClient,
  id: string,
): Promise<WikiEntitySummaryRow | null> {
  const { rows } = await client.query<WikiEntitySummaryRow>(
    `SELECT id, kind, attributes
       FROM wiki_entities
      WHERE id = $1 AND valid_to IS NULL
      LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

function counterpartySummary(row: CounterpartyRow): string {
  return `${row.name} (${row.type})`;
}

function transactionSummary(row: TransactionRow): string {
  const description = row.description_normalized ?? row.description_raw;
  const base = `${row.direction} ${row.amount} ${row.currency}`;
  return description === null ? base : `${base}: ${description}`;
}

function obligationSummary(row: ObligationRow): string {
  return `${row.type} ${row.amount_due} ${row.currency} due ${formatDate(row.due_date)} (${row.status})`;
}

function accountSummary(row: AccountRow): string {
  return `${row.name} ${row.currency} ${row.account_type} (${row.status})`;
}

function invoiceSummary(row: InvoiceRow): string {
  return `Invoice ${row.invoice_number}: ${row.amount_due} ${row.currency} (${row.status})`;
}

function wikiSummary(row: WikiEntitySummaryRow): string {
  const label = firstAttributeString(row.attributes, ["name", "title", "display_name"]);
  return label === null ? `Wiki ${row.kind} entity` : `Wiki ${row.kind}: ${label}`;
}

function firstAttributeString(
  attributes: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = attributes[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}
