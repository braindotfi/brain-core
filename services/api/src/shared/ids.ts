/**
 * Brain ID generators and parsers.
 *
 * Every Brain ID is a prefix + ULID: `tnt_01HQ7K3...`, `req_01HQ7K3...`, etc.
 * Prefixes keep IDs self-describing in logs and error messages.
 *
 * The JWT payload in §3.1 uses `tnt_`, `user_`, `agent_`, and `token_`.
 * The audit envelope in §6.1 requires a `request_id`. This file centralizes
 * the prefix registry so the rest of the codebase can't invent new shapes.
 */

import { ulid } from "ulid";

/** Prefix for each Brain ID kind. Never rename — these are wire-visible. */
export const ID_PREFIX = {
  tenant: "tnt",
  user: "user",
  agent: "agent",
  apiPartner: "partner",
  token: "token",
  request: "req",
  trace: "trace",
  audit: "evt",
  proposal: "prop",
  execution: "exec",
  policy: "pol",
  rawArtifact: "raw",
  rawParsed: "prs",
  wikiEntity: "ent",
  wikiRelation: "rel",
  wikiPage: "wpg",
  // Ledger entities (v0.3 / Layer 2). Prefixes are wire-visible — never rename.
  ledgerAccount: "acct",
  ledgerBalance: "bal",
  ledgerTransaction: "tx",
  ledgerCounterparty: "cp",
  ledgerObligation: "obl",
  ledgerDocument: "doc",
  ledgerCategory: "cat",
  ledgerTransfer: "xfer",
  ledgerInvoice: "inv",
  ledgerPaymentIntent: "pi",
  ledgerReconciliationMatch: "rcn",
  // Cross-layer
  policyDecision: "pd",
} as const;

export type BrainIdPrefix = (typeof ID_PREFIX)[keyof typeof ID_PREFIX];

/** ULID character set (Crockford's Base32). */
const ULID_ALPHABET_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Generate a prefixed ULID, e.g. `brainId("tnt")` → `tnt_01HQ7K3...`. */
export function brainId(prefix: BrainIdPrefix): string {
  return `${prefix}_${ulid()}`;
}

/** Narrowed accessors for the common kinds. */
export const newTenantId = (): string => brainId(ID_PREFIX.tenant);
export const newUserId = (): string => brainId(ID_PREFIX.user);
export const newAgentId = (): string => brainId(ID_PREFIX.agent);
export const newApiPartnerId = (): string => brainId(ID_PREFIX.apiPartner);
export const newTokenId = (): string => brainId(ID_PREFIX.token);
export const newRequestId = (): string => brainId(ID_PREFIX.request);
export const newAuditEventId = (): string => brainId(ID_PREFIX.audit);
export const newProposalId = (): string => brainId(ID_PREFIX.proposal);
export const newExecutionId = (): string => brainId(ID_PREFIX.execution);
export const newPolicyId = (): string => brainId(ID_PREFIX.policy);
export const newRawArtifactId = (): string => brainId(ID_PREFIX.rawArtifact);
export const newRawParsedId = (): string => brainId(ID_PREFIX.rawParsed);
export const newWikiEntityId = (): string => brainId(ID_PREFIX.wikiEntity);
export const newWikiRelationId = (): string => brainId(ID_PREFIX.wikiRelation);
export const newWikiPageId = (): string => brainId(ID_PREFIX.wikiPage);
export const newAccountId = (): string => brainId(ID_PREFIX.ledgerAccount);
export const newBalanceId = (): string => brainId(ID_PREFIX.ledgerBalance);
export const newTransactionId = (): string => brainId(ID_PREFIX.ledgerTransaction);
export const newCounterpartyId = (): string => brainId(ID_PREFIX.ledgerCounterparty);
export const newObligationId = (): string => brainId(ID_PREFIX.ledgerObligation);
export const newDocumentId = (): string => brainId(ID_PREFIX.ledgerDocument);
export const newCategoryId = (): string => brainId(ID_PREFIX.ledgerCategory);
export const newTransferId = (): string => brainId(ID_PREFIX.ledgerTransfer);
export const newInvoiceId = (): string => brainId(ID_PREFIX.ledgerInvoice);
export const newPaymentIntentId = (): string => brainId(ID_PREFIX.ledgerPaymentIntent);
export const newReconciliationMatchId = (): string => brainId(ID_PREFIX.ledgerReconciliationMatch);
export const newPolicyDecisionId = (): string => brainId(ID_PREFIX.policyDecision);

/**
 * Parse a Brain ID into its prefix and ULID. Returns null on malformed input.
 * Use when you need to assert an ID is of a given kind at a trust boundary
 * (e.g., path-param that must be a tenant id).
 */
export function parseBrainId(
  id: string,
): { prefix: string; ulid: string } | null {
  const idx = id.indexOf("_");
  if (idx <= 0 || idx === id.length - 1) return null;
  const prefix = id.slice(0, idx);
  const ulidPart = id.slice(idx + 1);
  if (!ULID_ALPHABET_RE.test(ulidPart)) return null;
  return { prefix, ulid: ulidPart };
}

/** True iff `id` is a well-formed Brain ID with the given prefix. */
export function isBrainId(id: string, prefix: BrainIdPrefix): boolean {
  const parsed = parseBrainId(id);
  return parsed !== null && parsed.prefix === prefix;
}
