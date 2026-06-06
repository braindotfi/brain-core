#!/usr/bin/env node
/**
 * Blob purge call-site guard (RFC 0003).
 *
 * `BlobAdapter.purgeTenant()` is the ONLY path that hard-deletes a tenant's Raw
 * bytes — the GDPR Article-17 carveout to Layer-1 immutability. It must be
 * invoked ONLY from the durable purge worker
 * (services/api/src/tenant-deletion/blob-purge-worker.ts), which drains the
 * audited `tenant_blob_purge_jobs` queue with bounded retries + lifecycle audit
 * events. Any other caller would erase bytes outside that audited, retryable,
 * legal-hold-aware path — so this guard FAILS CI on a stray call site.
 *
 * It matches INVOCATIONS (`.purgeTenant(`), so the adapter method definitions
 * (memory/s3/azure: `async purgeTenant(`) and the interface declaration
 * (`purgeTenant(tenantId: ...)`) — which have no leading dot — are not flagged.
 * Tests are excluded.
 *
 * Run: pnpm run check-blob-purge-callsite
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.BRAIN_PURGE_GUARD_ROOT ?? process.cwd();
const SCAN_DIRS = ["services", "shared/src"];

// A method invocation: `something.purgeTenant(`. Definitions/declarations have
// no leading dot and are intentionally not matched.
const PURGE_CALL = /\.purgeTenant\s*\(/;
const ALLOWED = ["services/api/src/tenant-deletion/blob-purge-worker.ts"];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      out.push(...walk(full));
    } else if (full.endsWith(".ts") && !full.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

const violations = [];
for (const scan of SCAN_DIRS) {
  const abs = join(ROOT, scan);
  if (!existsSync(abs)) continue;
  for (const file of walk(abs)) {
    const rel = file.slice(ROOT.length + 1);
    if (ALLOWED.includes(rel)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (PURGE_CALL.test(line)) {
        violations.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    });
  }
}

if (violations.length > 0) {
  console.error("blob purge call-site guard: FAIL — purgeTenant() called outside the purge worker:");
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    "\nBlobAdapter.purgeTenant() hard-deletes a tenant's Raw bytes and must run ONLY from" +
      "\nservices/api/src/tenant-deletion/blob-purge-worker.ts (the audited, retryable purge" +
      "\nqueue path). Route new erasure through tenant_blob_purge_jobs instead of calling" +
      "\npurgeTenant directly. If you are intentionally adding a worker, update ALLOWED in" +
      "\nscripts/check-blob-purge-callsite.mjs with a comment explaining the invariant.",
  );
  process.exit(1);
}

console.log("blob purge call-site guard: OK");
