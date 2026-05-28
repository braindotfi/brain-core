import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findViolations, REQUIRED_LOADERS } from "../check-payment-intent-loaders.mjs";

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "pi-loaders-"));
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

const FULL_CTOR = `
const svc = new PaymentIntentService({
  pool,
  audit,
  outbox,
  approvals,
  resolveAgent,
  resolveAccount,
  resolveCounterparty,
  evaluatePolicy,
  resolvePrincipal,
  attestCounterpartyAgent,
  sumAgentWindowSpend,
});
`;

const MISSING_BOTH = `
const svc = new PaymentIntentService({
  pool, audit, outbox, approvals,
  resolveAgent, resolveAccount, resolveCounterparty,
  evaluatePolicy, resolvePrincipal,
});
`;

const MISSING_ONE = `
const svc = new PaymentIntentService({
  pool, audit, outbox, approvals,
  resolveAgent, resolveAccount, resolveCounterparty,
  evaluatePolicy, resolvePrincipal,
  attestCounterpartyAgent,
  // sumAgentWindowSpend intentionally absent
});
`;

test("passes when both required loaders are threaded", () => {
  const dir = fixture({ "boot.ts": FULL_CTOR });
  const { violations } = findViolations(dir);
  assert.deepEqual(violations, []);
  rmSync(dir, { recursive: true, force: true });
});

test("flags a site missing both M2M loaders", () => {
  const dir = fixture({ "boot.ts": MISSING_BOTH });
  const { violations } = findViolations(dir);
  assert.equal(violations.length, 1);
  assert.deepEqual([...violations[0].missing].sort(), [...REQUIRED_LOADERS].sort());
  rmSync(dir, { recursive: true, force: true });
});

test("flags a site missing only one loader", () => {
  const dir = fixture({ "boot.ts": MISSING_ONE });
  const { violations } = findViolations(dir);
  assert.equal(violations.length, 1);
  assert.deepEqual(violations[0].missing, ["sumAgentWindowSpend"]);
  rmSync(dir, { recursive: true, force: true });
});

test("ignores test files", () => {
  const dir = fixture({ "boot.test.ts": MISSING_BOTH });
  const { violations } = findViolations(dir);
  assert.deepEqual(violations, []);
  rmSync(dir, { recursive: true, force: true });
});

test("ignores __fixtures__ and __mocks__ files", () => {
  const dir = fixture({
    "__fixtures__/x.ts": MISSING_BOTH,
    "__mocks__/y.ts": MISSING_BOTH,
  });
  const { violations } = findViolations(dir);
  assert.deepEqual(violations, []);
  rmSync(dir, { recursive: true, force: true });
});

test("handles nested braces inside the constructor argument (balanced parens)", () => {
  // The conditional-spread pattern used in main.ts has nested object literals;
  // the script must capture the outer paren-balanced argument, not stop at the
  // first inner `}`.
  const src = `
const svc = new PaymentIntentService({
  pool, audit, outbox, approvals,
  resolveAgent, resolveAccount, resolveCounterparty,
  evaluatePolicy, resolvePrincipal,
  ...(escrow !== undefined ? { resolveEscrowState: makeEscrow({ url, chain: 8453 }) } : {}),
  attestCounterpartyAgent,
  sumAgentWindowSpend,
});
`;
  const dir = fixture({ "boot.ts": src });
  const { violations, sites } = findViolations(dir);
  assert.deepEqual(violations, []);
  assert.equal(sites.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("detects multiple construction sites in the same file", () => {
  // E.g. the all-in-one api + the legacy /payment-intents/* compat route, both
  // in services/api/src/main.ts. Each is checked independently.
  const src = `${FULL_CTOR}\n\n${MISSING_BOTH}`;
  const dir = fixture({ "boot.ts": src });
  const { violations, sites } = findViolations(dir);
  assert.equal(sites.length, 2);
  assert.equal(violations.length, 1);
  rmSync(dir, { recursive: true, force: true });
});
