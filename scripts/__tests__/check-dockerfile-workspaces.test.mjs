import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  findMissingCopyLines,
  parseWorkspacePackages,
  requiredCopyLines,
} from "../check-dockerfile-workspaces.mjs";

// Regression guard for the review finding: PR #164 added services/canonical to
// pnpm-workspace.yaml but never wired its COPY lines into the prod Dockerfile,
// so the prod image failed to build (TS2307: Cannot find module 'pg') even
// though local build/typecheck/CI were green -- none build the prod image the
// way docker compose does. Same class as the earlier audit-status COPY miss.

const ROOT = process.cwd();

// Resolve the real service workspaces the same way the guard does.
function realServices() {
  const yaml = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");
  return parseWorkspacePackages(yaml)
    .filter((p) => p.startsWith("services/") && p.split("/").length === 2)
    .filter((p) => existsSync(join(ROOT, p, "package.json")))
    .map((dir) => ({ dir, hasMigrations: existsSync(join(ROOT, dir, "migrations")) }));
}

test("every service workspace is wired into the prod Dockerfile", () => {
  const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
  const services = realServices();
  assert.ok(services.length > 0, "expected to resolve at least one service workspace");
  const missing = findMissingCopyLines(dockerfile, services);
  assert.deepEqual(missing, [], `prod Dockerfile is missing COPY lines:\n${missing.join("\n")}`);
});

test("the workspace parser excludes the Python services/agents", () => {
  const dirs = parseWorkspacePackages(readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8"));
  // services/agents is built by its own Dockerfile and is not a pnpm workspace.
  assert.ok(!dirs.includes("services/agents"), "services/agents must not be a pnpm workspace");
  assert.ok(dirs.includes("services/api"), "expected services/api among workspaces");
});

test("findMissingCopyLines flags a service with no COPY lines at all", () => {
  const missing = findMissingCopyLines("FROM node:22-slim\n", [
    { dir: "services/newthing", hasMigrations: false },
  ]);
  assert.equal(missing.length, 3, "manifest x2 + dist must all be reported missing");
});

test("a fully-wired service (no migrations) reports nothing", () => {
  const svc = "services/newthing";
  const dockerfile = requiredCopyLines(svc, false).join("\n");
  assert.deepEqual(findMissingCopyLines(dockerfile, [{ dir: svc, hasMigrations: false }]), []);
});

test("a migration-shipping service must also COPY its migrations", () => {
  const svc = "services/newthing";
  // Wire everything EXCEPT the migrations line, then require migrations.
  const dockerfile = requiredCopyLines(svc, false).join("\n");
  const missing = findMissingCopyLines(dockerfile, [{ dir: svc, hasMigrations: true }]);
  assert.equal(missing.length, 1);
  assert.match(missing[0], /migrations/);
});

test("matching is insensitive to whitespace reformatting", () => {
  const svc = "services/newthing";
  // Same COPY lines but with collapsed/expanded spacing.
  const reformatted = requiredCopyLines(svc, true)
    .map((l) => l.replace(/ /g, "   "))
    .join("\n");
  assert.deepEqual(findMissingCopyLines(reformatted, [{ dir: svc, hasMigrations: true }]), []);
});
