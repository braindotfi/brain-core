import type { ApiKeyRouteContract } from "@brain/shared";

/**
 * Commercial API-key routes and their stable usage dimensions.
 *
 * This registry is attached to Fastify route config by the auth plugin. It is
 * deliberately limited to scopes that tenant API keys can hold. A known key
 * that probes any other route is still metered as unclassified shadow traffic.
 */
export const API_KEY_ROUTE_CONTRACTS = [
  contract("GET", "/tenants/:tenantId/usage", "getTenantUsage", "audit:read", "audit"),

  contract("POST", "/raw/ingest", "ingestRaw", "raw:write", "raw"),
  contract("GET", "/raw/:raw_id", "getRaw", "raw:read", "raw"),
  contract("POST", "/raw/:raw_id/extract", "extractRawDocument", "raw:write", "raw"),
  contract("GET", "/raw/:raw_id/extraction", "getRawDocumentExtraction", "raw:read", "raw"),
  contract("GET", "/raw/:raw_id/parsed", "getRawParsed", "raw:read", "raw"),
  contract("POST", "/raw/:raw_id/parsed", "writeRawParsed", "raw:write", "raw"),
  contract("POST", "/sources", "connectSource", "raw:write", "raw"),
  contract("GET", "/sources", "listSources", "raw:read", "raw"),
  contract("GET", "/sources/:source_id", "getSource", "raw:read", "raw"),
  contract("DELETE", "/sources/:source_id", "disconnectSource", "raw:write", "raw"),
  contract("POST", "/sources/:source_id/sync", "syncSource", "raw:write", "raw"),
  contract("GET", "/sources/:source_id/sync/:job_id", "getSourceSyncJob", "raw:read", "raw"),

  contract("GET", "/ledger/accounts", "listAccounts", "ledger:read", "ledger"),
  contract("GET", "/ledger/accounts/:account_id", "getAccount", "ledger:read", "ledger"),
  contract("GET", "/ledger/balances", "listBalances", "ledger:read", "ledger"),
  contract("GET", "/ledger/transactions", "listTransactions", "ledger:read", "ledger"),
  contract(
    "GET",
    "/ledger/transactions/:transaction_id",
    "getTransaction",
    "ledger:read",
    "ledger",
  ),
  contract("GET", "/ledger/counterparties", "listCounterparties", "ledger:read", "ledger"),
  contract(
    "GET",
    "/ledger/counterparties/:counterparty_id",
    "getCounterparty",
    "ledger:read",
    "ledger",
  ),
  contract("GET", "/ledger/obligations", "listObligations", "ledger:read", "ledger"),
  contract(
    "GET",
    "/ledger/obligations/:obligation_id/resolved",
    "resolveObligation",
    "ledger:read",
    "ledger",
  ),
  contract(
    "GET",
    "/ledger/counterparties/:counterparty_id/resolved",
    "resolveCounterparty",
    "ledger:read",
    "ledger",
  ),
  contract(
    "GET",
    "/ledger/accounts/:account_id/resolved",
    "resolveAccount",
    "ledger:read",
    "ledger",
  ),
  contract("GET", "/ledger/invoices", "listInvoices", "ledger:read", "ledger"),
  contract("GET", "/ledger/invoices/:invoice_id", "getInvoice", "ledger:read", "ledger"),
  contract(
    "GET",
    "/ledger/reconciliation-matches",
    "listReconciliationMatches",
    "ledger:read",
    "ledger",
  ),
  contract("GET", "/ledger/cash_flows", "getCashFlows", "ledger:read", "ledger"),

  contract("GET", "/audit/events", "queryAuditEvents", "audit:read", "audit"),
  contract("GET", "/audit/event/:id", "getAuditEvent", "audit:read", "audit"),
  contract(
    "GET",
    "/audit/entity/:entityType/:entityId",
    "getAuditEntityHistory",
    "audit:read",
    "audit",
  ),
  contract("POST", "/audit/export", "exportAudit", "audit:read", "audit"),
  contract("GET", "/audit/anchor/latest", "getLatestAnchor", "audit:read", "audit"),
  contract("GET", "/audit/webhooks/endpoints", "listAuditWebhookEndpoints", "audit:read", "audit"),
  contract(
    "GET",
    "/webhooks/:endpoint_id/dead-letters",
    "listWebhookDeadLetters",
    "audit:read",
    "audit",
  ),
  contract("GET", "/proof/:action_id", "getProof", "audit:read", "audit"),
  contract("GET", "/proof/:action_id/view", "getProofView", "audit:read", "audit"),

  contract("GET", "/governance/agents", "listGovernanceAgents", "governance:read", "governance"),
  contract(
    "GET",
    "/governance/agents/:agent_id",
    "getGovernanceAgent",
    "governance:read",
    "governance",
  ),
  contract(
    "PATCH",
    "/governance/agents/:agent_id",
    "updateGovernanceAgentLifecycle",
    "governance:read",
    "governance",
  ),
  contract("GET", "/governance/reports", "getGovernanceReport", "governance:read", "governance"),
  contract(
    "POST",
    "/governance/reports/snapshot",
    "createGovernanceReportSnapshot",
    "governance:read",
    "governance",
  ),
  contract(
    "GET",
    "/governance/reports/:report_id",
    "getGovernanceReportSnapshot",
    "governance:read",
    "governance",
  ),
] as const satisfies readonly ApiKeyRouteContract[];

function contract(
  method: ApiKeyRouteContract["method"],
  route: string,
  operationId: string,
  requiredScope: ApiKeyRouteContract["requiredScope"],
  productFamily: ApiKeyRouteContract["productFamily"],
): ApiKeyRouteContract {
  return { method, route, operationId, requiredScope, productFamily, metered: true };
}
