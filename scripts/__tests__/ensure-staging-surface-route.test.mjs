import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const SCRIPT = join(process.cwd(), "scripts/ops/ensure-staging-surface-route.py");

function run(source) {
  const directory = mkdtempSync(join(tmpdir(), "brain-staging-surface-route-"));
  const input = join(directory, "Caddyfile");
  const output = join(directory, "Caddyfile.updated");
  writeFileSync(input, source);
  execFileSync("python3", [SCRIPT, "--input", input, "--output", output]);
  return readFileSync(output, "utf8");
}

test("adds the surface matcher before the staging API catch-all", () => {
  const rendered = run(`staging-api.brain.fi {
  redir / /v1/docs 302
  reverse_proxy api:3000
}
`);

  assert.match(rendered, /@brain_surfaces path \/surfaces\/\*/);
  assert.match(rendered, /reverse_proxy @brain_surfaces surface-gateway:3000/);
  assert.ok(
    rendered.indexOf("reverse_proxy @brain_surfaces surface-gateway:3000") <
      rendered.indexOf("reverse_proxy api:3000"),
  );
});

test("is idempotent and preserves unrelated staging directives", () => {
  const source = `staging-api.brain.fi {
  import edge_security_headers
  reverse_proxy api:3000
}
`;
  const once = run(source);
  const twice = run(once);

  assert.equal(twice, once);
  assert.match(twice, /import edge_security_headers/);
  assert.equal((twice.match(/BEGIN brain staging surface route/g) ?? []).length, 1);
});

test("fails closed on an unmanaged surfaces route", () => {
  const directory = mkdtempSync(join(tmpdir(), "brain-staging-surface-collision-"));
  const input = join(directory, "Caddyfile");
  const output = join(directory, "Caddyfile.updated");
  writeFileSync(
    input,
    `staging-api.brain.fi {
  handle /surfaces/* {
    reverse_proxy another-service:3000
  }
  reverse_proxy api:3000
}
`,
  );
  const result = spawnSync("python3", [SCRIPT, "--input", input, "--output", output], {
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unmanaged staging surface route already exists/);
});

test("fails closed when the staging host block is absent", () => {
  const directory = mkdtempSync(join(tmpdir(), "brain-staging-surface-missing-"));
  const input = join(directory, "Caddyfile");
  const output = join(directory, "Caddyfile.updated");
  writeFileSync(input, "api.brain.fi {\n  reverse_proxy api:3000\n}\n");
  const result = spawnSync("python3", [SCRIPT, "--input", input, "--output", output], {
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected exactly one staging-api\.brain\.fi site block/);
});
