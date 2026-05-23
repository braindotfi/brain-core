import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findViolations } from "../check-policy-no-wiki-read.mjs";

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "policy-guard-"));
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

test("passes on Policy code that reads only Ledger", () => {
  const dir = fixture({
    "vm.ts": "const r = await c.query(`SELECT * FROM ledger_accounts WHERE id = $1`);",
  });
  assert.deepEqual(findViolations(dir), []);
  rmSync(dir, { recursive: true, force: true });
});

test("flags an @brain/wiki import", () => {
  const dir = fixture({ "bad.ts": 'import { askWiki } from "@brain/wiki";' });
  const v = findViolations(dir);
  assert.equal(v.length, 1);
  assert.match(v[0], /@brain\/wiki/);
  rmSync(dir, { recursive: true, force: true });
});

test("flags raw SQL referencing a wiki_* table", () => {
  const dir = fixture({
    "bad.ts": "await c.query(`SELECT body_md FROM wiki_pages WHERE slug=$1`);",
  });
  assert.ok(findViolations(dir).some((s) => /wiki_/.test(s)));
  rmSync(dir, { recursive: true, force: true });
});

test("ignores .test.ts files", () => {
  const dir = fixture({ "x.test.ts": 'import { askWiki } from "@brain/wiki";' });
  assert.deepEqual(findViolations(dir), []);
  rmSync(dir, { recursive: true, force: true });
});
