import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");

test("the probe and real payment-intent approve route share one scope guard", () => {
  const probe = read("services/execution/src/authz/probes.ts");
  const routes = read("services/execution/src/payment-intents/routes.ts");
  const approveRoute = routes.slice(
    routes.indexOf('"/payment-intents/:id/approve"'),
    routes.indexOf('"/payment-intents/:id/reject"'),
  );

  assert.match(probe, /requirePaymentIntentApproveScope\(request\.principal!\.scopes\)/);
  assert.match(approveRoute, /requirePaymentIntentApproveScope\(request\.principal!\.scopes\)/);
  assert.doesNotMatch(approveRoute, /requireScope\(/);
});

test("the canonical action approve route uses the same scope guard", () => {
  const routes = read("services/execution/src/actions/routes.ts");
  const approveRoute = routes.slice(
    routes.indexOf('"/actions/:id/approve"'),
    routes.indexOf('"/actions/:id/reject"'),
  );
  assert.match(approveRoute, /requirePaymentIntentApproveScope\(request\.principal!\.scopes\)/);
});

test("the probe has no domain dependency surface", () => {
  const probe = read("services/execution/src/authz/probes.ts");
  assert.match(probe, /registerAuthorizationProbeRoutes\(app: FastifyInstance\)/);
  assert.doesNotMatch(probe, /PaymentIntentService|Pool|AuditEmitter|Outbox|Rail|isBrainId/);
  assert.doesNotMatch(probe, /:id|request\.params/);
});

test("the production API mounts the probe inside v1", () => {
  const main = read("services/api/src/main.ts");
  const v1Block = main.slice(main.indexOf("async (v1) =>"));
  assert.match(v1Block, /registerAuthorizationProbeRoutes\(child\)/);
});
