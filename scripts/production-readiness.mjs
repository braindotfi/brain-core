#!/usr/bin/env node
/**
 * `pnpm run production-readiness` — one repeatable command for operators,
 * auditors, and release managers to validate "would a deploy be safe right
 * now?" against the current env + the current repo state.
 *
 * This is NOT a runtime check; the api's brain.runtime.capabilities log
 * line is the runtime read. This is the PRE-deploy read: given the
 * machine's env right now, would the boot fences let me start?
 *
 * Output: a colored summary table to the terminal. Exit code 0 when every
 * check is green; 1 if any required check is red. Use --json for the
 * machine-readable form (CI / dashboards consume this).
 *
 * Categories:
 *   - rails posture            (per-rail required_env_present + production_allowed)
 *   - boot fences              (would each fence pass given current env?)
 *   - CI guards                (do all required lint scripts exist in package.json?)
 *   - tenant deletion / blob   (informational: phase B status)
 *   - external blockers        (audit + Azure deploy)
 *
 * Reads env from process.env. To check a specific deploy's env, source
 * its .env first:  `set -a && source path/to/.env && set +a && pnpm run production-readiness`.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { evaluateApproval } from "./lib/audit-status.mjs";

const ROOT = process.cwd();
const ARGS = new Set(process.argv.slice(2));
const JSON_MODE = ARGS.has("--json");

const env = process.env;
const NODE_ENV = env.NODE_ENV ?? "unset";

// ---- helpers ---------------------------------------------------------------

const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
};
const color = (c, s) => (JSON_MODE ? s : `${COLORS[c]}${s}${COLORS.reset}`);

const STATUS = {
  green: { glyph: "✓", color: "green" },
  yellow: { glyph: "•", color: "yellow" },
  red: { glyph: "✗", color: "red" },
  info: { glyph: "ⓘ", color: "cyan" },
};

function envSet(key) {
  return env[key] !== undefined && env[key] !== "";
}

// Read contracts/audit-status.json through the SAME canonical validator the
// runtime escrow boot fence (composition/escrow-audit-gate.ts) and the CI guard
// (check-audit-status.mjs) use, so this pre-deploy report and the runtime fence
// give the SAME pass/fail decision. `approved` is the full evaluateApproval
// verdict (auditor + 40-hex commit + report + zero critical/high), NOT a bare
// status check — an incomplete record whose status reads "approved" is not
// approved here either. Fail-closed: a missing/malformed file is not-approved.
function readAuditStatus() {
  try {
    const doc = JSON.parse(readFileSync(join(ROOT, "contracts/audit-status.json"), "utf8"));
    const status = typeof doc.status === "string" ? doc.status : "missing";
    return { status, approved: evaluateApproval(doc).approved };
  } catch {
    return { status: "missing", approved: false };
  }
}

/**
 * Pure escrow-audit fence row, mirroring assertEscrowAuditApproved EXACTLY so
 * the report and the runtime fence can never disagree: on Base mainnet (8453)
 * with an escrow address, boot requires BOTH the committed audit record
 * (audit-status.json status=approved) AND an operator env attestation. Exported
 * for direct parity testing. Silent (green) on non-mainnet or no escrow address.
 */
export function escrowAuditFence({
  chainId,
  escrowAddr,
  attested,
  hasReceipt,
  auditReceipt,
  auditStatus,
}) {
  const name = "Escrow audit (mainnet)";
  if (chainId !== "8453" || !escrowAddr) {
    return {
      name,
      status: "green",
      note: chainId === "8453" ? "no escrow address (silent)" : `Sepolia (chain ${chainId})`,
    };
  }
  if (auditStatus.approved && attested) {
    return {
      name,
      status: "green",
      note: `audit-status approved + ${hasReceipt ? `receipt: ${auditReceipt}` : "legacy boolean attestation"}`,
    };
  }
  const missing = [];
  if (!auditStatus.approved)
    missing.push(`audit-status.json status=${auditStatus.status} (not approved)`);
  if (!attested) missing.push("no BRAIN_ESCROW_AUDIT_RECEIPT / BRAIN_ESCROW_AUDIT_APPROVED");
  return { name, status: "red", note: `would FAIL boot — ${missing.join("; ")}` };
}

// Parse the rail catalog (same regex as check-rails-catalog-drift).
function loadRailCatalog() {
  const src = readFileSync(join(ROOT, "services/api/src/composition/rail-catalog.ts"), "utf8");
  const re =
    /\{\s*name:\s*"([^"]+)",[\s\S]*?productionAllowed:\s*(true|false),[\s\S]*?requiredEnv:\s*\[([^\]]*)\],[\s\S]*?evmChain:\s*(true|false),[\s\S]*?auditRequired:\s*(true|false)[\s\S]*?\}/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const envList = m[3]
      .split(",")
      .map((s) => s.trim().replace(/^"|"$/g, ""))
      .filter((s) => s.length > 0);
    out.push({
      name: m[1],
      productionAllowed: m[2] === "true",
      requiredEnv: envList,
      evmChain: m[4] === "true",
      auditRequired: m[5] === "true",
    });
  }
  return out;
}

// ---- checks ---------------------------------------------------------------

function checkRails(catalog) {
  const rows = [];
  for (const rail of catalog) {
    const requiredPresent = rail.requiredEnv.length > 0 && rail.requiredEnv.every(envSet);
    let status;
    let note;
    if (!rail.productionAllowed) {
      status = "yellow";
      note = "stub-only; would refuse to settle in production";
    } else if (requiredPresent) {
      status = "green";
      note = "ready (env present)";
    } else {
      const missing = rail.requiredEnv.filter((k) => !envSet(k));
      status = "yellow";
      note = `env missing: ${missing.join(", ")}`;
    }
    rows.push({ name: rail.name, status, note });
  }
  // Top-level rail readiness: at least one prod-allowed + env-present rail.
  const anyLive = rows.some(
    (r) => r.status === "green" && catalog.find((c) => c.name === r.name)?.productionAllowed,
  );
  return { rows, anyLive };
}

function checkBootFences(catalog) {
  const fences = [];

  // 1. DB isolation
  const wikiDb = envSet("BRAIN_WIKI_DB_URL");
  const privDb = envSet("DATABASE_PRIVILEGED_URL");
  if (NODE_ENV === "production" && (!wikiDb || !privDb)) {
    fences.push({
      name: "DB isolation",
      status: "red",
      note: `would FAIL boot — missing ${[!wikiDb && "BRAIN_WIKI_DB_URL", !privDb && "DATABASE_PRIVILEGED_URL"].filter(Boolean).join(" + ")}`,
    });
  } else if (!wikiDb || !privDb) {
    fences.push({
      name: "DB isolation",
      status: "yellow",
      note: "would warn (set both URLs for production)",
    });
  } else {
    fences.push({ name: "DB isolation", status: "green", note: "both URLs set" });
  }

  // 2. Escrow audit — uses the same two-part rule as the runtime fence.
  const chainId = env.BRAIN_BASE_CHAIN_ID ?? "84532";
  const escrowAddr = envSet("BRAIN_ESCROW_ADDRESS");
  const auditApproved = env.BRAIN_ESCROW_AUDIT_APPROVED === "true";
  const auditReceipt = env.BRAIN_ESCROW_AUDIT_RECEIPT;
  const hasReceipt = typeof auditReceipt === "string" && auditReceipt.length > 0;
  fences.push(
    escrowAuditFence({
      chainId,
      escrowAddr,
      attested: auditApproved || hasReceipt,
      hasReceipt,
      auditReceipt,
      auditStatus: readAuditStatus(),
    }),
  );

  // 3. Live rails in production
  const live = catalog.some(
    (r) => r.productionAllowed && r.requiredEnv.length > 0 && r.requiredEnv.every(envSet),
  );
  if (NODE_ENV === "production" && !live) {
    fences.push({
      name: "Live rails (production)",
      status: "red",
      note: "would FAIL boot — no production-allowed rail has all required env",
    });
  } else if (!live) {
    fences.push({
      name: "Live rails (production)",
      status: "yellow",
      note: "no production-allowed rail ready; dev stubs only",
    });
  } else {
    fences.push({ name: "Live rails (production)", status: "green", note: "at least one ready" });
  }

  // 4. AES-256-GCM source-credential key provider
  const keyProvider =
    envSet("BRAIN_SOURCE_CREDENTIAL_KEY_VAULT_URL") || envSet("BRAIN_SOURCE_CREDENTIAL_KEY");
  if (NODE_ENV === "production" && !keyProvider) {
    fences.push({
      name: "AES-256-GCM credential key",
      status: "red",
      note: "would FAIL boot — no KMS provider and no BRAIN_SOURCE_CREDENTIAL_KEY",
    });
  } else if (!keyProvider) {
    fences.push({
      name: "AES-256-GCM credential key",
      status: "yellow",
      note: "no key configured (acceptable in dev for non-credential sources)",
    });
  } else {
    fences.push({
      name: "AES-256-GCM credential key",
      status: "green",
      note: envSet("BRAIN_SOURCE_CREDENTIAL_KEY_VAULT_URL")
        ? "Azure Key Vault"
        : "env-var (dev/staging only)",
    });
  }

  // 5. Python agent inbound HMAC secret
  const reconUrl = envSet("RECONCILIATION_AGENT_URL");
  const inboundSecret = envSet("BRAIN_AGENTS_INBOUND_SECRET");
  if (NODE_ENV === "production" && reconUrl && !inboundSecret) {
    fences.push({
      name: "Python agent HMAC secret",
      status: "red",
      note: "would FAIL boot — RECONCILIATION_AGENT_URL set without BRAIN_AGENTS_INBOUND_SECRET",
    });
  } else if (reconUrl && !inboundSecret) {
    fences.push({
      name: "Python agent HMAC secret",
      status: "yellow",
      note: "agent URL set; secret missing (would 401 in production)",
    });
  } else if (!reconUrl) {
    fences.push({
      name: "Python agent HMAC secret",
      status: "green",
      note: "Python agent surface not in use",
    });
  } else {
    fences.push({ name: "Python agent HMAC secret", status: "green", note: "both set" });
  }

  return fences;
}

const REQUIRED_GUARDS = [
  "check-scope-vocab",
  "check-gate-bypass",
  "check-payment-intent-loaders",
  "check-no-em-dashes",
  "check-wiki-no-ledger-write",
  "check-policy-no-wiki-read",
  "check-no-onchain-pii",
  "check-docs-drift",
  "check-rails-catalog-drift",
  "check-escrow-audit-marker",
  "check-audit-status",
];

function checkCiGuards() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const scripts = pkg.scripts ?? {};
  const lint = scripts.lint ?? "";
  const rows = [];
  for (const guard of REQUIRED_GUARDS) {
    const present = guard in scripts;
    const inLint = lint.includes(`pnpm run ${guard}`);
    if (present && inLint) {
      rows.push({ name: guard, status: "green", note: "in scripts + wired into lint" });
    } else if (present && !inLint) {
      rows.push({ name: guard, status: "yellow", note: "defined but NOT wired into lint" });
    } else {
      rows.push({ name: guard, status: "red", note: "missing from package.json" });
    }
  }
  return rows;
}

/** Read a single risk-register entry by id; null if the file or id is absent. */
function readRisk(id) {
  const path = join(ROOT, "docs/risk-register.json");
  if (!existsSync(path)) return null;
  try {
    const register = JSON.parse(readFileSync(path, "utf8"));
    return (register.risks ?? []).find((r) => r.id === id) ?? null;
  } catch {
    return null;
  }
}

function checkDeferredItems() {
  const rows = [];
  // Derive the blob-purge readiness line from the R-02 risk-register entry (the
  // single structured source) rather than a file-existence heuristic. The old
  // probe checked a path that never existed (src/workers/...), so it reported
  // "awaiting signoff" forever even though the worker shipped — disagreeing with
  // the register. Sourcing from R-02 makes the two agree by construction: green
  // only when R-02 is closed (all hardening + the live-cloud erasure integration
  // test done), yellow while it is open/mitigating.
  const r02 = readRisk("R-02");
  if (r02 === null) {
    rows.push({
      name: "Tenant blob purge (RFC 0003 phase B)",
      status: "yellow",
      note: "R-02 not found in docs/risk-register.json; cannot determine status",
    });
  } else {
    rows.push({
      name: "Tenant blob purge (RFC 0003 phase B)",
      status: r02.status === "closed" ? "green" : "yellow",
      note: `R-02 ${r02.status}: ${r02.mitigation_summary}`,
    });
  }

  // Drive this off the committed audit record, NOT the presence/absence of a
  // TODO marker in AUDIT-SCOPE.md (that flips green the moment the marker is
  // edited, independent of the real audit). green only when approved; yellow
  // while in progress; yellow (not green) while pending.
  const auditStatus = readAuditStatus();
  rows.push({
    name: "External smart-contract audit (BrainEscrow)",
    status: auditStatus.approved ? "green" : "yellow",
    note: auditStatus.approved
      ? "audit-status.json: approved"
      : `audit-status.json: ${auditStatus.status}; mainnet escrow boot-fenced until approved`,
  });

  return rows;
}

/**
 * Read the machine-readable risk register and convert open + P0/P1 risks
 * into rows. The bridge from docs/risk-register.json to this aggregator is
 * what makes "open P0 risk" automatically a red row, so CI gates that
 * call `production-readiness --json` block promotion when a P0 is open.
 *
 *   open + P0          → red
 *   open + P1          → yellow
 *   mitigating + P0    → yellow (partial mitigation; gap not closed)
 *   mitigating + P1    → yellow
 *   closed             → not shown (covered in the .md history section)
 *   anything else      → yellow (defensive)
 */
function checkRiskRegister() {
  const path = join(ROOT, "docs/risk-register.json");
  if (!existsSync(path)) {
    return [
      {
        name: "Risk register",
        status: "red",
        note: "docs/risk-register.json missing; aggregator cannot evaluate risk posture",
      },
    ];
  }
  const register = JSON.parse(readFileSync(path, "utf8"));
  const risks = register.risks ?? [];
  const rows = [];
  for (const r of risks) {
    if (r.status === "closed") continue;
    let status;
    if (r.status === "open" && r.priority === "P0") status = "red";
    else status = "yellow";
    rows.push({
      name: `${r.id} ${r.title}`,
      status,
      note: `[${r.priority} ${r.status}] ${r.mitigation_summary}`,
    });
  }
  if (rows.length === 0) {
    rows.push({
      name: "Risk register",
      status: "green",
      note: "no open risks in register",
    });
  }
  return rows;
}

// ---- render ---------------------------------------------------------------

function renderSection(title, rows) {
  const lines = [];
  lines.push("");
  lines.push(color("bold", color("cyan", `── ${title} ──`)));
  for (const row of rows) {
    const cfg = STATUS[row.status];
    const glyph = color(cfg.color, cfg.glyph);
    lines.push(`  ${glyph} ${row.name.padEnd(40)} ${color("dim", row.note)}`);
  }
  return lines.join("\n");
}

function main() {
  const catalog = loadRailCatalog();
  const railResult = checkRails(catalog);
  const fences = checkBootFences(catalog);
  const guards = checkCiGuards();
  const deferred = checkDeferredItems();
  const risks = checkRiskRegister();

  const allRows = [
    ...railResult.rows.map((r) => ({ ...r, section: "rails" })),
    ...fences.map((r) => ({ ...r, section: "fences" })),
    ...guards.map((r) => ({ ...r, section: "guards" })),
    ...deferred.map((r) => ({ ...r, section: "deferred" })),
    ...risks.map((r) => ({ ...r, section: "risks" })),
  ];

  if (JSON_MODE) {
    const summary = {
      node_env: NODE_ENV,
      overall_status: allRows.some((r) => r.status === "red")
        ? "red"
        : allRows.some((r) => r.status === "yellow")
          ? "yellow"
          : "green",
      sections: {
        rails: railResult.rows,
        fences,
        ci_guards: guards,
        deferred,
        risks,
      },
    };
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(color("bold", "\nBrain production readiness"));
    console.log(`  NODE_ENV = ${color("cyan", NODE_ENV)}`);
    console.log(renderSection("Rails posture", railResult.rows));
    console.log(renderSection("Boot fences (would a fresh boot pass?)", fences));
    console.log(renderSection("CI guards", guards));
    console.log(renderSection("Deferred / external blockers", deferred));
    console.log(renderSection("Open risks (from docs/risk-register.json)", risks));
    const overall = allRows.some((r) => r.status === "red")
      ? "RED"
      : allRows.some((r) => r.status === "yellow")
        ? "YELLOW"
        : "GREEN";
    const c = overall === "RED" ? "red" : overall === "YELLOW" ? "yellow" : "green";
    console.log("\n" + color("bold", color(c, `Overall: ${overall}`)));
    if (overall === "RED") {
      console.log(
        color(
          "dim",
          "Run with --json for machine output. Set NODE_ENV=production to evaluate as a production boot.",
        ),
      );
    }
  }

  if (allRows.some((r) => r.status === "red")) process.exit(1);
}

// Run only when invoked directly (node scripts/production-readiness.mjs), so the
// pure helpers above can be imported by tests without executing main().
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
