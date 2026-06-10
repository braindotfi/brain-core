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
  // Sources (v0.3 / PLAN-FIRST #12). One row per adapter connection.
  source: "src",
  sourceSyncJob: "sjob",
  // Ingestion architecture §10 — per-(connection, resource, object_type)
  // sync checkpoint. One row per independently committed partition.
  sourceSyncPartition: "spart",
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
  approval: "appr",
  webhookEndpoint: "whe",
  // Agent Autonomy v3 — agent-run persistence (Layer 5).
  agentRun: "agnr",
  agentRoutingDecision: "agrd",
  agentReasoningTrace: "agrt",
  agentRunStep: "agrs",
  agentEvidenceRef: "agev",
  agentIdempotencyKey: "agik",
  // Agent Autonomy v3 — execution preconditions (Phase 1b).
  ledgerReservation: "rsv",
  policySpendCounter: "psc",
  // Agent Autonomy v3 — high-risk findings + overrides (Phase 2.6).
  agentFinding: "agfn",
  agentFindingOverride: "agfo",
  // Agent Autonomy v3 — agent-to-agent sagas (Phase 3.2).
  agentSaga: "agsg",
  agentSagaStep: "agss",
  // H-04 — durable execution outbox (Layer 5). One row per dispatched action.
  executionOutbox: "exo",
  // H-20 — outbound webhook dead-letter (Layer 6 audit / webhook infra).
  webhookDeadLetter: "wdl",
  // Wiki annotations (HITL corrections). Each annotation lands as a Raw
  // artifact for the provenance trail; the annotation id is its own handle.
  wikiAnnotation: "ann",
  // RFC 0003 — durable tenant blob purge job (GDPR Art. 17). One row per
  // tenant deletion; survives the deletion and is drained by a privileged worker.
  tenantBlobPurgeJob: "tbp",
  // RFC 0003 — transactional audit outbox for purge-lifecycle events. One row per
  // lifecycle transition; delivered to the audit service by the purge worker.
  tenantBlobPurgeAuditOutbox: "tbo",
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
export const newWikiAnnotationId = (): string => brainId(ID_PREFIX.wikiAnnotation);
export const newWikiEntityId = (): string => brainId(ID_PREFIX.wikiEntity);
export const newWikiRelationId = (): string => brainId(ID_PREFIX.wikiRelation);
export const newWikiPageId = (): string => brainId(ID_PREFIX.wikiPage);
export const newSourceId = (): string => brainId(ID_PREFIX.source);
export const newSourceSyncJobId = (): string => brainId(ID_PREFIX.sourceSyncJob);
export const newSourceSyncPartitionId = (): string => brainId(ID_PREFIX.sourceSyncPartition);
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
export const newApprovalId = (): string => brainId(ID_PREFIX.approval);
export const newWebhookEndpointId = (): string => brainId(ID_PREFIX.webhookEndpoint);
export const newExecutionOutboxId = (): string => brainId(ID_PREFIX.executionOutbox);
export const newWebhookDeadLetterId = (): string => brainId(ID_PREFIX.webhookDeadLetter);

/**
 * Parse a Brain ID into its prefix and ULID. Returns null on malformed input.
 * Use when you need to assert an ID is of a given kind at a trust boundary
 * (e.g., path-param that must be a tenant id).
 */
export function parseBrainId(id: string): { prefix: string; ulid: string } | null {
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
