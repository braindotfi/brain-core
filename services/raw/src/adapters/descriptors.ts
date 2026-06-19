/**
 * Connector descriptors (ingestion architecture §6).
 *
 * A descriptor is DATA, not code: it declares each independent dimension of a
 * connector explicitly (delivery, origin, format, authentication, capability
 * claims, object types, parser versions) instead of overloading one enum.
 * The CI guard (scripts/check-connector-descriptors.mjs) asserts that every
 * registered adapter is described here, that capability claims match the
 * methods the adapter actually implements, and that every declared parser
 * version is registered in the Ledger parser registry.
 *
 * The descriptor shape is provisional until three diverse connectors validate
 * it (architecture amendment 2) — extend it from what real connectors reveal,
 * not speculatively.
 */

import type { ArtifactSourceType } from "../sources/types.js";

export type SourceCategory =
  | "banking_cash"
  | "payments_revenue"
  | "accounting_erp"
  | "payroll_hr"
  | "documents_email"
  | "digital_assets"
  | "human_input"
  | "agent_internal"
  | "other";

export type DeliveryMethod = "webhook" | "poll" | "cursor" | "snapshot" | "file" | "stream";
export type ConnectorOrigin = "provider" | "aggregator" | "customer" | "agent" | "public";

/**
 * Who AUTHORED the connector code, which fixes the trust boundary it runs in
 * (distinct from `origin`, which describes the nature of the data SOURCE):
 *  - `first_party`: Brain-authored and audited. May run in-process as a
 *    registered SourceAdapter, hold provider credentials, and register a
 *    Ledger parser that mints `extracted` (high-trust) evidence.
 *  - `partner`: authored outside Brain's trust boundary. MUST NOT run
 *    in-process: no registered adapter, no Ledger parser. It reaches Raw only
 *    through the authenticated generic-ingest boundary (`/raw/ingest`) as an
 *    `api_partner` principal, so its artifacts resolve as low evidence trust
 *    (`customer_asserted`) and the §6 gate (check 9.5) refuses to settle on
 *    them uncorroborated. Runtime hosting of partner code in an isolated
 *    operated runtime is deferred to the R-03 deploy substrate; this tier
 *    declares and enforces the in-process exclusion that is buildable today.
 */
export type ConnectorTrustTier = "first_party" | "partner";
export type PayloadFormat = "structured" | "document" | "image" | "chain_event";
export type AuthenticationMethod = "oauth2" | "api_key" | "signature" | "service_account" | "none";

export interface ConnectorCapabilities {
  discovery: boolean;
  backfill: boolean;
  incremental: boolean;
  webhooks: boolean;
  refresh: boolean;
  updates: boolean;
  deletes: boolean;
}

export interface ConnectorDescriptor {
  /** Provider-named, matches the adapter's sourceType. */
  connectorType: ArtifactSourceType;
  version: string;
  /** Catalog grouping only — never used for dispatch. */
  category: SourceCategory;
  delivery: ReadonlyArray<DeliveryMethod>;
  origin: ConnectorOrigin;
  /** Code-authorship trust boundary; gates whether the connector may run in-process. */
  trustTier: ConnectorTrustTier;
  format: ReadonlyArray<PayloadFormat>;
  authentication: ReadonlyArray<AuthenticationMethod>;
  capabilities: ConnectorCapabilities;
  /** Provider object types this connector lands. */
  objectTypes: ReadonlyArray<string>;
  /** Ledger parser ids interpreting this connector's artifacts. Every entry must be registered. */
  parserVersions: ReadonlyArray<string>;
  expectedFreshness?: string;
}

const NO_CAPABILITIES: ConnectorCapabilities = {
  discovery: false,
  backfill: false,
  incremental: false,
  webhooks: false,
  refresh: false,
  updates: false,
  deletes: false,
};

export const CONNECTOR_DESCRIPTORS: ReadonlyArray<ConnectorDescriptor> = [
  {
    connectorType: "plaid",
    version: "1.0.0",
    category: "banking_cash",
    delivery: ["webhook", "cursor", "snapshot"],
    origin: "aggregator",
    trustTier: "first_party",
    format: ["structured"],
    authentication: ["oauth2"],
    capabilities: {
      ...NO_CAPABILITIES,
      backfill: true,
      incremental: true,
      webhooks: true,
      updates: true,
      deletes: true,
    },
    objectTypes: ["account", "transaction", "balance"],
    parserVersions: ["plaid_tx_v1"],
    expectedFreshness: "PT1H",
  },
  {
    connectorType: "stripe",
    version: "1.0.0",
    category: "payments_revenue",
    delivery: ["webhook", "cursor"],
    origin: "provider",
    trustTier: "first_party",
    format: ["structured"],
    authentication: ["api_key", "signature"],
    // Cursor pull is live (six per-object-type partitions); the webhook
    // handler stays a 501 stub until signature verification lands.
    capabilities: {
      ...NO_CAPABILITIES,
      backfill: true,
      incremental: true,
      updates: true,
    },
    objectTypes: [
      "charge",
      "payout",
      "refund",
      "fee",
      "dispute",
      "balance_transaction",
      "customer",
    ],
    parserVersions: ["stripe_v1"],
  },
  {
    connectorType: "netsuite",
    version: "0.1.0",
    category: "accounting_erp",
    delivery: ["webhook", "poll"],
    origin: "provider",
    trustTier: "first_party",
    format: ["structured"],
    authentication: ["oauth2"],
    capabilities: NO_CAPABILITIES, // stub; superseded by the accounting aggregator in Phase 3
    objectTypes: ["gl_account", "journal_entry", "invoice", "bill", "vendor", "customer"],
    parserVersions: [],
  },
  {
    connectorType: "email_inbound",
    version: "0.1.0",
    category: "documents_email",
    delivery: ["webhook"],
    origin: "customer",
    trustTier: "first_party",
    format: ["document"],
    authentication: ["signature"],
    capabilities: NO_CAPABILITIES, // stub until the verified inbound-email path lands
    objectTypes: ["document"],
    parserVersions: ["doc_obligation_v1"],
  },
  {
    connectorType: "csv_upload",
    version: "1.0.0",
    category: "documents_email",
    delivery: ["file"],
    origin: "customer",
    trustTier: "first_party",
    format: ["document"],
    authentication: ["none"], // RBAC-scoped bearer auth on the route itself
    capabilities: NO_CAPABILITIES,
    objectTypes: ["document"],
    parserVersions: ["doc_obligation_v1"],
  },
  {
    connectorType: "pdf_upload",
    version: "1.0.0",
    category: "documents_email",
    delivery: ["file"],
    origin: "customer",
    trustTier: "first_party",
    format: ["document"],
    authentication: ["none"], // RBAC-scoped bearer auth on the route itself
    capabilities: NO_CAPABILITIES,
    objectTypes: ["document"],
    parserVersions: ["doc_obligation_v1"],
  },
  {
    connectorType: "alchemy_wallet",
    version: "0.1.0",
    category: "digital_assets",
    delivery: ["webhook", "poll"],
    origin: "aggregator",
    trustTier: "first_party",
    format: ["chain_event"],
    authentication: ["api_key"],
    capabilities: NO_CAPABILITIES, // stub
    objectTypes: ["chain_event", "wallet_balance"],
    parserVersions: [],
  },
  {
    connectorType: "eth_address",
    version: "0.1.0",
    category: "digital_assets",
    delivery: ["poll"],
    origin: "public",
    trustTier: "first_party",
    format: ["chain_event"],
    authentication: ["none"],
    capabilities: NO_CAPABILITIES, // stub
    objectTypes: ["chain_event"],
    parserVersions: [],
  },
  {
    connectorType: "agent_contributed",
    version: "1.0.0",
    category: "agent_internal",
    delivery: ["stream"],
    origin: "agent",
    trustTier: "first_party",
    format: ["structured", "document"],
    authentication: ["none"], // MCP auth chain governs the route
    capabilities: NO_CAPABILITIES,
    objectTypes: ["contribution"],
    parserVersions: ["doc_obligation_v1"],
  },
  {
    connectorType: "other",
    version: "1.0.0",
    category: "other",
    delivery: ["file", "stream"],
    origin: "customer",
    trustTier: "first_party",
    format: ["structured", "document", "image"],
    authentication: ["none"], // RBAC-scoped bearer auth on the route itself
    capabilities: NO_CAPABILITIES,
    objectTypes: [],
    parserVersions: [],
  },
  {
    connectorType: "merge_accounting",
    version: "1.0.0",
    category: "accounting_erp",
    delivery: ["cursor", "poll"],
    origin: "aggregator",
    trustTier: "first_party",
    format: ["structured"],
    authentication: ["api_key"],
    capabilities: {
      ...NO_CAPABILITIES,
      backfill: true,
      incremental: true,
      updates: true,
    },
    objectTypes: ["gl_account", "journal_entry", "invoice", "contact", "payment", "tax_rate"],
    parserVersions: ["merge_accounting_v1"],
    expectedFreshness: "PT24H",
  },
  {
    connectorType: "finch",
    version: "1.0.0",
    category: "payroll_hr",
    delivery: ["poll", "snapshot"],
    origin: "aggregator",
    trustTier: "first_party",
    format: ["structured"],
    authentication: ["oauth2"],
    capabilities: {
      ...NO_CAPABILITIES,
      backfill: true,
      incremental: true,
      updates: true,
    },
    objectTypes: [
      "company",
      "individual",
      "employment",
      "pay_run",
      "pay_statement",
      "deduction",
      "contribution",
      "benefit",
    ],
    parserVersions: ["finch_payroll_v1"],
    expectedFreshness: "P1D",
  },
];
