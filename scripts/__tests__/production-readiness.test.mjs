import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { escrowAuditFence } from "../production-readiness.mjs";

const SCRIPT = join(process.cwd(), "scripts/production-readiness.mjs");
const ADDR = "0x" + "ab".repeat(20);

// Direct parity matrix for the escrow fence, exercising the same two-part
// condition the runtime fence (assertEscrowAuditApproved) uses. The subprocess
// tests above can only see the real (pending) audit-status.json; this covers the
// approved cases too. Pass/fail here must match the runtime fence for the same
// inputs (Codex 2026-06-06 P1: report and runtime cannot disagree).
const APPROVED = { status: "approved", approved: true };
const PENDING = { status: "pending", approved: false };
const att = { attested: true, hasReceipt: false, auditReceipt: undefined };
const noAtt = { attested: false, hasReceipt: false, auditReceipt: undefined };

test("escrowAuditFence: mainnet + approved record + env attestation => green", () => {
  assert.equal(
    escrowAuditFence({ chainId: "8453", escrowAddr: true, ...att, auditStatus: APPROVED }).status,
    "green",
  );
});
test("escrowAuditFence: mainnet + approved record but NO env attestation => red", () => {
  assert.equal(
    escrowAuditFence({ chainId: "8453", escrowAddr: true, ...noAtt, auditStatus: APPROVED }).status,
    "red",
  );
});
test("escrowAuditFence: mainnet + env attestation but PENDING record => red", () => {
  const row = escrowAuditFence({ chainId: "8453", escrowAddr: true, ...att, auditStatus: PENDING });
  assert.equal(row.status, "red");
  assert.match(row.note, /status=pending \(not approved\)/);
});
test("escrowAuditFence: Sepolia is green regardless of audit/env", () => {
  assert.equal(
    escrowAuditFence({ chainId: "84532", escrowAddr: true, ...noAtt, auditStatus: PENDING }).status,
    "green",
  );
});
test("escrowAuditFence: mainnet with no escrow address is green (silent)", () => {
  assert.equal(
    escrowAuditFence({ chainId: "8453", escrowAddr: false, ...noAtt, auditStatus: PENDING }).status,
    "green",
  );
});

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
  // Code may be 0 or 1 depending on whether any open P0 risks exist in
  // the register at the time. Shape check is what matters here.
  assert.equal(typeof r.parsed.node_env, "string");
  assert.ok(["green", "yellow", "red"].includes(r.parsed.overall_status));
  assert.ok(Array.isArray(r.parsed.sections.rails));
  assert.ok(Array.isArray(r.parsed.sections.fences));
  assert.ok(Array.isArray(r.parsed.sections.ci_guards));
  assert.ok(Array.isArray(r.parsed.sections.deferred));
  assert.ok(Array.isArray(r.parsed.sections.risks));
});

test("dev with no env: only open P0 risks are red (everything else yellow)", () => {
  const r = runWithEnv({ NODE_ENV: "development" });
  // The aggregator surfaces open P0 risks from docs/risk-register.json as
  // red rows. Non-risk sections should never have reds under a dev
  // evaluation (no boot fence is being tested).
  for (const sectionName of ["rails", "fences", "ci_guards", "deferred"]) {
    for (const row of r.parsed.sections[sectionName]) {
      assert.notEqual(
        row.status,
        "red",
        `unexpected red in section ${sectionName}: ${row.name} (${row.note})`,
      );
    }
  }
  // Any red MUST come from an open + P0 risk.
  for (const row of r.parsed.sections.risks) {
    if (row.status === "red") {
      assert.match(row.note, /\[P0 open\]/, `red risk must be open + P0, got: ${row.note}`);
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

test("production with all baseline env set: every fence green (non-risk sections)", () => {
  const r = runWithEnv({
    NODE_ENV: "production",
    BRAIN_WIKI_DB_URL: "postgres://x",
    DATABASE_PRIVILEGED_URL: "postgres://y",
    BRAIN_SOURCE_CREDENTIAL_KEY: "Y".repeat(43) + "=",
    BRAIN_BASE_CHAIN_ID: "84532",
    PLAID_CLIENT_ID: "id",
    PLAID_SECRET: "secret",
  });
  // Production-allowed bank_ach has its env; all fences + guards pass.
  // The risks section may still surface open P0 risks from the register;
  // those are the substantive blockers the boot env alone can't fix.
  const reds = [
    ...r.parsed.sections.fences,
    ...r.parsed.sections.rails,
    ...r.parsed.sections.ci_guards,
  ].filter((row) => row.status === "red");
  assert.deepEqual(reds, [], `unexpected reds outside risks: ${JSON.stringify(reds)}`);
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

test("production + mainnet escrow WITH env attestation but PENDING audit record: fence RED (parity)", () => {
  // Parity fix (Codex 2026-06-06 P1): a bare env attestation no longer turns the
  // fence green. The committed contracts/audit-status.json is `pending`, so the
  // report must red — matching the runtime fence, which refuses to boot. The
  // report cannot be green for a deployment the runtime rejects.
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
  assert.equal(escrowFence.status, "red");
  assert.match(escrowFence.note, /audit-status\.json status=pending \(not approved\)/);
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

test("CI guards section includes check-audit-status and all are green", () => {
  const r = runWithEnv({ NODE_ENV: "development" });
  const names = r.parsed.sections.ci_guards.map((g) => g.name);
  // Assert the expected guards are present (names, not a brittle hard count) —
  // check-audit-status was added with the R-01 control and must be reported.
  assert.ok(names.includes("check-audit-status"), `missing check-audit-status; got ${names.join(", ")}`);
  assert.ok(names.includes("check-escrow-audit-marker"));
  assert.ok(r.parsed.sections.ci_guards.length >= 11, `expected >= 11 guards, got ${names.length}`);
  for (const g of r.parsed.sections.ci_guards) {
    assert.equal(g.status, "green", `${g.name}: ${g.note}`);
  }
});

test("deferred blob-purge row is sourced from R-02 (no stale 'awaiting signoff'), and agrees with the register", () => {
  // P2 #2 (2026-06-07 review): the blob-purge readiness line used a hardcoded
  // existsSync on a path that does not exist (src/workers/...), so it always
  // reported "deferred; awaiting signoff" even though the worker shipped, while
  // the risk register said phase B shipped. The line is now derived from the
  // R-02 risk-register entry, so the two can never disagree.
  const r = runWithEnv({ NODE_ENV: "development" });
  const blobRow = r.parsed.sections.deferred.find((row) => /blob purge/i.test(row.name));
  assert.ok(blobRow, "expected a tenant blob-purge row in the deferred section");
  // The stale lie must be gone.
  assert.doesNotMatch(blobRow.note, /awaiting signoff/i, `stale note: ${blobRow.note}`);
  // It must reflect the real R-02 status and agree with the risks section.
  const r02 = r.parsed.sections.risks.find((row) => row.name.startsWith("R-02"));
  assert.ok(r02, "R-02 should be present in the risks section");
  // R-02 is 'mitigating' (yellow) while hardening + the live-cloud erasure
  // integration test remain; the deferred line must match (never green while
  // R-02 is open/mitigating).
  assert.equal(blobRow.status, r02.status === "red" ? "red" : "yellow");
  assert.match(blobRow.note, /R-02/);
});

test("colored terminal output prints overall summary line", () => {
  // The script may exit 1 (an open P0 risk in the real register puts the
  // aggregator in red); the human-readable output is what we assert on,
  // so we capture stdout regardless of exit code.
  let out = "";
  try {
    out = execFileSync("node", [SCRIPT], {
      env: { ...process.env, NODE_ENV: "development" },
      encoding: "utf8",
    }).toString();
  } catch (err) {
    out = err.stdout?.toString() ?? "";
  }
  assert.match(out, /Brain production readiness/);
  assert.match(out, /Overall: (GREEN|YELLOW|RED)/);
  assert.match(out, /Open risks \(from docs\/risk-register\.json\)/);
});

test("risk section is populated from docs/risk-register.json", () => {
  const r = runWithEnv({ NODE_ENV: "development" });
  const risks = r.parsed.sections.risks;
  assert.ok(risks.length > 0, "risks section should not be empty");
  // Every row carries the [PRIO status] prefix in note.
  for (const row of risks) {
    assert.match(row.note, /\[(P0|P1|P2) (open|mitigating)\]/);
  }
});

test("closed risks (status=closed) are NOT surfaced in the live register section", () => {
  const r = runWithEnv({ NODE_ENV: "development" });
  // R-05 is closed in the fixture; it should not appear as a row here.
  // (Closed risks remain documented in the .md for history.)
  const closed = r.parsed.sections.risks.find((row) => row.name.startsWith("R-05"));
  assert.equal(closed, undefined, `closed risk leaked into live section: ${JSON.stringify(closed)}`);
});

test("any open + P0 risk turns overall_status red and exits 1", () => {
  // Sanity check against the real register: at the time of writing R-01
  // (escrow audit) is open + P0, so the overall MUST be red until the
  // audit closes. If this assertion ever flips to green, R-01 was closed
  // by intention and this test should be updated alongside.
  const r = runWithEnv({ NODE_ENV: "development" });
  const openP0 = r.parsed.sections.risks.filter((row) => /\[P0 open\]/.test(row.note));
  if (openP0.length > 0) {
    assert.equal(r.parsed.overall_status, "red");
    assert.equal(r.code, 1);
  }
});
