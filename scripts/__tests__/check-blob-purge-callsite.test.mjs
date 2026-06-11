// Tests for scripts/check-blob-purge-callsite.mjs. Stages a throwaway repo via
// BRAIN_PURGE_GUARD_ROOT and asserts the guard flags stray purgeTenant() calls
// while allowing the worker, the adapter definitions, the interface, and tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const GUARD = join(process.cwd(), "scripts/check-blob-purge-callsite.mjs");
const WORKER = "services/api/src/tenant-deletion/blob-purge-worker.ts";

/** Stage { relpath: contents } under a temp root and run the guard there. */
function run(files) {
  const root = mkdtempSync(join(tmpdir(), "purge-guard-"));
  try {
    for (const [rel, contents] of Object.entries(files)) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, contents);
    }
    try {
      const stdout = execFileSync("node", [GUARD], {
        env: { ...process.env, BRAIN_PURGE_GUARD_ROOT: root },
        encoding: "utf8",
      });
      return { code: 0, stdout, stderr: "" };
    } catch (err) {
      return {
        code: err.status ?? 1,
        stdout: err.stdout?.toString() ?? "",
        stderr: err.stderr?.toString() ?? "",
      };
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("passes when only the worker invokes purgeTenant", () => {
  const r = run({
    [WORKER]: "const result = await deps.blob.purgeTenant(job.tenant_id);\n",
    "shared/src/blob/s3.ts": "  public async purgeTenant(tenantId) { return; }\n",
    "shared/src/blob/types.ts": "  purgeTenant(tenantId: string): Promise<BlobPurgeResult>;\n",
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /OK/);
});

test("fails on a stray purgeTenant() call outside the worker", () => {
  const r = run({
    [WORKER]: "await deps.blob.purgeTenant(job.tenant_id);\n",
    "services/api/src/tenant-deletion/service.ts": "await this.blob.purgeTenant(targetTenantId);\n",
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /purgeTenant\(\) called outside the purge worker/);
  assert.match(r.stderr, /service\.ts:1/);
});

test("does NOT flag adapter definitions or the interface declaration", () => {
  const r = run({
    "shared/src/blob/memory.ts":
      "  public async purgeTenant(tenantId) { return { deleted: 0, failed: [] }; }\n",
    "shared/src/blob/azure.ts": "  async purgeTenant(tenantId) {}\n",
    "shared/src/blob/types.ts": "  purgeTenant(tenantId: string): Promise<BlobPurgeResult>;\n",
  });
  assert.equal(r.code, 0, r.stderr);
});

test("does NOT flag test files that invoke purgeTenant", () => {
  const r = run({
    "shared/src/blob/blob.test.ts": "expect(await a.purgeTenant('tnt_a')).toBeDefined();\n",
    "services/api/src/x.test.ts": "await blob.purgeTenant('tnt_b');\n",
  });
  assert.equal(r.code, 0, r.stderr);
});
