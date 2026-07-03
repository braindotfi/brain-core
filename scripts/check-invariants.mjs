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
  approveStart >= 0 && approveEnd > approveStart && authorizeIndex >= 0 && signIndex > authorizeIndex,
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
const bootstrapMemberIndex = provisionTenant.indexOf("insertBootstrapAdminMember", provisionTxnStart);
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
const demoTenantInsertIndex = demoSeed.indexOf("INSERT INTO tenants (id, default_ap_account_id)");
const demoBootstrapIndex = demoSeed.indexOf("insertBootstrapAdminMember", demoTenantInsertIndex);
check(
  "demo provisioning creates member for user session principal",
  demoTenantInsertIndex >= 0 &&
    demoBootstrapIndex > demoTenantInsertIndex &&
    demoSeed.includes("memberId: actor") &&
    !demoSeed.includes("memberId: agentId"),
  "demo provision-run must create a bootstrap member for the user session, never the agent",
);

const apiMain = read("services/api/src/main.ts");
check(
  "demo provision-run returns split agent and member tokens",
  apiMain.includes("agent_token: agentToken") &&
    apiMain.includes("member_token: memberToken") &&
    apiMain.includes("type: \"agent\"") &&
    apiMain.includes("type: \"user\"") &&
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

const bad = checks.filter((c) => !c.ok);
if (bad.length > 0) {
  for (const c of bad) {
    console.error(`FAIL ${c.name}: ${c.detail}`);
  }
  process.exit(1);
}

for (const c of checks) console.log(`OK ${c.name}`);
