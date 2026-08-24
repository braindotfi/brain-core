import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workflow = readFileSync(".github/workflows/deploy-azure-prod.yml", "utf8");
const terraform = readFileSync("infra/main.tf", "utf8");
const variables = readFileSync("infra/variables.tf", "utf8");
const runner = readFileSync("infra/run.sh", "utf8");
const infraReadme = readFileSync("infra/README.md", "utf8");
const agentsDockerfile = readFileSync("services/agents/Dockerfile", "utf8");
const agentsServer = readFileSync("services/agents/brain_agents/server.py", "utf8");
const runtimeValidation = readFileSync("services/api/src/ops/azure-deploy-validation.ts", "utf8");
const controlPlaneValidation = readFileSync("scripts/ops/validate-azure-container-apps.sh", "utf8");

test("Azure builds bake the full immutable commit into API and agents images", () => {
  const apiBuild = workflow.match(/az acr build[^\n]*brain-api[^\n]*\\\n[^\n]*/)?.[0] ?? "";
  const agentsBuild = workflow.match(/az acr build[^\n]*brain-agents[^\n]*\\\n[^\n]*/)?.[0] ?? "";
  assert.match(apiBuild, /--build-arg "GIT_SHA=\$SHA"/);
  assert.match(agentsBuild, /--build-arg "GIT_SHA=\$SHA"/);
  assert.match(agentsDockerfile, /ARG GIT_SHA=dev/);
  assert.match(agentsDockerfile, /ENV GIT_SHA=\$GIT_SHA/);
  assert.match(agentsServer, /"commit": os\.environ\.get\("GIT_SHA", "dev"\)/);
});

test("Terraform carries the full commit into the in-VNet validation job", () => {
  assert.match(variables, /variable "git_sha"/);
  assert.match(variables, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(runner, /TF_GIT_SHA is required/);
  assert.match(runner, /-var="git_sha=\$\{TF_GIT_SHA\}"/);
  assert.match(terraform, /resource "azurerm_container_app_job" "deploy_validation"/);
  assert.match(terraform, /services\/api\/dist\/ops\/azure-deploy-validation\.js/);
  assert.match(terraform, /BRAIN_VALIDATION_EXPECTED_GIT_SHA/);
  assert.match(terraform, /value = var\.git_sha/);
  const mainStackCommands =
    infraReadme.match(/Then the main stack:\n\n```bash\n([\s\S]*?)\n```/)?.[1] ?? "";
  const documentedCommands = mainStackCommands.match(
    /terraform (?:plan|apply)[\s\S]*?(?=\nterraform |$)/g,
  );
  assert.equal(documentedCommands?.length, 2);
  for (const command of documentedCommands ?? []) {
    assert.match(command, /-var="git_sha=<full-commit-sha>"/);
  }
});

test("deploy validation is in-VNet and covers every required dependency", () => {
  const validation = `${workflow}\n${runtimeValidation}\n${controlPlaneValidation}`;
  for (const gate of [
    "api",
    "auth",
    "worker",
    "agents",
    "mcp",
    "managed_redis",
    "key_vault_mounted",
    "key_vault_direct",
    "azure_blob",
    "postgres",
  ]) {
    assert.match(validation, new RegExp(gate));
  }
  assert.match(workflow, /brain-production-deploy-validation/);
  assert.match(workflow, /azure_deploy_validation/);
  assert.match(workflow, /scripts\/ops\/validate-azure-container-apps\.sh/);
  assert.match(
    workflow,
    /if: \$\{\{ always\(\) && inputs\.terraform_action == 'apply' && steps\.validation\.outputs\.execution != '' \}\}/,
  );
});

test("Blob canaries use a disposable container instead of immutable Raw storage", () => {
  assert.match(terraform, /resource "azurerm_storage_container" "deploy_validation"/);
  assert.match(terraform, /name\s+= "deploy-validation"/);
  const canaryResource = terraform.match(
    /resource "azurerm_storage_container" "deploy_validation"[\s\S]*?\n}/,
  )?.[0];
  assert.ok(canaryResource);
  assert.doesNotMatch(canaryResource, /immutability/);
});

test("control-plane validation parses Azure TSV readiness and succeeds on healthy fixtures", () => {
  const directory = mkdtempSync(join(tmpdir(), "brain-azure-validation-"));
  const az = join(directory, "az");
  writeFileSync(
    az,
    `#!/usr/bin/env bash
set -euo pipefail
args="$*"
if [[ "$args" == *"containerapp show"*"properties.latestRevisionName"* ]]; then
  app=""
  while [ "$#" -gt 0 ]; do if [ "$1" = "-n" ]; then app="$2"; break; fi; shift; done
  printf '%s--fixture\\n' "$app"
elif [[ "$args" == *"containerapp revision show"* ]]; then
  app=""
  while [ "$#" -gt 0 ]; do if [ "$1" = "-n" ]; then app="$2"; break; fi; shift; done
  repo=brain-api
  if [ "$app" = "brain-production-agents" ]; then repo=brain-agents; fi
  printf 'Provisioned\\tHealthy\\tbrainproductionacr.azurecr.io/%s:deadbeef\\n' "$repo"
elif [[ "$args" == *"containerapp replica list"* ]]; then
  printf '[{"properties":{"containers":[{"restartCount":0}]}}]\\n'
elif [[ "$args" == *"containerapp show"*"-o json"* ]]; then
  printf '{"properties":{"configuration":{"secrets":[{"keyVaultUrl":"https://vault/secrets/a","identity":"managed"}]}}}\\n'
elif [[ "$args" == *"monitor log-analytics query"* ]]; then
  printf '1\\n'
else
  printf 'unexpected az invocation: %s\\n' "$args" >&2
  exit 2
fi
`,
  );
  chmodSync(az, 0o755);
  try {
    const result = spawnSync("bash", ["scripts/ops/validate-azure-container-apps.sh"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        AZURE_RESOURCE_GROUP: "brain-production-rg",
        AZURE_ACR: "brainproductionacr",
        AZURE_IMAGE_TAG: "deadbeef",
        EXPECTED_GIT_SHA: "d".repeat(40),
        AZURE_LOG_ANALYTICS_WORKSPACE_ID: "fixture-workspace",
      },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /brain-production-worker: revision=.*replicas=1 restarts=0/);
    assert.match(result.stdout, /worker runtime boot evidence: present/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
