import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const SCRIPT = join(process.cwd(), "scripts/production-readiness.mjs");
const ADDR = "0x" + "ab".repeat(20);

function runWithEnv(env, args = ["--json"]) {
  try {
    const stdout = execFileSync("node", [SCRIPT, ...args], {
      env: { ...process.env, ...env },
      encoding: "utf8",
    });
    return { code: 0, stdout, parsed: JSON.parse(stdout) };
  } catch (err) {
    const stdout = err.stdout?.toString() ?? "";
    return {
      code: err.status ?? 1,
      stdout,
      parsed: stdout.startsWith("{") ? JSON.parse(stdout) : null,
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

test("--json mode emits parseable JSON with the expected top-level shape", () => {
  const r = runWithEnv({ NODE_ENV: "development" });
  assert.equal(r.code, 0);
  assert.equal(typeof r.parsed.node_env, "string");
  assert.ok(["green", "yellow", "red"].includes(r.parsed.overall_status));
  assert.ok(Array.isArray(r.parsed.sections.rails));
  assert.ok(Array.isArray(r.parsed.sections.fences));
  assert.ok(Array.isArray(r.parsed.sections.ci_guards));
  assert.ok(Array.isArray(r.parsed.sections.deferred));
});

test("dev with no env: rails yellow, no reds, exit 0", () => {
  const r = runWithEnv({ NODE_ENV: "development" });
  assert.equal(r.code, 0);
  // No red rows under a dev evaluation — everything that's missing is
  // yellow ("env not set"), not red ("fence would fail").
  for (const section of Object.values(r.parsed.sections)) {
    for (const row of section) {
      assert.notEqual(row.status, "red", `unexpected red: ${row.name} (${row.note})`);
    }
  }
});

test("production with no env: multiple boot fences go red, exit 1", () => {
  const r = runWithEnv({ NODE_ENV: "production" });
  assert.equal(r.code, 1);
  assert.equal(r.parsed.overall_status, "red");
  const fenceReds = r.parsed.sections.fences.filter((f) => f.status === "red");
  // Production without env should red on: DB isolation, AES key, Live rails.
  // Python agent secret + escrow audit only red on specific extra conditions.
  assert.ok(fenceReds.length >= 3, `expected ≥3 red fences, got ${fenceReds.length}`);
  assert.ok(
    fenceReds.some((f) => f.name === "DB isolation"),
    "DB isolation should be red in production without URLs",
  );
});

test("production with all baseline env set: every fence green except deferred", () => {
  const r = runWithEnv({
    NODE_ENV: "production",
    BRAIN_WIKI_DB_URL: "postgres://x",
    DATABASE_PRIVILEGED_URL: "postgres://y",
    BRAIN_SOURCE_CREDENTIAL_KEY: "Y".repeat(43) + "=",
    BRAIN_BASE_CHAIN_ID: "84532",
    PLAID_CLIENT_ID: "id",
    PLAID_SECRET: "secret",
  });
  // No red rows — production-allowed bank_ach has its env, all fences pass.
  const reds = [
    ...r.parsed.sections.fences,
    ...r.parsed.sections.rails,
    ...r.parsed.sections.ci_guards,
  ].filter((row) => row.status === "red");
  assert.deepEqual(reds, [], `unexpected reds: ${JSON.stringify(reds)}`);
  assert.equal(r.code, 0);
});

test("production + mainnet escrow without audit flag: fence red", () => {
  const r = runWithEnv({
    NODE_ENV: "production",
    BRAIN_WIKI_DB_URL: "postgres://x",
    DATABASE_PRIVILEGED_URL: "postgres://y",
    BRAIN_SOURCE_CREDENTIAL_KEY: "Y".repeat(43) + "=",
    BRAIN_BASE_CHAIN_ID: "8453",
    BRAIN_ESCROW_ADDRESS: ADDR,
    PLAID_CLIENT_ID: "id",
    PLAID_SECRET: "secret",
  });
  assert.equal(r.code, 1);
  const escrowFence = r.parsed.sections.fences.find((f) => f.name === "Escrow audit (mainnet)");
  assert.equal(escrowFence.status, "red");
  assert.match(escrowFence.note, /would FAIL boot/);
});

test("production + mainnet escrow WITH audit flag: fence green", () => {
  const r = runWithEnv({
    NODE_ENV: "production",
    BRAIN_WIKI_DB_URL: "postgres://x",
    DATABASE_PRIVILEGED_URL: "postgres://y",
    BRAIN_SOURCE_CREDENTIAL_KEY: "Y".repeat(43) + "=",
    BRAIN_BASE_CHAIN_ID: "8453",
    BRAIN_ESCROW_ADDRESS: ADDR,
    BRAIN_ESCROW_AUDIT_APPROVED: "true",
    PLAID_CLIENT_ID: "id",
    PLAID_SECRET: "secret",
  });
  const escrowFence = r.parsed.sections.fences.find((f) => f.name === "Escrow audit (mainnet)");
  assert.equal(escrowFence.status, "green");
  assert.match(escrowFence.note, /audit explicitly attested/);
});

test("production + Python agent URL without secret: fence red", () => {
  const r = runWithEnv({
    NODE_ENV: "production",
    BRAIN_WIKI_DB_URL: "postgres://x",
    DATABASE_PRIVILEGED_URL: "postgres://y",
    BRAIN_SOURCE_CREDENTIAL_KEY: "Y".repeat(43) + "=",
    BRAIN_BASE_CHAIN_ID: "84532",
    PLAID_CLIENT_ID: "id",
    PLAID_SECRET: "secret",
    RECONCILIATION_AGENT_URL: "https://agents.test",
  });
  assert.equal(r.code, 1);
  const hmacFence = r.parsed.sections.fences.find((f) => f.name === "Python agent HMAC secret");
  assert.equal(hmacFence.status, "red");
});

test("CI guards section reports all 10 expected guards", () => {
  const r = runWithEnv({ NODE_ENV: "development" });
  assert.equal(r.parsed.sections.ci_guards.length, 10);
  // Each guard should be green (present + wired into lint) on the real repo.
  for (const g of r.parsed.sections.ci_guards) {
    assert.equal(g.status, "green", `${g.name}: ${g.note}`);
  }
});

test("colored terminal output prints overall summary line", () => {
  const r = execFileSync("node", [SCRIPT], {
    env: { ...process.env, NODE_ENV: "development" },
    encoding: "utf8",
  });
  assert.match(r, /Brain production readiness/);
  assert.match(r, /Overall: (GREEN|YELLOW|RED)/);
});
