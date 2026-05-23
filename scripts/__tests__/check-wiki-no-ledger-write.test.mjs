import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findViolations } from "../check-wiki-no-ledger-write.mjs";

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "wiki-guard-"));
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

test("passes on a sanctioned read-only SELECT against a ledger_* table", () => {
  const dir = fixture({
    "page.ts": "const r = await c.query(`SELECT * FROM ledger_payment_intents WHERE id = $1`);",
  });
  assert.deepEqual(findViolations(dir), []);
  rmSync(dir, { recursive: true, force: true });
});

test("flags a Ledger write-helper import from @brain/ledger", () => {
  const dir = fixture({ "bad.ts": 'import { insertTransaction } from "@brain/ledger";' });
  const v = findViolations(dir);
  assert.equal(v.length, 1);
  assert.match(v[0], /insertTransaction/);
  rmSync(dir, { recursive: true, force: true });
});

test("flags a raw INSERT/UPDATE/DELETE against a ledger_* table", () => {
  const dir = fixture({ "bad.ts": "await c.query(`UPDATE ledger_accounts SET status = 'x'`);" });
  assert.ok(findViolations(dir).some((s) => /ledger_/.test(s)));
  rmSync(dir, { recursive: true, force: true });
});

test("does not write to wiki_* tables count as violations", () => {
  const dir = fixture({ "page.ts": "await c.query(`UPDATE wiki_pages SET body_md = $1`);" });
  assert.deepEqual(findViolations(dir), []);
  rmSync(dir, { recursive: true, force: true });
});

test("ignores .test.ts files", () => {
  const dir = fixture({ "x.test.ts": 'import { insertTransaction } from "@brain/ledger";' });
  assert.deepEqual(findViolations(dir), []);
  rmSync(dir, { recursive: true, force: true });
});
