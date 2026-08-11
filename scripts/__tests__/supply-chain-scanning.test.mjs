import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const prWorkflow = readFileSync(".github/workflows/pr.yml", "utf8");
const mainWorkflow = readFileSync(".github/workflows/main.yml", "utf8");
const codeqlWorkflow = readFileSync(".github/workflows/codeql.yml", "utf8");
const dependabot = readFileSync(".github/dependabot.yml", "utf8");
const trivyIgnore = readFileSync(".trivyignore", "utf8");
const agentsDockerfile = readFileSync("services/agents/Dockerfile", "utf8");
const agentsProject = readFileSync("services/agents/pyproject.toml", "utf8");

const pinnedAction = /@[0-9a-f]{40}(?:\s+# v[\d.]+)?/;

function workflowJob(name, source) {
  const start = source.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `missing workflow job ${name}`);
  const next = source.slice(start + 1).match(/\n  [a-zA-Z0-9_]+:\n/);
  const end = next ? start + 1 + next.index : source.length;
  return source.slice(start, end);
}

test("dependency audit fails on high and critical advisories in both CI gates", () => {
  for (const workflow of [prWorkflow, mainWorkflow]) {
    const job = workflowJob("dependency_audit", workflow);
    assert.match(job, /pnpm install --frozen-lockfile/);
    assert.match(job, /pnpm audit --audit-level=high/);
    assert.match(job, pinnedAction);
  }
  assert.match(
    workflowJob("dependency_audit", prWorkflow),
    /if: github\.event_name == 'pull_request'/,
  );
});

test("Terraform scans fail on high and critical findings in both CI gates", () => {
  for (const workflow of [prWorkflow, mainWorkflow]) {
    const job = workflowJob("iac", workflow);
    assert.match(job, /aquasecurity\/tfsec-action@[0-9a-f]{40}/);
    assert.match(job, /working_directory: infra/);
    assert.match(job, /--minimum-severity HIGH/);
  }
  assert.match(workflowJob("iac", prWorkflow), /if: github\.event_name == 'pull_request'/);
});

test("container scans use the production images and gate staging", () => {
  const prJob = workflowJob("container_scan", prWorkflow);
  const mainJob = workflowJob("container_scan", mainWorkflow);
  const stagingJob = workflowJob("deploy_staging", mainWorkflow);

  assert.match(prJob, /docker build .* -t brain-core:ci -f Dockerfile \./);
  assert.match(
    prJob,
    /docker build -t brain-agents:ci -f services\/agents\/Dockerfile services\/agents/,
  );
  assert.match(mainJob, /needs: build_image/);
  assert.match(mainJob, /image-ref: ghcr\.io\/braindotfi\/brain-core:\$\{\{ github\.sha \}\}/);
  assert.match(mainJob, /image-ref: ghcr\.io\/braindotfi\/brain-agents:\$\{\{ github\.sha \}\}/);
  assert.match(stagingJob, /needs: container_scan/);
  assert.match(prJob, /if: github\.event_name == 'pull_request'/);

  for (const job of [prJob, mainJob]) {
    assert.match(job, /aquasecurity\/trivy-action@[0-9a-f]{40}/);
    assert.match(job, /vuln-type: os,library/);
    assert.match(job, /severity: HIGH,CRITICAL/);
    assert.match(job, /exit-code: "1"/);
    assert.match(job, /trivyignores: \.trivyignore/);
  }
});

test("CodeQL and Dependabot cover the requested ecosystems", () => {
  assert.match(codeqlWorkflow, /language: \[javascript-typescript, python\]/);
  assert.match(codeqlWorkflow, /queries: security-extended/);
  assert.match(codeqlWorkflow, /github\/codeql-action\/init@[0-9a-f]{40}/);
  assert.match(codeqlWorkflow, /github\/codeql-action\/analyze@[0-9a-f]{40}/);
  assert.match(dependabot, /package-ecosystem: npm/);
  assert.match(dependabot, /package-ecosystem: github-actions/);
  assert.equal((dependabot.match(/interval: weekly/g) ?? []).length, 2);
});

test("every temporary Trivy exception has a reason and expiry", () => {
  const lines = trivyIgnore.trim().split("\n");
  const advisoryIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^(CVE|GHSA)-/.test(line));

  assert.ok(advisoryIndexes.length > 0);
  for (const { line, index } of advisoryIndexes) {
    const context = lines.slice(Math.max(0, index - 2), index).join("\n");
    assert.match(context, /# .+Reassess by \d{4}-\d{2}-\d{2}\./, `${line} needs a reason`);
    assert.match(context, /# exp:\d{4}-\d{2}-\d{2}/, `${line} needs an expiry`);
  }
});

test("agents image removes healthcheck-only curl and uses the patched PDF parser", () => {
  assert.doesNotMatch(agentsDockerfile, /apt-get install.*curl/s);
  assert.match(agentsDockerfile, /CMD python -c/);
  assert.match(agentsProject, /"pypdf>=6\.15\.0"/);
});
