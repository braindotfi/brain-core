#!/usr/bin/env node
import { readFileSync } from "node:fs";
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

const paymentIntentService = read("services/execution/src/payment-intents/PaymentIntentService.ts");
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
  "INSERT INTO tenants (id, kind, default_ap_account_id)",
);
const demoBootstrapIndex = demoSeed.indexOf("insertBootstrapAdminMember", demoTenantInsertIndex);
check(
  "demo provisioning creates member for user session principal",
  demoTenantInsertIndex >= 0 &&
    demoBootstrapIndex > demoTenantInsertIndex &&
    demoSeed.includes("VALUES ($1, 'demo', $2)") &&
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
    productionTenancy.includes("INSERT INTO tenants (id, kind, sandbox, created_via)") &&
    productionTenancy.includes("VALUES ($1, 'production', FALSE, 'admin')") &&
    productionTenancy.includes('request.headers["x-demo-provision-auth"]'),
  "POST /v1/tenants must create tenant.kind production and reject demo provision credentials",
);
check(
  "session exchange fails closed on unlinked platform identity",
  productionTenancy.includes('"/sessions"') &&
    productionTenancy.includes("findMemberByPlatformExternalRef") &&
    productionTenancy.includes('reason: "session_identity_unlinked"') &&
    productionTenancy.indexOf('reason: "session_identity_unlinked"') <
      productionTenancy.indexOf("insertRefreshToken(client, sessionSeed)", productionTenancy.indexOf('"/sessions"')),
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
    apiMainForServiceToken.includes("service-token is not a production session exchange path"),
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

const bad = checks.filter((c) => !c.ok);
if (bad.length > 0) {
  for (const c of bad) {
    console.error(`FAIL ${c.name}: ${c.detail}`);
  }
  process.exit(1);
}

for (const c of checks) console.log(`OK ${c.name}`);
