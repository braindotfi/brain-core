#!/usr/bin/env node
/**
 * CI guard: every TS service workspace is wired into the prod Dockerfile.
 *
 * The prod image (Dockerfile -> docker-compose.prod.yml) is built by COPYing
 * each workspace's manifest, then its compiled dist, then its migrations,
 * across the builder and runtime stages. This wiring is hand-maintained and
 * has silently regressed twice: PR #131 shipped the api without its OpenAPI
 * spec, and PR #164 added services/canonical to pnpm-workspace.yaml without the
 * COPY lines, so the prod image failed to build (TS2307: Cannot find module
 * 'pg') even though local `pnpm run build`, typecheck, and CI were all green —
 * none of them build the prod image the way docker compose does.
 *
 * This guard closes that gap deterministically: for every service listed in
 * pnpm-workspace.yaml (which already excludes the Python services/agents, built
 * by its own Dockerfile), the prod Dockerfile MUST contain
 *   - builder manifest COPY:  COPY services/<svc>/package.json services/<svc>/tsconfig.json services/<svc>/
 *   - runtime manifest COPY:  COPY services/<svc>/package.json services/<svc>/
 *   - runtime dist COPY:      COPY --from=builder /app/services/<svc>/dist services/<svc>/dist
 *   - runtime migrations COPY (iff services/<svc>/migrations/ exists):
 *                             COPY --from=builder /app/services/<svc>/migrations services/<svc>/migrations
 *
 * Scope is intentionally services/* only — the dist/migrations COPY set for
 * tools/, tests/, and clients/ is selective by design (not every one ships a
 * runtime artifact), so asserting "all workspaces" would false-positive. Every
 * TS service, by contrast, is a runtime dependency of the api image, compiles
 * to dist, and follows the uniform pattern above. Whitespace between COPY
 * tokens is normalised before matching so reformatting does not trip the guard.
 *
 * Exit 0 + a summary line on success; exit 1 + the precise missing COPY lines
 * (ready to paste into the Dockerfile) on any violation.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();
const DOCKERFILE = join(ROOT, "Dockerfile");
const WORKSPACE = join(ROOT, "pnpm-workspace.yaml");
const REQUIRED_RUNTIME_PACKAGES = ["packages/core", "packages/surfaces"];

function fail(reasons) {
  console.error("dockerfile-workspaces guard: FAIL");
  for (const r of reasons) console.error(`  - ${r}`);
  console.error(
    "\nEvery runtime service and package must be COPYed into the prod\n" +
      "Dockerfile (builder manifest, runtime manifest, runtime dist, and\n" +
      "runtime migrations when the service ships a migrations/ dir). Add the\n" +
      "missing lines above next to the sibling services, then rebuild with\n" +
      "`docker compose --env-file .env.prod -f docker-compose.prod.yml build api`.",
  );
  process.exit(1);
}

// Extract the quoted package globs under `packages:` in pnpm-workspace.yaml.
// The file is a flat list of `  - "<glob>"` entries; we only need that block.
export function parseWorkspacePackages(yaml) {
  const globs = [];
  let inPackages = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      // A new top-level key (no leading space, ends with ':') ends the block.
      if (/^\S.*:\s*$/.test(line)) break;
      const m = line.match(/^\s*-\s*["']?([^"'#\s]+)["']?\s*$/);
      if (m) globs.push(m[1]);
    }
  }
  return globs;
}

// Resolve a workspace glob to concrete directories. Supports a single trailing
// `*` segment (e.g. "tools/*"); literal entries pass through unchanged.
function expandGlob(glob) {
  if (!glob.includes("*")) return [glob];
  const idx = glob.indexOf("*");
  // Only single-segment trailing wildcards appear in this workspace file.
  const parent = glob.slice(0, idx).replace(/\/$/, "");
  const parentAbs = join(ROOT, parent);
  if (!existsSync(parentAbs)) return [];
  return readdirSync(parentAbs, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `${parent}/${e.name}`);
}

// Collapse runs of whitespace so reformatting the Dockerfile does not break the
// substring match.
export function normaliseWhitespace(s) {
  return s.replace(/\s+/g, " ").trim();
}

// The COPY lines a single service must have in the prod Dockerfile. The
// migrations line is required only when the service ships a migrations/ dir.
export function requiredCopyLines(svc, hasMigrations) {
  const lines = [
    // builder stage manifest copy
    `COPY ${svc}/package.json ${svc}/tsconfig.json ${svc}/`,
    // runtime stage manifest copy
    `COPY ${svc}/package.json ${svc}/`,
    // runtime stage compiled output
    `COPY --from=builder /app/${svc}/dist ${svc}/dist`,
  ];
  if (hasMigrations) {
    lines.push(`COPY --from=builder /app/${svc}/migrations ${svc}/migrations`);
  }
  return lines;
}

// Pure core: given the Dockerfile text and the service set, return one reason
// per missing COPY line. Empty array == fully wired. Whitespace-insensitive.
export function findMissingCopyLines(dockerfileText, services) {
  const haystack = normaliseWhitespace(dockerfileText);
  const reasons = [];
  for (const { dir, hasMigrations } of services) {
    for (const line of requiredCopyLines(dir, hasMigrations)) {
      if (!haystack.includes(normaliseWhitespace(line))) {
        reasons.push(`${dir}: missing Dockerfile line -> ${line}`);
      }
    }
  }
  return reasons;
}

function main() {
  for (const f of [DOCKERFILE, WORKSPACE]) {
    if (!existsSync(f)) fail([`${f} is missing`]);
  }

  const dockerfile = normaliseWhitespace(readFileSync(DOCKERFILE, "utf8"));
  const packages = parseWorkspacePackages(readFileSync(WORKSPACE, "utf8"));

  const services = packages
    .flatMap(expandGlob)
    .filter((p) => p.startsWith("services/") && p.split("/").length === 2)
    .filter((p) => existsSync(join(ROOT, p, "package.json")))
    .sort();

  if (services.length === 0) {
    fail(["parsed zero service workspaces from pnpm-workspace.yaml (parser broken?)"]);
  }

  const serviceSet = [...services, ...REQUIRED_RUNTIME_PACKAGES].map((dir) => ({
    dir,
    hasMigrations: existsSync(join(ROOT, dir, "migrations")),
  }));

  const reasons = findMissingCopyLines(dockerfile, serviceSet);
  if (reasons.length > 0) fail(reasons);

  console.log(
    `dockerfile-workspaces guard: OK (${serviceSet.length} runtime workspaces wired into the prod Dockerfile)`,
  );
}

// CLI driver, guarded so the unit test can import the pure helpers without
// triggering the filesystem walk or process.exit.
const isCli = fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) main();
