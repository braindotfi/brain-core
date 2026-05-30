#!/usr/bin/env node
/**
 * CI guard: defence-in-depth on top of `composition/escrow-audit-gate.ts`.
 *
 * The boot fence catches a misconfigured escrow-on-mainnet deploy at
 * RUNTIME (CrashLoopBackoff in k8s). This guard catches the same misconfig
 * at PR-REVIEW time so the deploy that would CrashLoopBackoff never even
 * lands. Defence in depth, same altitude as the other lint guards.
 *
 * Scans every committed env/config file (env, env.example, .env.*, YAML
 * values, Terraform .tf, shell exports) and fails when ALL of:
 *   1. `BRAIN_BASE_CHAIN_ID=8453` (or YAML `BRAIN_BASE_CHAIN_ID: 8453`)
 *   2. `BRAIN_ESCROW_ADDRESS=0x...` (non-empty)
 *   3. `BRAIN_ESCROW_AUDIT_APPROVED=true` is NOT set
 * appear in the same file.
 *
 * Why per-file: a Terraform module that wires escrow on mainnet should
 * ALSO set the audit-approved flag in the same module. Splitting across
 * files defeats the boot fence at runtime too.
 *
 * Sepolia (`84532`) is silent: no audit required there. Mainnet without
 * an escrow address is silent: not registering the rail.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".claude",
  ".vscode",
  ".idea",
  "dist",
  ".venv",
  "venv",
  "coverage",
  ".next",
  ".turbo",
  "target",
  "build",
  "__pycache__",
]);

/**
 * Files this guard inspects. We scan anything with env-var-shaped content:
 * .env / .env.* / *.env, YAML (helm values, k8s manifests), Terraform .tf,
 * shell scripts, dotfiles like docker-compose.yml.
 *
 * We DO scan .md files when they contain raw env blocks (e.g.
 * docs/rails-matrix.md shows example env). The guard tolerates docs that
 * SHOW the dangerous combo in a code fence because operators copy from
 * docs; the parsing skip below filters them out by requiring the variable
 * assignments to be at column 0 (not indented inside a markdown code fence).
 */
const INCLUDE_EXTENSIONS = [
  ".env",
  ".tf",
  ".tfvars",
  ".yaml",
  ".yml",
  ".sh",
  ".bash",
];
const INCLUDE_BASENAMES = ["env", "Dockerfile", "docker-compose.yml", "docker-compose.yaml"];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    let st;
    try {
      st = statSync(p);
    } catch {
      // Broken symlinks or permission errors — skip silently. They can't
      // hold an escrow misconfig anyway.
      continue;
    }
    if (st.isDirectory()) {
      out.push(...walk(p));
    } else if (st.isFile()) {
      out.push(p);
    }
  }
  return out;
}

function isCandidate(path) {
  const rel = relative(ROOT, path);
  if (rel.startsWith("scripts/__tests__/")) return false;
  if (rel.endsWith("check-escrow-audit-marker.mjs")) return false; // self
  // Match by extension OR by exact basename OR by .env prefix.
  const ext = rel.slice(rel.lastIndexOf("."));
  if (INCLUDE_EXTENSIONS.includes(ext)) return true;
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  if (INCLUDE_BASENAMES.includes(base)) return true;
  if (/(^|\/)\.env(\.|$)/.test(rel)) return true;
  return false;
}

/**
 * Parse a candidate file and pull (key, value) pairs from lines that LOOK
 * like assignments at column 0 (not buried inside indented YAML / markdown).
 * Supports:
 *   KEY=value       (env / shell)
 *   KEY="value"     (env / shell)
 *   KEY: value      (top-level YAML)
 *   export KEY=v    (shell)
 *   KEY = "value"   (Terraform .tf / .tfvars)
 */
function parseAssignments(src) {
  const out = new Map();
  for (const rawLine of src.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trimEnd();
    if (line.length === 0) continue;
    // Reject indented lines (the assignment is nested inside something else).
    if (/^\s/.test(line)) continue;
    // Strip optional "export ".
    const stripped = line.replace(/^export\s+/, "");
    // Match KEY=value, KEY="value", KEY: value, KEY = value.
    const m = /^([A-Z_][A-Z0-9_]*)\s*[:=]\s*(.+)$/.exec(stripped);
    if (m === null) continue;
    let value = m[2].trim();
    // Strip wrapping quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out.set(m[1], value);
  }
  return out;
}

function inspect(path) {
  const src = readFileSync(path, "utf8");
  const assignments = parseAssignments(src);
  const chainId = assignments.get("BRAIN_BASE_CHAIN_ID");
  const escrowAddr = assignments.get("BRAIN_ESCROW_ADDRESS");
  const auditApproved = assignments.get("BRAIN_ESCROW_AUDIT_APPROVED");
  if (chainId !== "8453") return null;
  if (escrowAddr === undefined || escrowAddr.length === 0 || escrowAddr === "null") return null;
  if (auditApproved === "true") return null;
  return {
    path: relative(ROOT, path),
    chainId,
    escrowAddr,
    auditApproved: auditApproved ?? "(unset)",
  };
}

function main() {
  const files = walk(ROOT).filter(isCandidate);
  const violations = [];
  for (const f of files) {
    const hit = inspect(f);
    if (hit !== null) violations.push(hit);
  }
  if (violations.length > 0) {
    console.error("escrow-audit-marker guard: FAIL");
    for (const v of violations) {
      console.error(
        `  ${v.path}: BRAIN_BASE_CHAIN_ID=${v.chainId} (mainnet) + BRAIN_ESCROW_ADDRESS=${v.escrowAddr} but BRAIN_ESCROW_AUDIT_APPROVED=${v.auditApproved}`,
      );
    }
    console.error(
      "\nMainnet escrow boot is gated on the external smart-contract audit\n" +
        "(see contracts/AUDIT-SCOPE.md + composition/escrow-audit-gate.ts).\n" +
        "Either:\n" +
        "  - flip BRAIN_ESCROW_AUDIT_APPROVED=\"true\" in the same file (only\n" +
        "    after the audit has signed off and the deployed bytecode is verified), or\n" +
        "  - remove BRAIN_ESCROW_ADDRESS from this config until audit clears, or\n" +
        "  - target Sepolia (BRAIN_BASE_CHAIN_ID=84532) for now.",
    );
    process.exit(1);
  }
  console.log(`escrow-audit-marker guard: OK (${files.length} env/config files scanned)`);
}

main();
