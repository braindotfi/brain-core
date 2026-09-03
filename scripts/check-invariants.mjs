#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const checks = [];
const root = process.env.BRAIN_INVARIANT_ROOT ?? fileURLToPath(new URL("..", import.meta.url));

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function check(name, ok, detail) {
  checks.push({ name, ok, detail });
}

// RFC 0002 Phase C, increment 1: the tier-1 unattested read-only agent path
// (services/mcp/src/auth.ts) must not skip the existing agent-state, tenant,
// and scope-hash-presence checks -- it only replaces the on-chain
// BrainMCPAgentRegistry read, and only when all four of its own clauses hold.
const mcpAuthSource = read("services/mcp/src/auth.ts");
const verifyStart = mcpAuthSource.indexOf("public async verify(");
const verifyEnd = mcpAuthSource.indexOf("private async loadAgent(", verifyStart);
const verifyBody = mcpAuthSource.slice(verifyStart, verifyEnd);
const stateCheckIndex = verifyBody.indexOf('agent.state !== "active"');
const tenantCheckIndex = verifyBody.indexOf("auth_tenant_mismatch");
const scopeHashNullCheckIndex = verifyBody.indexOf("agent.scope_hash === null");
const tier1BranchIndex = verifyBody.indexOf('agent.attestation_mode === "none"');
check(
  "MCP tier-1 unattested branch follows the state/tenant/scope_hash checks",
  verifyStart >= 0 &&
    verifyEnd > verifyStart &&
    stateCheckIndex >= 0 &&
    tenantCheckIndex > stateCheckIndex &&
    scopeHashNullCheckIndex > tenantCheckIndex &&
    tier1BranchIndex > scopeHashNullCheckIndex,
  "McpAuthVerifier.verify's tier-1 branch must run AFTER the state !== active, " +
    "tenant-mismatch, and scope_hash === null checks -- an unattested agent must " +
    "still fail those first, unconditionally, before its four unattested-eligibility " +
    "clauses are even considered",
);

// assertScopeHashAcceptable is a fail-closed on-chain read for non-tier-1
// agents (services/mcp/src/auth.ts): a chain outage must throw
// OnchainScopeUnavailableError and propagate, never be caught and downgraded
// to the canonical-derivation fallback.
const assertScopeHashStart = mcpAuthSource.indexOf(
  "export async function assertScopeHashAcceptable",
);
const assertScopeHashBody = mcpAuthSource.slice(assertScopeHashStart);
check(
  "assertScopeHashAcceptable has no catch around the on-chain read",
  assertScopeHashStart >= 0 &&
    !assertScopeHashBody.includes("catch (") &&
    !assertScopeHashBody.includes("catch("),
  "assertScopeHashAcceptable must let OnchainScopeUnavailableError propagate " +
    "out of onchain.getOnchainScopeHash rather than catching it, or a chain " +
    "outage would silently fall through to the canonical-derivation check " +
    "instead of failing token minting/consent closed",
);

const paymentIntentService = read("services/execution/src/payment-intents/PaymentIntentService.ts");
const trustGateSource = read("shared/src/gate/gate.ts");
const approveStart = paymentIntentService.indexOf("public async approve(");
const approveEnd = paymentIntentService.indexOf("public async reject(", approveStart);
const approveBody = paymentIntentService.slice(approveStart, approveEnd);
const authorizeIndex = approveBody.indexOf("authorizeApproval(");
const signIndex = approveBody.indexOf("this.deps.approvals.sign(");
check(
  "PaymentIntent approve calls authorizeApproval before approvals.sign",
  approveStart >= 0 &&
    approveEnd > approveStart &&
    authorizeIndex >= 0 &&
    signIndex > authorizeIndex,
  "approve must authorize member authority before writing an approval signature",
);

const trustCheckStart = trustGateSource.indexOf("// 5.25 - counterparty trust.");
const policyEvaluationIndex = trustGateSource.indexOf(
  "const decision = await deps.evaluatePolicy(policyIntent, { dryRun });",
);
const trustCheckEnd = policyEvaluationIndex;
const trustCheckBlock = trustGateSource.slice(trustCheckStart, trustCheckEnd);
check(
  "enabled counterparty trust gate precedes policy and fails closed",
  trustCheckStart >= 0 &&
    policyEvaluationIndex > trustCheckStart &&
    trustCheckEnd > trustCheckStart &&
    trustGateSource.includes("const trustGateEnabled = deps.trustGateEnabled === true") &&
    trustCheckBlock.includes('return failGate(5.25, "counterparty_trust_allowed"') &&
    trustCheckBlock.includes('reason: "counterparty_trust_paused"') &&
    trustCheckBlock.includes('reason: "counterparty_trust_unknown"') &&
    trustCheckBlock.includes("if (!isCounterpartyTrustStatus(preloadedCounterparty.trust_status))"),
  "when BRAIN_TRUST_GATE_ENABLED is wired, trust denials must precede policy evaluation and fail closed",
);

const authorizationGate = read("services/execution/src/members/authorizeApproval.ts");
const gateStart = authorizationGate.indexOf("export function authorizeApproval");
const gateEnd = authorizationGate.indexOf("export function paymentIntentApprovalDomain", gateStart);
const gateBody = authorizationGate.slice(gateStart, gateEnd);
const selfApprovalIndex = gateBody.indexOf('reject("self_approval_blocked"');
const secondApprovalIndex = gateBody.indexOf('reject("second_approval_required"');
check(
  "actor-payee guard precedes second-approval reasoning",
  gateStart >= 0 &&
    gateEnd > gateStart &&
    selfApprovalIndex >= 0 &&
    secondApprovalIndex >= 0 &&
    selfApprovalIndex < secondApprovalIndex,
  "authorizeApproval must reject self-approval before second-approval quorum checks",
);

const authorizationTests = read("services/execution/src/members/authorizeApproval.test.ts");
const skippedSelfApprovalTests =
  /(?:it|test)\.(?:skip|todo)\([^)]*(?:self-payee|employee payees|plus-addressed|case-mismatched)/s.test(
    authorizationTests,
  );
check(
  "self-approval unit tests are active",
  authorizationTests.includes("rejects self-payee before second-approval reasoning") &&
    authorizationTests.includes("rejects employee payees with unresolved email") &&
    authorizationTests.includes("blocks plus-addressed self-payee aliases") &&
    authorizationTests.includes("blocks case-mismatched self-payee emails") &&
    !skippedSelfApprovalTests,
  "authorizeApproval self-approval and precedence tests must exist and must not be skipped or todo",
);

const actorResolver = read("services/execution/src/members/ActorResolver.ts");
const sessionStart = actorResolver.indexOf('case "session"');
const sessionEnd = actorResolver.indexOf('case "api"', sessionStart);
const sessionBody = actorResolver.slice(sessionStart, sessionEnd);
check(
  "session actor derivation ignores payload actor fields",
  sessionBody.includes("input.ctx.actor") && !sessionBody.includes("payloadActorId"),
  "session actors must be derived only from authenticated server context",
);

const provisionTenant = read("services/api/src/onboarding/provision.ts");
const provisionTxnStart = provisionTenant.indexOf("await withTenantScope(pool, tenantId");
const tenantInsertIndex = provisionTenant.indexOf("INSERT INTO tenants", provisionTxnStart);
const userInsertIndex = provisionTenant.indexOf("INSERT INTO users", provisionTxnStart);
const bootstrapMemberIndex = provisionTenant.indexOf(
  "insertBootstrapAdminMember",
  provisionTxnStart,
);
const verificationInsertIndex = provisionTenant.indexOf(
  "INSERT INTO email_verifications",
  provisionTxnStart,
);
check(
  "self-serve provisioning creates bootstrap member atomically",
  provisionTxnStart >= 0 &&
    tenantInsertIndex > provisionTxnStart &&
    userInsertIndex > tenantInsertIndex &&
    bootstrapMemberIndex > userInsertIndex &&
    verificationInsertIndex > bootstrapMemberIndex,
  "provisionTenant must create the initial admin member in the tenant creation transaction",
);

const demoSeed = read("services/api/src/demo/brainsaas-seed.ts");
const demoTenantInsertIndex = demoSeed.indexOf(
  "INSERT INTO tenants (id, kind, audit_anchor_mode, default_ap_account_id)",
);
const demoBootstrapIndex = demoSeed.indexOf("insertBootstrapAdminMember", demoTenantInsertIndex);
check(
  "demo provisioning creates member for user session principal",
  demoTenantInsertIndex >= 0 &&
    demoBootstrapIndex > demoTenantInsertIndex &&
    demoSeed.includes("VALUES ($1, 'demo', 'db_only', $2)") &&
    demoSeed.includes("memberId: actor") &&
    !demoSeed.includes("memberId: agentId"),
  "demo provision-run must create a bootstrap member for the user session, never the agent",
);

const apiMain = read("services/api/src/main.ts");
check(
  "demo provision-run returns split agent and member tokens",
  apiMain.includes("agent_token: agentToken") &&
    apiMain.includes("member_token: memberToken") &&
    apiMain.includes('type: "agent"') &&
    apiMain.includes('type: "user"') &&
    apiMain.includes("scopes: PAYMENT_AGENT_SCOPES"),
  "demo provision-run must return a propose-only agent token and separate user member token",
);
check(
  "deployed API mounts canonical action routes",
  apiMain.includes("registerActionRoutes") &&
    apiMain.includes("registerActionRoutes(child, piService)"),
  "services/api/src/main.ts must mount /v1/actions with the shared PaymentIntentService, not only the standalone execution server",
);

const anchorReconciler = read("services/audit/src/reconciler.ts");
check(
  "anchor reconciler uses the audit-verifier pool for cross-tenant scans",
  anchorReconciler.includes("privilegedPool: Pool") &&
    anchorReconciler.includes("deps.privilegedPool.query<OrphanRow>") &&
    apiMain.includes("privilegedPool: auditVerifierPool") &&
    apiMain.includes("startAnchorReconciler"),
  "audit-anchor orphan recovery must not run cross-tenant scans on the request pool under FORCE RLS",
);

const auditHealthRoute = read("services/api/src/audit-health/route.ts");
check(
  "audit health status treats stale verifier evidence as critical",
  auditHealthRoute.includes("AUDIT_VERIFIER_STALE_AFTER_SECONDS") &&
    auditHealthRoute.includes(
      "verifier.secondsSinceCleanFullPass > AUDIT_VERIFIER_STALE_AFTER_SECONDS",
    ),
  "/internal/audit/health must not report safe when the verifier heartbeat is stale",
);

const outboxWorker = read("services/execution/src/outbox/worker.ts");
const beforeDispatchIndex = outboxWorker.indexOf("deps.beforeDispatch");
const railDispatchIndex = outboxWorker.indexOf("rail.dispatch(");
check(
  "outbox worker rechecks dispatch safety before rail dispatch",
  beforeDispatchIndex >= 0 &&
    railDispatchIndex > beforeDispatchIndex &&
    apiMain.includes("const outboxBeforeDispatch") &&
    apiMain.includes("beforeDispatch: outboxBeforeDispatch") &&
    apiMain.includes("FOR SHARE") &&
    apiMain.includes('agent.state !== "active"'),
  "execution outbox must re-resolve creator agent state and refuse dispatch after a kill-switch quarantine",
);

const haltAgentIndex = apiMain.indexOf("haltAgent: async");
const haltBlockEnd = apiMain.indexOf("return { paused, quarantined };", haltAgentIndex);
const haltBlock = apiMain.slice(haltAgentIndex, haltBlockEnd);
check(
  "agent halt quarantines before pausing in one tenant transaction",
  haltAgentIndex >= 0 &&
    haltBlock.includes("await withTenantScope(") &&
    haltBlock.indexOf("transitionAgent(") >= 0 &&
    haltBlock.indexOf("LedgerPaymentIntents.pauseApprovedByAgent") >
      haltBlock.indexOf("transitionAgent("),
  "/v1/agents/{id}/halt must quarantine the agent before pausing approved intents, inside one tenant-scoped transaction",
);

const actorResolverSource = read("services/execution/src/members/ActorResolver.ts");
const agentPrincipalGuardIndex = actorResolverSource.indexOf('input.ctx.principalType !== "user"');
const sessionLookupIndex = actorResolverSource.indexOf(
  "findMemberById(input.ctx.tenantId, input.ctx.actor)",
);
check(
  "agent session principals never resolve to members",
  agentPrincipalGuardIndex >= 0 &&
    sessionLookupIndex > agentPrincipalGuardIndex &&
    actorResolverSource.includes("principal_type: input.ctx.principalType"),
  "ActorResolver must reject non-user session principals before member lookup",
);

const bootstrapMigration = read("services/execution/migrations/0024_bootstrap_missing_members.sql");
check(
  "gap-window migration backfills zero-member tenants",
  bootstrapMigration.includes("zero_member_tenants") &&
    bootstrapMigration.includes("NOT EXISTS") &&
    bootstrapMigration.includes("INSERT INTO members") &&
    bootstrapMigration.includes("ARRAY['ap', 'ar', 'treasury', 'payroll', 'reconciliation']"),
  "migration 0024 must backfill tenants with zero members using bootstrap admin defaults",
);

// M1: pin POST /v1/auth/service-token's minted scope set (single source of
// truth: onboarding/service-token.ts's SERVICE_TOKEN_SCOPES) to reads +
// propose, so it cannot silently regain payment_intent:approve (the finding
// fixed here) or gain execute / sign / write / policy:admin later.
const serviceTokenModule = read("services/api/src/onboarding/service-token.ts");
const serviceTokenScopesStart = serviceTokenModule.indexOf("SERVICE_TOKEN_SCOPES");
const serviceTokenScopesEnd = serviceTokenModule.indexOf("];", serviceTokenScopesStart);
const serviceTokenScopesBlock = serviceTokenModule.slice(
  serviceTokenScopesStart,
  serviceTokenScopesEnd,
);
const DANGEROUS_SERVICE_TOKEN_SCOPES = [
  "payment_intent:approve",
  "payment_intent:execute",
  "policy:write",
  "policy:admin",
  "policy:sign",
  "audit:admin",
  "audit:write",
  "raw:admin",
  "execution:write",
  "execution:admin",
];
check(
  "service-token mint scope set excludes approve/execute/sign/write/admin",
  serviceTokenScopesStart >= 0 &&
    serviceTokenScopesEnd > serviceTokenScopesStart &&
    serviceTokenScopesBlock.includes("payment_intent:propose") &&
    !DANGEROUS_SERVICE_TOKEN_SCOPES.some((scope) => serviceTokenScopesBlock.includes(`"${scope}"`)),
  "SERVICE_TOKEN_SCOPES must mint reads + propose only, never approve/execute/sign/write/admin scopes",
);

const apiMainForServiceToken = read("services/api/src/main.ts");
const serviceTokenRouteStart = apiMainForServiceToken.indexOf('"/auth/service-token"');
const serviceTokenSignStart = apiMainForServiceToken.indexOf(
  "siwxSigner.sign(",
  serviceTokenRouteStart,
);
check(
  "service-token route mints from the shared SERVICE_TOKEN_SCOPES constant",
  serviceTokenRouteStart >= 0 &&
    serviceTokenSignStart > serviceTokenRouteStart &&
    apiMainForServiceToken.indexOf("scopes: SERVICE_TOKEN_SCOPES", serviceTokenSignStart) >
      serviceTokenSignStart,
  "POST /v1/auth/service-token must mint scopes: SERVICE_TOKEN_SCOPES, not an inline literal that can drift",
);

// H2: pin that the mint route audits itself before returning 201, instead of
// being silently exempt from the audit trail every other mutating route uses.
const serviceTokenReplyIndex = apiMainForServiceToken.indexOf(
  "reply.status(201)",
  serviceTokenSignStart,
);
const serviceTokenAuditIndex = apiMainForServiceToken.indexOf(
  "auth.service_token.minted",
  serviceTokenSignStart,
);
check(
  "service-token mint emits an audit event before returning 201",
  serviceTokenReplyIndex > serviceTokenSignStart &&
    serviceTokenAuditIndex > serviceTokenSignStart &&
    serviceTokenAuditIndex < serviceTokenReplyIndex,
  "POST /v1/auth/service-token must call audit.emit with action auth.service_token.minted before the 201 reply",
);

const productionTenancy = read("services/api/src/production-tenancy/routes.ts");
const productionContract = read("docs/contracts/production-tenancy.md");
const productionAgentsContract = read("docs/contracts/production-agents.md");
const productionTenancyTests = read("services/api/src/production-tenancy/routes.test.ts");
const memberRoutesSource = read("services/execution/src/members/routes.ts");
check(
  "production tenancy contract is present",
  productionContract.includes("POST /v1/tenants") &&
    productionContract.includes("session_identity_unlinked") &&
    productionContract.includes("invite_invalid") &&
    productionContract.includes("Agent principals remain never member-resolvable"),
  "docs/contracts/production-tenancy.md must describe tenants, sessions, invites, and agent invariants",
);
check(
  "production tenant creation stamps production and rejects demo-fence auth",
  productionTenancy.includes('"/tenants"') &&
    /INSERT INTO tenants\s*\(\s*id,\s*kind,\s*sandbox,\s*created_via,\s*audit_anchor_mode,/u.test(
      productionTenancy,
    ) &&
    productionTenancy.includes("provisioning_state, data_profile, access_stage, business_name") &&
    productionTenancy.includes(
      "VALUES ($1, 'production', FALSE, 'admin', $2, $3, $4, $5, $6)",
    ) &&
    productionTenancy.includes('request.headers["x-demo-provision-auth"]'),
  "POST /v1/tenants must create tenant.kind production and reject demo provision credentials",
);
check(
  "audit publisher excludes db-only tenant roots before on-chain batching",
  apiMain.includes("t.audit_anchor_mode = 'onchain'") &&
    apiMain.includes("AUDIT_ANCHOR_TRIGGER_TENANT_ROOTS") &&
    apiMain.includes("AUDIT_ANCHOR_MAX_WAIT_MS"),
  "the on-chain scheduler must exclude db_only tenants and close cycles by root threshold or max wait",
);
const productionTenantRouteStart = productionTenancy.indexOf('"/tenants"');
const productionTenantAgentStart = productionTenancy.indexOf(
  "ensureBffServiceAgent",
  productionTenantRouteStart,
);
const productionTenantAgentTokenStart = productionTenancy.indexOf(
  "insertProductionAgentToken",
  productionTenantRouteStart,
);
const productionTenantReplyStart = productionTenancy.indexOf(
  "reply.status(201)",
  productionTenantRouteStart,
);
check(
  "production agents contract is present",
  productionAgentsContract.includes("Production Agent Principals") &&
    productionAgentsContract.includes("POST /v1/tenants/{tenant_id}/agent-token") &&
    productionAgentsContract.includes("SERVICE_TOKEN_SCOPES") &&
    productionAgentsContract.includes("actor_unresolved"),
  "docs/contracts/production-agents.md must describe production agent creation, token rotation, scopes, and actor rejection",
);
check(
  "production tenant creation atomically creates the BFF service agent and token",
  productionTenantRouteStart >= 0 &&
    productionTenantAgentStart > productionTenantRouteStart &&
    productionTenantAgentTokenStart > productionTenantAgentStart &&
    productionTenantAgentTokenStart < productionTenantReplyStart &&
    productionTenancy.includes("agent: serializeAgentToken"),
  "POST /v1/tenants must create the production BFF service agent and token before replying",
);
const productionAgentTokenRouteStart = productionTenancy.indexOf(
  '"/tenants/:tenantId/agent-token"',
);
const productionAgentTokenRouteEnd = productionTenancy.indexOf(
  '"/sessions"',
  productionAgentTokenRouteStart,
);
const productionAgentTokenRouteBody = productionTenancy.slice(
  productionAgentTokenRouteStart,
  productionAgentTokenRouteEnd,
);
check(
  "production agent-token route is production-only, idempotent, and rotation revokes prior token ids",
  productionAgentTokenRouteStart >= 0 &&
    productionAgentTokenRouteBody.includes('"tenant:agent-mint"') &&
    productionAgentTokenRouteBody.includes('tenant.kind !== "production"') &&
    productionAgentTokenRouteBody.includes("findActiveProductionAgentToken") &&
    productionAgentTokenRouteBody.includes("revokeProductionAgentTokens") &&
    productionAgentTokenRouteBody.includes("revocation.revoke"),
  "POST /v1/tenants/:tenantId/agent-token must require tenant:agent-mint, reject non-production tenants, return-or-mint, and revoke rotated token ids",
);
const signAgentTokenStart = productionTenancy.indexOf("async function signAgentToken");
const signAgentTokenEnd = productionTenancy.indexOf(
  "async function insertRefreshToken",
  signAgentTokenStart,
);
const signAgentTokenBody = productionTenancy.slice(signAgentTokenStart, signAgentTokenEnd);
check(
  "production agent tokens use SERVICE_TOKEN_SCOPES",
  signAgentTokenBody.includes('type: "agent"') &&
    signAgentTokenBody.includes("scopes: SERVICE_TOKEN_SCOPES") &&
    serviceTokenScopesBlock.includes('"payment_intent:propose"') &&
    !DANGEROUS_SERVICE_TOKEN_SCOPES.some((scope) => serviceTokenScopesBlock.includes(`"${scope}"`)),
  "production agent tokens must reuse SERVICE_TOKEN_SCOPES and exclude approve, execute, sign, write, and admin scopes",
);
check(
  "production agent principal tests pin member and approval actor rejection",
  productionTenancyTests.includes("production-minted agent tokens authenticate as agents") &&
    productionTenancyTests.includes("GET") &&
    productionTenancyTests.includes('url: "/members"') &&
    productionTenancyTests.includes("ActorResolver") &&
    productionTenancyTests.includes("actor_unresolved") &&
    productionTenancyTests.includes('principal_type: "agent"'),
  "production agent contract tests must prove production-minted agent tokens cannot resolve as members or approval actors",
);
check(
  "session exchange fails closed on unlinked platform identity",
  productionTenancy.includes('"/sessions"') &&
    productionTenancy.includes("findMemberByPlatformExternalRef") &&
    productionTenancy.includes('reason: "session_identity_unlinked"') &&
    productionTenancy.indexOf('reason: "session_identity_unlinked"') <
      productionTenancy.indexOf(
        "insertRefreshToken(client, sessionSeed)",
        productionTenancy.indexOf('"/sessions"'),
      ),
  "POST /v1/sessions must return session_identity_unlinked before creating any session state",
);
check(
  "invite tokens are hashed at rest and consume is row-locked",
  memberRoutesSource.includes("hashToken(inviteToken)") &&
    memberRoutesSource.includes("INSERT INTO member_invites") &&
    memberRoutesSource.includes("token_hash") &&
    productionTenancy.includes("FOR UPDATE OF i, m") &&
    !memberRoutesSource.includes("invite_token, token_hash"),
  "invite storage must write token_hash only and invite consume must lock the invite row",
);
check(
  "refresh-token reuse revokes the refresh family",
  productionTenancy.includes("refresh.rotated_at !== null") &&
    productionTenancy.includes("revokeRefreshFamily(client, refresh.family_id)") &&
    productionTenancy.includes("refresh token reuse detected"),
  "rotated refresh-token reuse must revoke the whole family",
);
check(
  "service-token rejects production tenants",
  apiMainForServiceToken.includes("production_tenant_uses_sessions") &&
    apiMainForServiceToken.includes("service-token is not a production session exchange path") &&
    productionTenancyTests.includes(
      "rejects production agent minting for non-production tenants",
    ) &&
    serviceTokenModule.includes("must stay disabled for live-money or multi-customer production"),
  "POST /v1/auth/service-token must not be a competing production user-session exchange path",
);

const ledgerRoutes = read("services/ledger/src/routes/index.ts");
const ledgerService = read("services/ledger/src/service/LedgerService.ts");
const webhookOutbound = read("shared/src/webhooks/outbound.ts");
const counterpartyCreateRouteIndex = ledgerRoutes.indexOf(
  "parseCounterpartyCreateBody(request.body)",
);
const counterpartyCreateMutateIndex = ledgerRoutes.indexOf("service.createManualCounterparty");
const counterpartyCreateParserStart = ledgerRoutes.indexOf("function parseCounterpartyCreateBody");
const counterpartyPatchParserStart = ledgerRoutes.indexOf("function parseCounterpartyPatchBody");
const counterpartyParserEnd = ledgerRoutes.indexOf(
  "function optionalIdentityFields",
  counterpartyPatchParserStart,
);
const counterpartyParserBody = ledgerRoutes.slice(
  counterpartyCreateParserStart,
  counterpartyParserEnd,
);
check(
  "manual counterparty routes reject payment and trust fields",
  ledgerRoutes.includes("payment_fields_not_allowed") &&
    ledgerRoutes.includes("field_not_editable") &&
    ledgerRoutes.includes("PAYMENT_FIELD_RE") &&
    ledgerRoutes.includes("TRUST_FIELDS") &&
    counterpartyCreateRouteIndex >= 0 &&
    counterpartyCreateMutateIndex > counterpartyCreateRouteIndex &&
    counterpartyCreateParserStart >= 0 &&
    counterpartyPatchParserStart > counterpartyCreateParserStart &&
    counterpartyParserEnd > counterpartyPatchParserStart &&
    counterpartyParserBody.includes("rejectPaymentFields(body)") &&
    counterpartyParserBody.includes("rejectTrustFields(body)"),
  "POST/PATCH /ledger/counterparties must reject payment instruction fields and trust state before service mutation",
);

const manualCreateStart = ledgerService.indexOf("public async createManualCounterparty");
const manualCreateEnd = ledgerService.indexOf(
  "public async updateCounterpartyIdentity",
  manualCreateStart,
);
const manualCreateBody = ledgerService.slice(manualCreateStart, manualCreateEnd);
check(
  "manual counterparty provenance is server-derived",
  manualCreateStart >= 0 &&
    manualCreateEnd > manualCreateStart &&
    manualCreateBody.includes(
      'ctx.principalType === "user" ? "human_confirmed" : "agent_contributed"',
    ) &&
    !manualCreateBody.includes("input.provenance") &&
    !manualCreateBody.includes("input.confidence") &&
    !manualCreateBody.includes("input.verified_status") &&
    !manualCreateBody.includes("input.risk_level"),
  "manual counterparty create must derive provenance and confidence from the principal, never request body fields",
);

const updateIdentityStart = ledgerService.indexOf("public async updateCounterpartyIdentity");
const updateIdentityEnd = ledgerService.indexOf(
  "public async normalizeFromRaw",
  updateIdentityStart,
);
const updateIdentityBody = ledgerService.slice(updateIdentityStart, updateIdentityEnd);
check(
  "counterparty rename preserves previous name as alias",
  updateIdentityStart >= 0 &&
    updateIdentityEnd > updateIdentityStart &&
    updateIdentityBody.includes("[before.name]") &&
    updateIdentityBody.includes("name_conflict") &&
    updateIdentityBody.includes('provenance: "human_confirmed"'),
  "counterparty identity updates must preserve the previous name as an alias, reject rename collisions, and stamp human provenance",
);

check(
  "counterparty updated webhooks are forwardable",
  webhookOutbound.includes('"ledger.counterparty.updated"'),
  "ledger.counterparty.updated must remain in the outbound webhook event allowlist",
);

const gateSource = read("shared/src/gate/gate.ts");
const hardFloorStart = gateSource.indexOf("export function requiresHardHumanApprovalFloor");
const hardFloorEnd = gateSource.indexOf(
  "// ---------------------------------------------------------------------------",
  hardFloorStart,
);
const hardFloorBody = gateSource.slice(hardFloorStart, hardFloorEnd);
check(
  "fiat rails have a default-on human approval floor with signed ACH and card caps",
  hardFloorBody.includes('intent.action_type === "wire"') &&
    hardFloorBody.includes("isFiatAutonomousAllowed") &&
    hardFloorBody.includes("fiatHumanApprovalFloorEnabled") &&
    gateSource.includes("ach_autonomous_max_amount") &&
    gateSource.includes("card_autonomous_max_amount"),
  "wire must require human approval by default, while ACH and card autonomy must require signed cap fields",
);

const approverRolesSource = read("shared/src/gate/approverRoles.ts");
const approvalServiceSource = read("services/execution/src/approvals/ApprovalService.ts");
check(
  "gate check 11 and ApprovalService share one role-quorum implementation",
  // The property: exactly one hasRequiredRoleQuorum implementation, in
  // @brain/shared, and both the §6 gate (check 11) and ApprovalService call
  // it rather than each keeping their own copy. Before this, gate.ts did a
  // naive literal-string match on required_approvers while ApprovalService
  // had the real generic-"signer"-slot quorum logic, so a policy requiring
  // "signer" (single_signer, or the VM's own confirm-tier default) could
  // never pass check 11 no matter who signed.
  approverRolesSource.includes("export function hasRequiredRoleQuorum") &&
    gateSource.includes('import { hasRequiredRoleQuorum } from "./approverRoles.js"') &&
    gateSource.includes("hasRequiredRoleQuorum(decision.required_approvers, signedSet)") &&
    approvalServiceSource.includes("hasRequiredRoleQuorum") &&
    approvalServiceSource.includes('} from "@brain/shared";') &&
    !approvalServiceSource.includes("function hasRequiredRoleQuorum("),
  "shared/src/gate/approverRoles.ts must define hasRequiredRoleQuorum once, imported by both gate.ts check 11 and ApprovalService, with no second copy in ApprovalService.ts",
);

const policyServiceSource = read("services/policy/src/service.ts");
check(
  "policy service exposes fiat autonomy caps only from the matched rule",
  policyServiceSource.includes(
    "ach_autonomous_max_amount: matchedRule?.ach_autonomous_max_amount ?? null",
  ) &&
    policyServiceSource.includes(
      "card_autonomous_max_amount: matchedRule?.card_autonomous_max_amount ?? null",
    ),
  "PolicyService.evaluateForGate must thread ACH and card caps from the matched signed policy rule",
);

const policyRoutesSource = read("services/policy/src/routes.ts");
const policyLinterSource = read("services/policy/src/linter.ts");
check(
  "policy linter's approver-role vocabulary is pinned to the canonical set",
  // The property: the linter's invalid_approval_role check must validate
  // against @brain/shared's APPROVER_ROLE_TOKENS (admin/approver/signer --
  // the only roles authorizeApproval can ever persist as approver_role, plus
  // the signer generic slot), not a locally-invented list. Before this,
  // DEFAULT_ROLES also contained "owner", "finance", and "controller", none
  // of which is a real MemberRole, so the linter blessed require clauses
  // (owner_approval, owner_and_cfo) the §6 gate could never satisfy.
  policyLinterSource.includes('import { APPROVER_ROLE_TOKENS } from "@brain/shared";') &&
    policyLinterSource.includes("DEFAULT_ROLES: ReadonlyArray<string> = APPROVER_ROLE_TOKENS") &&
    !policyLinterSource.includes('"owner"') &&
    !policyLinterSource.includes('"finance"') &&
    !policyLinterSource.includes('"controller"'),
  "services/policy/src/linter.ts's DEFAULT_ROLES must be APPROVER_ROLE_TOKENS from @brain/shared, not a separate fictional role list",
);
check(
  "policy activation lints the production confidence floor",
  policyLinterSource.includes("confidence_floor_missing") &&
    policyLinterSource.includes("confidence_floor_too_low") &&
    policyLinterSource.includes("floor.value > 0.5") &&
    policyRoutesSource.includes(
      'deps.confidenceFloorReject === true || tenantKind === "production"',
    ) &&
    policyRoutesSource.includes("policy failed activation lint"),
  "policy activation must warn or reject when agent.confidence.gte is missing or not strictly greater than 0.5",
);

// Activation must block on EVERY ERROR finding, not only the confidence floor,
// on EVERY writer of policies.state = 'active', not only sign. The blocking
// logic used to be inlined per route (checked by literal strings in
// routes.ts); it was later factored into one shared helper,
// runActivationLintGate (linter.ts), so POST /policy/:tenant_id/sign,
// POST /v1/demo/policy/activate, and the tools/seed-golden-path seed CLI all
// enforce identically instead of drifting apart -- which is exactly how the
// demo route shipped with NO lint gate at all in the first place (it grew a
// shallow shape check nobody wired to the H-18 findings). A guard that only
// pins routes.ts's OWN inline logic cannot see that kind of drift: it stays
// green even when a newer activation writer never calls the shared helper.
// So this checks two things, at two different layers: (1) the property
// itself, pinned once in the ONE place it lives (the blocking filter inside
// runActivationLintGate); and (2) that every known writer of
// policies.state='active' actually calls that helper, plus that the two
// tenant-aware HTTP paths force enforcement for a production tenant
// regardless of the rollback flag (the seed CLI has no tenant-kind lookup at
// all and simply enforces unconditionally, which is checked directly).
const demoPolicyActivateSource = read("services/api/src/demo/policy-activate-route.ts");
const seedGoldenPathCliSource = read("tools/seed-golden-path/src/cli.ts");
const activationLintGateBody = policyLinterSource.slice(
  policyLinterSource.indexOf("export function runActivationLintGate"),
);
check(
  "policy activation blocks on every lint ERROR",
  // The property: an ERROR finding blocks when lint enforcement is on, OR
  // (regardless of that flag) when it is a confidence-floor code.
  activationLintGateBody.includes(
    'f.severity === "ERROR" && (opts.lintEnforce || CONFIDENCE_FLOOR_CODES.has(f.code))',
  ) &&
    // Every known activation writer routes through the shared helper.
    policyRoutesSource.includes("runActivationLintGate(r.content") &&
    demoPolicyActivateSource.includes("runActivationLintGate(content") &&
    seedGoldenPathCliSource.includes("runActivationLintGate(content") &&
    // Production always enforces regardless of BRAIN_POLICY_LINT_REJECT, on
    // both paths that vary enforcement by tenant kind.
    policyRoutesSource.includes('deps.lintReject === true || tenantKind === "production"') &&
    demoPolicyActivateSource.includes('deps.lintReject === true || tenantKind === "production"') &&
    // The seed CLI has no tenant to look up; it must hardcode enforcement on.
    seedGoldenPathCliSource.includes("lintEnforce: true, confidenceEnforce: false"),
  "policy activation must block on all ERROR lint findings, not only confidence_floor_*, on every writer of policies.state='active' (sign, demo activate, seed CLI), and production must enforce regardless of the rollback flag",
);

// The read side of the signed-policy chain of trust. Activation verifies EIP-712
// signatures, but nothing re-signed a row whose content was written or mutated by
// another path, so getActive must recompute the canonical content hash and fail
// closed on drift rather than handing the section 6 gate an unverified document.
// It must THROW, never return null: null reads as "tenant has no policy" and
// callers turn that into policy_not_found, which misdiagnoses a tamper event.
const policyRepositorySource = read("services/policy/src/repository.ts");
check(
  "getActive verifies the active policy content hash",
  policyRepositorySource.includes("contentHashHex(row.content)") &&
    policyRepositorySource.includes("content_hash does not match content"),
  "getActive must recompute content_hash on read and fail closed when it does not match content",
);

const agentApiSource = read("services/agent-router/src/agent-api.ts");
const executionAgentHoldSource = read("services/execution/src/agents/quarantine.ts");
const openApiSource = read("Brain_API_Specification.yaml");
const sdkOpenApiSource = read("clients/sdk/src/generated/openapi.d.ts");
const agentContributionProtocolSource = read("protocol/agent-contributions.md");
check(
  "H-09 public surface uses contribution hold naming",
  agentApiSource.includes('"/agents/:agent_id/contribution-hold/release"') &&
    agentApiSource.includes("releaseContributionHold") &&
    agentApiSource.includes("contribution_hold_released") &&
    executionAgentHoldSource.includes("contribution_hold_cleared_at") &&
    openApiSource.includes("/agents/{agent_id}/contribution-hold/release") &&
    openApiSource.includes("operationId: releaseContributionHold") &&
    sdkOpenApiSource.includes('"/agents/{agent_id}/contribution-hold/release"') &&
    sdkOpenApiSource.includes("releaseContributionHold") &&
    agentContributionProtocolSource.includes("/v1/agents/{agent_id}/contribution-hold/release") &&
    !agentApiSource.includes("quarantine/release") &&
    !executionAgentHoldSource.includes("releaseAgentQuarantine"),
  "the contribution intake hold route and repository helpers must not use the old contribution quarantine naming",
);

try {
  execFileSync("node", [resolve(root, "scripts/check-rls-coverage.mjs")], {
    cwd: root,
    stdio: "pipe",
    encoding: "utf8",
  });
  check(
    "tenant-scoped tables have RLS coverage",
    true,
    "check-rls-coverage must pass for every service-owned tenant table",
  );
} catch (err) {
  check(
    "tenant-scoped tables have RLS coverage",
    false,
    err.stderr?.toString() || err.stdout?.toString() || "check-rls-coverage failed",
  );
}

const bad = checks.filter((c) => !c.ok);
if (bad.length > 0) {
  for (const c of bad) {
    console.error(`FAIL ${c.name}: ${c.detail}`);
  }
  process.exit(1);
}

for (const c of checks) console.log(`OK ${c.name}`);
