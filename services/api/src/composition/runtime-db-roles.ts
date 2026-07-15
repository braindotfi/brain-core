import type { Pool } from "pg";
import { assertDbRoles, type PoolRoleExpectation, type RoleQuery } from "./db-roles.js";
import type { PoolName, ProcessComposition } from "./process-roles.js";

export interface RuntimeDbRolePools {
  request: Pool;
  rawWorker: Pool;
  canonicalProjector: Pool;
  ledgerProjector: Pool;
  executionWorker: Pool;
  auditVerifier: Pool;
  auditPublisher: Pool;
  resolver: Pool;
  tenantDeletion: Pool;
  wiki: Pool;
}

export async function assertRuntimeDbRoles(input: {
  nodeEnv: string;
  composition: ProcessComposition;
  pools: RuntimeDbRolePools;
  log: (msg: string, ctx: Record<string, unknown>) => void;
}): Promise<void> {
  if (input.nodeEnv !== "production") return;

  const asQuery =
    (p: Pool): RoleQuery =>
    (s, params) =>
      p.query(s, params === undefined ? undefined : [...params]);

  const allRoleExpectations: PoolRoleExpectation[] = [
    {
      label: "request",
      query: asQuery(input.pools.request),
      mustBypassRls: false,
      expectedRole: "brain_app",
      // The audit log is append-only: no runtime role may mutate it. Catches a
      // deployment that did not apply the db-roles.sql REVOKE (Codex 307161b P1 #1).
      // The request role must also have NO access to the global, RLS-exempt
      // verifier forensic tables — a SELECT there would already be a cross-tenant
      // read of integrity findings (Codex 9389568 P1).
      forbidden: [
        { table: "audit_events", privilege: "UPDATE" },
        { table: "audit_events", privilege: "DELETE" },
        { table: "audit_verifier_checkpoint", privilege: "SELECT" },
        { table: "audit_integrity_findings", privilege: "SELECT" },
      ],
    },
    // §4 least-privilege pools. Each is BYPASSRLS (cross-tenant) but the
    // `forbidden` list proves it cannot reach another layer's tables — the
    // confused-deputy confinement that replaces the single broad role.
    {
      label: "raw-worker",
      query: asQuery(input.pools.rawWorker),
      mustBypassRls: true,
      expectedRole: "brain_raw_worker",
      forbidden: [
        { table: "canonical_journal_entry", privilege: "INSERT" },
        { table: "ledger_payment_intents", privilege: "INSERT" },
        { table: "audit_integrity_findings", privilege: "SELECT" },
      ],
    },
    {
      label: "canonical-projector",
      query: asQuery(input.pools.canonicalProjector),
      mustBypassRls: true,
      expectedRole: "brain_canonical_projector",
      forbidden: [
        { table: "raw_parsed", privilege: "INSERT" },
        { table: "ledger_payment_intents", privilege: "INSERT" },
        { table: "execution_outbox", privilege: "INSERT" },
        { table: "audit_integrity_findings", privilege: "SELECT" },
      ],
    },
    {
      label: "ledger-projector",
      query: asQuery(input.pools.ledgerProjector),
      mustBypassRls: true,
      expectedRole: "brain_ledger_projector",
      forbidden: [
        { table: "ledger_payment_intents", privilege: "INSERT" },
        { table: "canonical_journal_entry", privilege: "INSERT" },
        { table: "execution_outbox", privilege: "INSERT" },
        { table: "audit_integrity_findings", privilege: "SELECT" },
      ],
    },
    {
      label: "execution-worker",
      query: asQuery(input.pools.executionWorker),
      mustBypassRls: true,
      expectedRole: "brain_execution_worker",
      // Claim/mark the outbox only; the settle re-enters tenant scope on
      // brain_app, so this role must reach no money-path table directly.
      forbidden: [
        { table: "ledger_payment_intents", privilege: "INSERT" },
        { table: "ledger_transactions", privilege: "INSERT" },
        { table: "raw_parsed", privilege: "SELECT" },
        { table: "audit_integrity_findings", privilege: "SELECT" },
      ],
    },
    {
      label: "audit-verifier",
      query: asQuery(input.pools.auditVerifier),
      mustBypassRls: true,
      expectedRole: "brain_audit_verifier",
      // Keeps findings SELECT/INSERT + checkpoint SELECT/INSERT/UPDATE, but a
      // detected break must be un-erasable, and it touches nothing else.
      forbidden: [
        { table: "audit_events", privilege: "UPDATE" },
        { table: "audit_events", privilege: "DELETE" },
        { table: "audit_anchors", privilege: "INSERT" },
        { table: "audit_anchors", privilege: "DELETE" },
        { table: "audit_integrity_findings", privilege: "UPDATE" },
        { table: "audit_integrity_findings", privilege: "DELETE" },
        { table: "ledger_payment_intents", privilege: "INSERT" },
      ],
    },
    {
      label: "audit-publisher",
      query: asQuery(input.pools.auditPublisher),
      mustBypassRls: true,
      expectedRole: "brain_audit_publisher",
      // Read-only audit_events enumeration; no writes, no other tables.
      forbidden: [
        { table: "audit_events", privilege: "INSERT" },
        { table: "audit_integrity_findings", privilege: "SELECT" },
        { table: "ledger_payment_intents", privilege: "SELECT" },
      ],
    },
    {
      label: "resolver",
      query: asQuery(input.pools.resolver),
      mustBypassRls: true,
      expectedRole: "brain_resolver",
      // Cross-tenant SELECT only on the resolution tables; never writes.
      forbidden: [
        { table: "wallet_identities", privilege: "INSERT" },
        { table: "users", privilege: "UPDATE" },
        { table: "ledger_payment_intents", privilege: "SELECT" },
        { table: "audit_integrity_findings", privilege: "SELECT" },
      ],
    },
    {
      label: "tenant-deletion",
      query: asQuery(input.pools.tenantDeletion),
      mustBypassRls: true,
      expectedRole: "brain_tenant_deletion",
      // Broad DELETE for GDPR erasure, but audit history stays preserved and
      // forensic state is off-limits.
      forbidden: [
        { table: "audit_events", privilege: "DELETE" },
        { table: "audit_events", privilege: "UPDATE" },
        { table: "audit_integrity_findings", privilege: "SELECT" },
      ],
    },
    {
      label: "wiki",
      query: asQuery(input.pools.wiki),
      mustBypassRls: false,
      expectedRole: "brain_wiki_reader",
      // The wiki reader must never be able to write Ledger truth, nor read the
      // global verifier forensic tables.
      forbidden: [
        { table: "ledger_counterparties", privilege: "INSERT" },
        { table: "audit_verifier_checkpoint", privilege: "SELECT" },
        { table: "audit_integrity_findings", privilege: "SELECT" },
      ],
    },
  ];

  await assertDbRoles(
    allRoleExpectations.filter((e) => shouldAssertRuntimeRole(e.label, input.composition)),
    { enforce: true, log: input.log },
  );
}

const LABEL_TO_POOL: Partial<Record<string, PoolName>> = {
  "raw-worker": "raw_worker",
  "canonical-projector": "canonical_projector",
  "ledger-projector": "ledger_projector",
  "execution-worker": "execution_worker",
  "audit-verifier": "audit_verifier",
  "audit-publisher": "audit_publisher",
  resolver: "resolver",
  "tenant-deletion": "tenant_deletion",
};

function shouldAssertRuntimeRole(label: string, composition: ProcessComposition): boolean {
  if (label === "request") return true;
  if (label === "wiki") return composition.httpEnabled;
  const poolName = LABEL_TO_POOL[label];
  return poolName !== undefined && composition.pools.has(poolName);
}
