import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const SCRIPT = join(process.cwd(), "scripts/check-required-compose-secrets.sh");

function withFiles({ compose, env }, fn) {
  const root = mkdtempSync(join(tmpdir(), "brain-required-secrets-"));
  try {
    const composePath = join(root, "docker-compose.yml");
    const envPath = join(root, ".env.prod");
    writeFileSync(composePath, compose);
    writeFileSync(envPath, env);
    return fn(composePath, envPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function run(composePath, envPath) {
  return execFileSync("bash", [SCRIPT, "--compose", composePath, "--env", envPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("reports each absent compose-required secret without printing values", () => {
  withFiles(
    {
      compose: `
        # ${"${COMMENT_ONLY:?not a real requirement}"}
        services:
          api:
            environment:
              AUTH_COOKIE_SECRET: ${"${AUTH_COOKIE_SECRET:?required}"}
              BRAIN_MCP_READER_DB_PASSWORD: ${"${BRAIN_MCP_READER_DB_PASSWORD:?required}"}
      `,
      env: "AUTH_COOKIE_SECRET=\nCORS_ALLOWED_ORIGINS=https://app.brain.fi\n",
    },
    (composePath, envPath) => {
      assert.throws(
        () => run(composePath, envPath),
        (error) => {
          assert.match(error.stderr, /missing secret: AUTH_COOKIE_SECRET/);
          assert.match(error.stderr, /missing secret: BRAIN_MCP_READER_DB_PASSWORD/);
          assert.doesNotMatch(error.stderr, /COMMENT_ONLY/);
          return true;
        },
      );
    },
  );
});

test("passes once all compose-required secrets are populated", () => {
  withFiles(
    {
      compose: `
        services:
          api:
            environment:
              AUTH_COOKIE_SECRET: ${"${AUTH_COOKIE_SECRET:?required}"}
              BRAIN_MCP_READER_DB_PASSWORD: ${"${BRAIN_MCP_READER_DB_PASSWORD:?required}"}
      `,
      env: "AUTH_COOKIE_SECRET=present-cookie-secret\nBRAIN_MCP_READER_DB_PASSWORD=reader-password\nCORS_ALLOWED_ORIGINS=https://app.brain.fi\n",
    },
    (composePath, envPath) => {
      assert.match(run(composePath, envPath), /required compose and boot-fence secrets present: 2/);
    },
  );
});

test("requires BRAIN_AGENT_RELAYER_PRIVATE_KEY only when BRAIN_AGENT_RELAYER_MODE=custodial", () => {
  withFiles(
    {
      compose: "services: {}\n",
      env: "BRAIN_AGENT_RELAYER_MODE=custodial\n",
    },
    (composePath, envPath) => {
      assert.throws(
        () => run(composePath, envPath),
        (error) => {
          assert.match(error.stderr, /missing secret: BRAIN_AGENT_RELAYER_PRIVATE_KEY/);
          return true;
        },
      );
    },
  );
});

test("requires BRAIN_AGENT_RELAYER_PRIVATE_KEY only when BRAIN_AGENT_RELAYER_MODE=tenant_signed", () => {
  withFiles(
    {
      compose: "services: {}\n",
      env: "BRAIN_AGENT_RELAYER_MODE=tenant_signed\n",
    },
    (composePath, envPath) => {
      assert.throws(
        () => run(composePath, envPath),
        (error) => {
          assert.match(error.stderr, /missing secret: BRAIN_AGENT_RELAYER_PRIVATE_KEY/);
          return true;
        },
      );
    },
  );
});

test("enforces enabled application boot fences without affecting disabled integrations", () => {
  withFiles(
    {
      compose: "services: {}\n",
      env: "BRAIN_API_KEY_AUTH_ENABLED=true\nEMAIL_ENABLED=false\nCORS_ALLOWED_ORIGINS=https://app.brain.fi\n",
    },
    (composePath, envPath) => {
      assert.throws(
        () => run(composePath, envPath),
        (error) => {
          assert.match(error.stderr, /missing secret: BRAIN_API_KEY_PEPPER/);
          assert.doesNotMatch(error.stderr, /EMAIL_TOKEN_SECRET/);
          return true;
        },
      );
    },
  );
});

test("requires every agent-key exchange binding only when exchange is enabled", () => {
  withFiles(
    {
      compose: "services: {}\n",
      env: "BRAIN_AGENT_KEY_EXCHANGE_ENABLED=true\nCORS_ALLOWED_ORIGINS=https://app.brain.fi\n",
    },
    (composePath, envPath) => {
      assert.throws(
        () => run(composePath, envPath),
        (error) => {
          assert.match(error.stderr, /missing secret: BRAIN_AGENT_API_KEY_PEPPER/);
          assert.match(error.stderr, /missing secret: BRAIN_AGENT_KEY_ENVIRONMENT/);
          assert.match(error.stderr, /missing secret: BRAIN_PLATFORM_SERVICE_SECRET/);
          return true;
        },
      );
    },
  );
});

test("requires only the credential selected for the agents auth environment", () => {
  const compose = "services:\n  agents:\n    env_file: [.env.agents-auth.prod]\n";
  withFiles(
    {
      compose,
      env: "BRAIN_AGENTS_AUTH_MODE=agent_api_key\nCORS_ALLOWED_ORIGINS=https://app.brain.fi\n",
    },
    (composePath, envPath) => {
      assert.throws(
        () => run(composePath, envPath),
        (error) => {
          assert.match(error.stderr, /missing secret: BRAIN_AUTH_TOKEN_URL/);
          assert.match(error.stderr, /missing secret: BRAIN_API_RESOURCE_URL/);
          assert.doesNotMatch(error.stderr, /BRAIN_API_TOKEN/);
          return true;
        },
      );
    },
  );
  withFiles(
    {
      compose,
      env: [
        "BRAIN_AGENTS_AUTH_MODE=agent_api_key",
        "BRAIN_AGENT_API_KEY=brain_ak_live_example",
        "BRAIN_AUTH_TOKEN_URL=http://auth:3000/token",
        "BRAIN_API_RESOURCE_URL=https://api.brain.fi/",
        "CORS_ALLOWED_ORIGINS=https://app.brain.fi",
        "",
      ].join("\n"),
    },
    (composePath, envPath) => {
      assert.match(run(composePath, envPath), /required compose and boot-fence secrets present: 2/);
    },
  );
});

test("requires the canonical action handoff secret when an approval surface is enabled", () => {
  withFiles(
    {
      compose: "services: {}\n",
      env: "SLACK_ENABLED=true\nSLACK_SIGNING_SECRET=slack-secret\nCORS_ALLOWED_ORIGINS=https://app.brain.fi\n",
    },
    (composePath, envPath) => {
      assert.throws(
        () => run(composePath, envPath),
        (error) => {
          assert.match(error.stderr, /missing secret: BRAIN_SURFACE_ACTION_SECRET/);
          return true;
        },
      );
    },
  );
});

test("requires app.brain.fi in the target CORS allowlist during the transition", () => {
  withFiles(
    {
      compose: "services: {}\n",
      env: "CORS_ALLOWED_ORIGINS=https://mvp.brain.fi,https://app.brain.fi,https://console.brain.fi\n",
    },
    (composePath, envPath) => {
      assert.match(
        run(composePath, envPath),
        /required CORS transition origin present: https:\/\/app\.brain\.fi/,
      );
    },
  );
});

test("fails before a deploy when the transition CORS origin is absent", () => {
  withFiles(
    {
      compose: "services: {}\n",
      env: "CORS_ALLOWED_ORIGINS=https://mvp.brain.fi,https://console.brain.fi\n",
    },
    (composePath, envPath) => {
      assert.throws(
        () => run(composePath, envPath),
        (error) => {
          assert.match(
            error.stderr,
            /missing required CORS origin: https:\/\/app\.brain\.fi in CORS_ALLOWED_ORIGINS/,
          );
          return true;
        },
      );
    },
  );
});
