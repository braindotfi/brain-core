import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Conductor setup selects and verifies the repository Node major", async () => {
  const [nvmrc, packageJson, settings] = await Promise.all([
    readFile(new URL("../../.nvmrc", import.meta.url), "utf8"),
    readFile(new URL("../../package.json", import.meta.url), "utf8"),
    readFile(new URL("../../.conductor/settings.toml", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(packageJson);

  assert.equal(nvmrc.trim(), "24");
  assert.equal(manifest.engines.node, "^24.0.0");
  assert.match(settings, /brew --prefix node@24/);
  assert.match(settings, /node_major/);
  assert.match(settings, /pnpm install --frozen-lockfile/);
});
