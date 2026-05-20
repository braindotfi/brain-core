#!/usr/bin/env node
/**
 * Scope-vocabulary drift guard.
 *
 * Scans TypeScript source files for string literals that look like Brain
 * scopes (e.g. "raw:read") and asserts every one belongs to the canonical
 * VALID_SCOPES set defined in shared/src/auth/scopes.ts.
 *
 * Run: pnpm run check-scope-vocab
 * CI:  wired into the lint job in .github/workflows/main.yml
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const VALID_SCOPES = new Set([
  "raw:read", "raw:write", "raw:admin",
  "ledger:read", "ledger:write", "ledger:admin",
  "wiki:read", "wiki:write", "wiki:admin",
  "policy:read", "policy:write", "policy:admin", "policy:sign",
  "execution:read", "execution:write", "execution:admin", "execution:propose",
  "payment_intent:propose", "payment_intent:approve", "payment_intent:execute",
  "audit:read", "audit:write", "audit:admin",
]);

// Match {word}:{word} literals but skip Node built-in module specifiers (node:*)
// and any string where the part before : is "node" or starts with a digit.
const SCOPE_LITERAL_RE = /['"`](?!node:)([a-z][a-z_]*:[a-z]+)['"`]/g;

const SCAN_DIRS = ["services", "clients/sdk/src"];
const IGNORE_PATTERNS = [
  /node_modules/,
  /\.d\.ts$/,
  /viemScopeChecker\./,
  /scopes\.ts$/,
  /check-scope-vocab\./,
];

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walk(full));
    } else if (full.endsWith(".ts") || full.endsWith(".mjs")) {
      files.push(full);
    }
  }
  return files;
}

const root = fileURLToPath(new URL("..", import.meta.url));
let violations = 0;

for (const scanDir of SCAN_DIRS) {
  const abs = join(root, scanDir);
  let files;
  try {
    files = walk(abs);
  } catch {
    continue;
  }

  for (const file of files) {
    if (IGNORE_PATTERNS.some((p) => p.test(file))) continue;
    const content = readFileSync(file, "utf8");
    SCOPE_LITERAL_RE.lastIndex = 0;
    let match;
    while ((match = SCOPE_LITERAL_RE.exec(content)) !== null) {
      const candidate = match[1];
      if (!VALID_SCOPES.has(candidate)) {
        process.stderr.write(`${file}: unrecognized scope literal "${candidate}"\n`);
        violations++;
      }
    }
  }
}

if (violations > 0) {
  process.stderr.write(
    `\n${violations} unrecognized scope literal(s). ` +
      "Add to VALID_SCOPES in shared/src/auth/scopes.ts or remove the literal.\n",
  );
  process.exit(1);
}

process.stdout.write("Scope vocabulary: OK\n");
