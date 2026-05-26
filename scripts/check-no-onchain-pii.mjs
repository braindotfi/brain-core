#!/usr/bin/env node
/**
 * No-PII-on-chain guard (RFC 0001 §3).
 *
 * Brain's on-chain footprint is commitments only: hashes, Merkle roots, opaque
 * `bytes32` ids, addresses, and amounts. PII / customer / financial detail must
 * NEVER reach the chain — on-chain data is immutable and un-erasable (GDPR), and
 * the design is hash-only by construction.
 *
 * The structural tripwire: a Solidity `string` parameter (in a function, event,
 * error, or struct on the ABI surface) is the only ABI type that can smuggle
 * free-form text on-chain. Brain's contracts use `bytes32` / address / uint /
 * bytes — never `string`. This guard fails if a `string` type appears in any
 * contract, forcing a conscious review before any escrow/x402 primitive could
 * accept a raw field.
 *
 * It ignores `string` inside string literals (e.g. the standard EIP-712
 * `"EIP712Domain(string name,...)"` type hash) and comments.
 *
 * Run: pnpm run check-no-onchain-pii
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_SCAN_DIR = "contracts/src";

const STRING_TYPE = /\bstring\b/;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".sol")) out.push(full);
  }
  return out;
}

/** Strip line/block comments and double-quoted string literals from one line. */
function sanitize(line) {
  return line
    .replace(/"(?:[^"\\]|\\.)*"/g, '""') // empty out string literals
    .replace(/\/\/.*$/, "") // line comment
    .replace(/\/\*.*?\*\//g, "") // inline block comment
    .replace(/^\s*\*.*$/, ""); // block-comment continuation
}

/** Returns a list of "file:line: reason" violation strings (empty when clean). */
export function findViolations(scanDir) {
  const violations = [];
  for (const file of walk(scanDir)) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (STRING_TYPE.test(sanitize(line))) {
          violations.push(
            `${file}:${i + 1}: Solidity \`string\` type on the ABI surface — ` +
              `no free-form text on-chain (use bytes32/hash; see RFC 0001 §3)`,
          );
        }
      });
  }
  return violations;
}

function main() {
  const scanDir = process.argv[2] ?? DEFAULT_SCAN_DIR;
  const violations = findViolations(scanDir);
  if (violations.length > 0) {
    console.error("No-PII-on-chain guard failed — contracts must not carry free-form text:");
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }
  console.log("no-onchain-pii guard: OK");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
