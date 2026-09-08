import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SCRIPT = join(process.cwd(), "scripts/ops/prepare-agents-auth-env.sh");

function render(source, credentials = "") {
  const root = mkdtempSync(join(tmpdir(), "brain-agents-auth-"));
  const sourcePath = join(root, ".env.prod");
  const outputPath = join(root, ".env.agents-auth.prod");
  const credentialPath = join(root, ".env.agent-key-document-extractor-v1");
  writeFileSync(sourcePath, source);
  writeFileSync(credentialPath, credentials);
  try {
    const stdout = execFileSync(
      "bash",
      [SCRIPT, "--env", sourcePath, "--credentials", credentialPath, "--output", outputPath],
      { encoding: "utf8" },
    );
    return { stdout, output: readFileSync(outputPath, "utf8"), mode: statSync(outputPath).mode };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("legacy mode renders only the JWT", () => {
  const result = render(
    "BRAIN_API_TOKEN=legacy-token\n",
    "BRAIN_AGENT_API_KEY=brain_ak_live_unused\n",
  );
  assert.equal(result.output, "BRAIN_API_TOKEN=legacy-token\n");
  assert.match(result.stdout, /agents_auth_mode=legacy_jwt/);
  assert.equal(result.mode & 0o077, 0);
});

test("agent key mode renders only exchange inputs", () => {
  const result = render(
    [
      "BRAIN_AGENTS_AUTH_MODE=agent_api_key",
      "BRAIN_API_TOKEN=rollback-token",
      "BRAIN_AUTH_TOKEN_URL=http://auth:3000/token",
      "BRAIN_API_RESOURCE_URL=https://api.brain.fi/",
      "",
    ].join("\n"),
    "BRAIN_AGENT_API_KEY=brain_ak_live_example\n",
  );
  assert.doesNotMatch(result.output, /BRAIN_API_TOKEN/);
  assert.match(result.output, /^BRAIN_AGENT_API_KEY=brain_ak_live_example$/m);
  assert.match(result.output, /^BRAIN_AUTH_TOKEN_URL=http:\/\/auth:3000\/token$/m);
  assert.match(result.output, /^BRAIN_API_RESOURCE_URL=https:\/\/api\.brain\.fi\/$/m);
  assert.equal(result.mode & 0o077, 0);
});

test("invalid and incomplete modes fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "brain-agents-auth-fail-"));
  try {
    const sourcePath = join(root, ".env.prod");
    const outputPath = join(root, ".env.agents-auth.prod");
    for (const source of [
      "BRAIN_AGENTS_AUTH_MODE=unknown\nBRAIN_API_TOKEN=token\n",
      "BRAIN_AGENTS_AUTH_MODE=agent_api_key\nBRAIN_AGENT_API_KEY=brain_ak_live_example\n",
      "BRAIN_AGENTS_AUTH_MODE=legacy_jwt\n",
    ]) {
      writeFileSync(sourcePath, source);
      const credentialPath = join(root, ".env.agent-key-document-extractor-v1");
      writeFileSync(credentialPath, "");
      assert.throws(() =>
        execFileSync(
          "bash",
          [SCRIPT, "--env", sourcePath, "--credentials", credentialPath, "--output", outputPath],
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          },
        ),
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
