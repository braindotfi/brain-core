/**
 * Copy the two GET /v1/docs assets into this package so they ship in the dist
 * artifact (and Docker image), where neither the repo root nor devDependencies
 * are available. Both copies are generated, gitignored build output consumed by
 * src/docs/spec.ts at runtime.
 *
 *  1. The OpenAPI contract. The root `Brain_API_Specification.yaml` stays the
 *     single source of truth.
 *  2. The Scalar standalone renderer bundle, taken from `@scalar/api-reference`,
 *     which is the package that actually publishes it.
 *
 * Snapshotting the bundle here is the point, not an optimisation. Reading it out
 * of node_modules at runtime is what made the docs route hostage to an upstream
 * packaging decision: `@scalar/fastify-api-reference` stopped shipping
 * `dist/js/standalone.js` in 1.62.9 (it inlines the renderer into its own
 * index.js instead), and because spec.ts loads the bundle at route registration
 * "so a missing bundle fails fast at boot", that turned into an API boot failure
 * rather than a degraded docs page. Copying at build time means a future
 * repackaging is a build error in CI, not a production crash-loop.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const destDir = resolve(pkgRoot, "assets");
mkdirSync(destDir, { recursive: true });

// --- 1. OpenAPI spec ---
const specSource = resolve(pkgRoot, "../../Brain_API_Specification.yaml");
const specDest = resolve(destDir, "openapi.yaml");
copyFileSync(specSource, specDest);
console.warn(`[copy-docs-assets] ${specSource} -> ${specDest}`);

// --- 2. Scalar standalone bundle ---
// Resolved from the package entry rather than by a hardcoded node_modules path,
// so pnpm's symlinked store layout resolves correctly. The exports map does not
// expose ./dist/browser/standalone.js, but this never imports it: it resolves
// the (exported) entry, then reads a sibling file straight off disk.
const require = createRequire(import.meta.url);
const bundleSource = resolve(
  dirname(require.resolve("@scalar/api-reference")),
  "browser/standalone.js",
);
const bundleDest = resolve(destDir, "scalar-standalone.js");
copyFileSync(bundleSource, bundleDest);
console.warn(`[copy-docs-assets] ${bundleSource} -> ${bundleDest}`);
