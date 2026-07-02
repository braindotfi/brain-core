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

const bad = checks.filter((c) => !c.ok);
if (bad.length > 0) {
  for (const c of bad) {
    console.error(`FAIL ${c.name}: ${c.detail}`);
  }
  process.exit(1);
}

for (const c of checks) console.log(`OK ${c.name}`);
