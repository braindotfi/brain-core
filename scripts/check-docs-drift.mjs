#!/usr/bin/env node
/**
 * Docs-drift guard (RFC 0001 §12).
 *
 * The published GitBook docs (the dirs listed in SUMMARY.md) drifted badly from
 * the code — describing a gate that didn't match, an anchor cadence that didn't
 * match, and an aspirational on-chain stack (ERC-4337 / proxy upgrades / on-chain
 * reputation) the contracts don't implement. After reconciling them, this guard
 * stops the drift from creeping back.
 *
 * Two tiers:
 *  - HARD: claims that are simply wrong about the current code — never allowed.
 *  - MARKED: forward-looking names that are fine ONLY when the line marks them as
 *    planned/roadmap/conceptual (so the autonomous-finance narrative stays
 *    visible without masquerading as shipped).
 *
 * Run: pnpm run check-docs-drift
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The GitBook published tree (see SUMMARY.md). NOT docs/ — that holds RFCs and
// engineering notes that legitimately discuss roadmap (4337/x402/etc).
const GITBOOK_DIRS = [
  "introduction",
  "build",
  "concepts",
  "protocol",
  "architecture",
  "api-reference",
  "mcp-server",
  "smart-contracts",
  "resources",
  "legal",
];

// Wrong-about-the-current-code — never allowed.
const HARD = [
  [/\bvalidateUserOp\b/, "ERC-4337 validateUserOp — the account is session-key (executeViaSessionKey)"],
  [/\bUserOperation\b/, "ERC-4337 UserOperation — not the deployed model"],
  [/\bEntryPoint\b/, "ERC-4337 EntryPoint — not used"],
  [/\b_verifyScope\b/, "non-existent contract function"],
  [/\b16-step\b|\b16-check\b|\b16 checks\b/, "gate is 13 numbered checks + 4 hardening additions (17)"],
  [
    // Only the *anchor cadence* claim, not any "10 minutes" (e.g. a session-key
    // validity window). Require an anchoring keyword on the same line.
    /(?:anchor|merkle|root)[^\n]*(?:every 10 minutes|10[- ]minute)|(?:every 10 minutes|10[- ]minute)[^\n]*(?:anchor|merkle|root)/i,
    "audit anchor cadence is hourly, not every 10 minutes",
  ],
  [/\btrace_id\b/, "error envelope uses request_id, not trace_id"],
  [/\bpolicy\.denied\b/, "error codes are snake_case (policy_denied), not dotted"],
];

// Forward-looking names — allowed ONLY on a line that marks them as not-yet-shipped.
const MARKED = [
  [/\bERC-4337\b/, "ERC-4337"],
  [/\bEIP-7702\b/, "EIP-7702"],
  [/\bERC-8004\b/, "ERC-8004"],
  [/transparent proxy/i, "transparent proxy"],
  [/\btimelock\b/, "timelock"],
  [/\bupgrade(?:able|able)\b|\bupgradable\b/i, "upgradeable contracts"],
  [/\bagent:propose\b/, "agent:propose (the real scope is execution:propose)"],
];

const ALLOW_MARKER = /planned|roadmap|RFC 0001|conceptual|alias|not in MVP|not yet|future/i;

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".md")) out.push(full);
  }
  return out;
}

/** Returns a list of "file:line: reason" violation strings (empty when clean). */
export function findViolations(dirs = GITBOOK_DIRS) {
  const violations = [];
  for (const dir of dirs) {
    for (const file of walk(dir)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          for (const [re, reason] of HARD) {
            if (re.test(line)) violations.push(`${file}:${i + 1}: ${reason}`);
          }
          for (const [re, name] of MARKED) {
            if (re.test(line) && !ALLOW_MARKER.test(line)) {
              violations.push(
                `${file}:${i + 1}: "${name}" stated as current — mark it planned/roadmap or correct it`,
              );
            }
          }
        });
    }
  }
  return violations;
}

function main() {
  const violations = findViolations();
  if (violations.length > 0) {
    console.error("Docs-drift guard failed — published docs must match the code:");
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }
  console.log("docs-drift guard: OK");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
