/**
 * Boot-time loaders for the API docs surface (GET /v1/docs).
 *
 * Two assets are needed at runtime:
 *  1. The OpenAPI contract — `Brain_API_Specification.yaml` is the hand-maintained
 *     source of truth at the repo root. The package `build` copies it into
 *     `<pkg>/assets/openapi.yaml` (see package.json `copy-spec`) so it ships in
 *     the dist artifact; we resolve the copy first and fall back to the repo-root
 *     original for `tsx` dev runs that skip the copy.
 *  2. The Scalar standalone renderer — a single self-contained browser bundle,
 *     served same-origin. We do NOT register Scalar's Fastify plugin: it emits an
 *     inline `Scalar.createApiReference(...)` <script> that the gateway's strict
 *     `script-src 'self'` CSP would block. Our hand-rolled page (view.ts)
 *     auto-inits from a `data-url` attribute instead, so no inline script is
 *     needed and script-src stays strict.
 *
 *     The bundle comes from `@scalar/api-reference`, which is the package that
 *     publishes it (`dist/browser/standalone.js`, present in every version we
 *     checked). It used to be read out of `@scalar/fastify-api-reference` — a
 *     Fastify plugin this service never registers, depended on purely as a file
 *     source. That was the actual defect: when 1.62.9 stopped shipping
 *     `dist/js/standalone.js` and inlined the renderer into its own index.js,
 *     the bundle vanished from disk, and since loadScalarBundle runs at route
 *     registration the result was an API boot failure, not a degraded docs page.
 *     The build now snapshots the bundle into `assets/` (see
 *     scripts/copy-docs-assets.mjs), so upstream repackaging is a CI build error
 *     instead of a production crash-loop, and no Scalar package ships in the
 *     production image at all.
 *
 * Both reads are cached after first call — the spec and bundle never change at
 * runtime.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

let cachedSpec: string | undefined;
let cachedBundle: string | undefined;

/** Candidate paths for the OpenAPI YAML, in priority order. */
function specCandidates(): string[] {
  const candidates: string[] = [];
  const override = process.env.BRAIN_OPENAPI_SPEC_PATH;
  if (override !== undefined && override.length > 0) {
    candidates.push(override);
  }
  // Copied into the package at build time (works for both src/ and dist/ since
  // HERE is two levels below the package root in either layout).
  candidates.push(resolve(HERE, "../../assets/openapi.yaml"));
  // Dev fallback: the repo-root source of truth (HERE = <repo>/services/api/{src,dist}/docs).
  candidates.push(resolve(HERE, "../../../../Brain_API_Specification.yaml"));
  return candidates;
}

/** Load and cache the OpenAPI spec as raw YAML text. Throws if not found. */
export function loadOpenApiSpecText(): string {
  if (cachedSpec !== undefined) {
    return cachedSpec;
  }
  const candidates = specCandidates();
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedSpec = readFileSync(candidate, "utf8");
      return cachedSpec;
    }
  }
  throw new Error(`OpenAPI spec not found. Looked in: ${candidates.join(", ")}`);
}

/** Candidate paths for the Scalar standalone bundle, in priority order. */
function bundleCandidates(): string[] {
  const candidates: string[] = [];
  // Copied into the package at build time by scripts/copy-docs-assets.mjs. This
  // is the ONLY candidate that exists in the production image, which installs
  // --prod and therefore has no @scalar/* package at all. Same HERE-relative
  // shape as specCandidates above, so it resolves from src/ and dist/ alike.
  candidates.push(resolve(HERE, "../../assets/scalar-standalone.js"));
  // Dev/test fallback: read straight from the devDependency for `tsx` runs and
  // vitest, which skip the build step. Wrapped because require.resolve throws
  // when the package is absent (a --prod install), and there the copy above is
  // the real answer, so a throw here would be a false failure.
  try {
    const require = createRequire(import.meta.url);
    candidates.push(
      resolve(dirname(require.resolve("@scalar/api-reference")), "browser/standalone.js"),
    );
  } catch {
    // Not installed. The built asset above is the only candidate.
  }
  return candidates;
}

/** Load and cache the Scalar standalone renderer bundle. Throws if not found. */
export function loadScalarBundle(): string {
  if (cachedBundle !== undefined) {
    return cachedBundle;
  }
  const candidates = bundleCandidates();
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedBundle = readFileSync(candidate, "utf8");
      return cachedBundle;
    }
  }
  throw new Error(`Scalar bundle not found. Looked in: ${candidates.join(", ")}`);
}
