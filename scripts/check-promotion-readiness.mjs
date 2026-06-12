#!/usr/bin/env node
/**
 * H-24 promotion-readiness gate.
 *
 * Shadow-by-default is the safe default; promoting a money-mover to LIVE is the
 * dangerous moment. This script is the machine-checkable gate: an agent may not
 * be added to services/agent-router/src/promotion-config.ts (LIVE_AGENTS)
 * unless every readiness check below is green for that agent.
 *
 * Most checks are static repo introspection (migrations present + RLS-armed,
 * gate checks 9.5/11.5 active, typed rail receipts, replay endpoint, halt-category
 * + adversarial tests, …). Two checks (on-chain behavior hash, session-key grants)
 * cannot be verified from the repo — they require a BrainMCPAgentRegistry read /
 * a live DB. They report BLOCKED and fail the gate until an operator confirms them
 * out-of-band and passes `--attest onchain_behavior_hash,session_key_grants`.
 *
 * Usage:
 *   node scripts/check-promotion-readiness.mjs --agent <key> [--repo <dir>] [--attest a,b]
 *
 * CI: run for each agent newly added to promotion-config.ts; fail the PR on any
 * red row (see Brain_Engineering_Standards.md §"Promotion readiness").
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function read(repo, rel) {
  try {
    return readFileSync(join(repo, rel), "utf8");
  } catch {
    return null;
  }
}
const has = (repo, rel) => existsSync(join(repo, rel));
const contains = (repo, rel, ...subs) => {
  const txt = read(repo, rel);
  return txt !== null && subs.every((s) => txt.includes(s));
};

/** Parse the rails allowlisted for `agent` from promotion-config.ts. */
function railAllowlist(repo, agent) {
  const cfg = read(repo, "services/agent-router/src/promotion-config.ts");
  if (cfg === null) return [];
  // Match e.g.  savings: ["ach", "wire"]   or   "savings": ['ach']
  const m = cfg.match(new RegExp(`["']?${agent}["']?\\s*:\\s*\\[([^\\]]*)\\]`));
  if (m === null) return [];
  return [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
}

/** A check: (ctx) => { ok, blocked?, detail }. ctx = { repo, agent, rails, attest }. */
const CHECKS = [
  {
    id: "outbox_rls",
    label: "Execution outbox table exists and is RLS-armed",
    run: ({ repo }) => {
      const ok = contains(
        repo,
        "services/execution/migrations/0017_execution_outbox.sql",
        "execution_outbox",
        "ENABLE ROW LEVEL SECURITY",
      );
      return {
        ok,
        detail: ok ? "migration 0017 present + RLS" : "missing 0017_execution_outbox.sql / RLS",
      };
    },
  },
  {
    id: "reservation_concurrency_test",
    label: "Live reservation writes tested (concurrent case)",
    run: ({ repo }) => {
      const ok = contains(
        repo,
        "services/ledger/src/repository/reservations.test.ts",
        "concurrent",
      );
      return {
        ok,
        detail: ok
          ? "reservations.test.ts covers concurrency"
          : "missing concurrent reservation test",
      };
    },
  },
  {
    id: "spend_counter_test",
    label: "Spend counter integration test",
    run: ({ repo }) => {
      const ok =
        contains(repo, "services/policy/src/spend-counters.test.ts", "window") ||
        contains(repo, "services/policy/src/spend-counters.integration.test.ts", "");
      return {
        ok,
        detail: ok ? "spend-counter test present" : "missing spend-counter integration test",
      };
    },
  },
  {
    id: "rail_allowlist",
    label: "Rail allowlist non-empty for agent",
    run: ({ agent, rails }) => {
      const ok = rails.length > 0;
      return {
        ok,
        detail: ok
          ? `${agent}: [${rails.join(", ")}]`
          : `${agent} has no rails in promotion-config.ts`,
      };
    },
  },
  {
    id: "typed_rail_receipt",
    label: "Typed rail receipt schema for each allowed rail",
    run: ({ repo, rails }) => {
      if (rails.length === 0) return { ok: false, detail: "no rails to check (allowlist empty)" };
      const txt = read(repo, "services/execution/src/rails/receipts.ts") ?? "";
      const missing = rails.filter((r) => !txt.includes(`"${r}"`) && r !== "n/a");
      const ok = missing.length === 0;
      return {
        ok,
        detail: ok
          ? rails.map((r) => `${r}: ✓`).join(", ")
          : `missing receipt schema: ${missing.join(", ")}`,
      };
    },
  },
  {
    id: "dedup_gate_check",
    label: "Duplicate-payment gate check active (11.5)",
    run: ({ repo }) => {
      const ok = contains(repo, "shared/src/gate/gate.ts", "no_duplicate_payment");
      return { ok, detail: ok ? "check 11.5 present" : "check 11.5 missing from gate.ts" };
    },
  },
  {
    id: "evidence_validator",
    label: "Evidence semantic validator for action types (9.5)",
    run: ({ repo }) => {
      const ok = contains(
        repo,
        "shared/src/gate/evidence-validator.ts",
        "pay_invoice",
        "pay_obligation",
      );
      return {
        ok,
        detail: ok
          ? "pay_invoice, pay_obligation registered"
          : "evidence validator missing action types",
      };
    },
  },
  {
    id: "audit_pair_invariant",
    label: "Audit-before/after pair invariant tested",
    run: ({ repo }) => {
      const ok = contains(repo, "tests/invariants/src/invariants.test.ts", "audit-after");
      return { ok, detail: ok ? "invariant test present" : "missing audit-pair invariant test" };
    },
  },
  {
    id: "replay_investigation_route",
    label: "Replay-investigation endpoint reachable",
    run: ({ repo }) => {
      const ok = contains(
        repo,
        "services/execution/src/payment-intents/routes.ts",
        "replay-investigation",
      );
      return { ok, detail: ok ? "route registered" : "replay-investigation route missing" };
    },
  },
  {
    id: "halt_category_tests",
    label: "Halt-category integration tests",
    run: ({ repo }) => {
      const ok =
        contains(repo, "services/agent-router/src/agent-api.test.ts", "halt-category") ||
        contains(repo, "services/agent-router/src/agent-api.halt.test.ts", "halt");
      return { ok, detail: ok ? "halt-category tested" : "missing halt-category tests" };
    },
  },
  {
    id: "onchain_behavior_hash",
    label: "On-chain behaviorHash registered for agent",
    run: ({ attest }) =>
      attest.has("onchain_behavior_hash")
        ? { ok: true, detail: "operator-attested" }
        : {
            ok: false,
            blocked: true,
            detail:
              "requires BrainMCPAgentRegistry read; --attest onchain_behavior_hash once confirmed",
          },
  },
  {
    id: "session_key_grants",
    label: "Session-key grants exist with non-empty allowlists",
    run: ({ attest }) =>
      attest.has("session_key_grants")
        ? { ok: true, detail: "operator-attested" }
        : {
            ok: false,
            blocked: true,
            detail: "requires live DB read; --attest session_key_grants once confirmed",
          },
  },
  {
    id: "adversarial_agent_tests",
    label: "Adversarial test suite covers this agent",
    run: ({ repo, agent }) => {
      const ok = has(repo, `tests/invariants/agents/${agent}.test.ts`);
      return {
        ok,
        detail: ok
          ? `tests/invariants/agents/${agent}.test.ts`
          : `no tests/invariants/agents/${agent}.test.ts`,
      };
    },
  },
];

/** Run every check; returns { rows, allOk }. Pure (no process exit) for testing. */
export function runReadinessChecks({ repo, agent, attest = [] }) {
  const ctx = { repo, agent, rails: railAllowlist(repo, agent), attest: new Set(attest) };
  const rows = CHECKS.map((c) => {
    const { ok, blocked = false, detail } = c.run(ctx);
    return { id: c.id, label: c.label, ok, blocked, detail };
  });
  return { rows, allOk: rows.every((r) => r.ok) };
}

function renderTable(rows) {
  const status = (r) => (r.ok ? "✓" : r.blocked ? "BLOCKED" : "✗");
  const lines = ["| Check | Status | Detail |", "|---|---|---|"];
  for (const r of rows) lines.push(`| ${r.label} | ${status(r)} | ${r.detail} |`);
  return lines.join("\n");
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const agent = arg("--agent");
  if (agent === undefined) {
    console.error(
      "usage: check-promotion-readiness.mjs --agent <key> [--repo <dir>] [--attest a,b]",
    );
    process.exit(2);
  }
  const repo = arg("--repo") ?? process.cwd();
  const attest = (arg("--attest") ?? "").split(",").filter(Boolean);

  const { rows, allOk } = runReadinessChecks({ repo, agent, attest });
  console.log(`Promotion readiness for agent "${agent}":\n`);
  console.log(renderTable(rows));
  if (!allOk) {
    const bad = rows.filter((r) => !r.ok).map((r) => r.id);
    console.error(`\n✗ NOT READY — failing checks: ${bad.join(", ")}`);
    console.error("Promotion to live is blocked until every check is green.");
    process.exit(1);
  }
  console.log(`\n✓ READY — agent "${agent}" may be promoted to live.`);
}

// Run as CLI only (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
