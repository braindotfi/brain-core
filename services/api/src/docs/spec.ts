/**
 * Boot-time loaders for the API docs surface (GET /v1/docs).
 *
 * Two assets are needed at runtime:
 *  1. The OpenAPI contract — `Brain_API_Specification.yaml` is the hand-maintained
 *     source of truth at the repo root. The package `build` copies it into
 *     `<pkg>/assets/openapi.yaml` (see package.json `copy-spec`) so it ships in
 *     the dist artifact; we resolve the copy first and fall back to the repo-root
 *     original for `tsx` dev runs that skip the copy.
 *  2. The Scalar standalone renderer — a single self-contained browser bundle
 *     shipped by `@scalar/fastify-api-reference` at `dist/js/standalone.js`. We
 *     reuse just that file (served same-origin) rather than registering the
 *     plugin: the plugin emits an inline `Scalar.createApiReference(...)` <script>
 *     that the gateway's strict `script-src 'self'` CSP would block. Our hand-
 *     rolled page (view.ts) auto-inits from a `data-url` attribute instead, so no
 *     inline script is needed and script-src stays strict.
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
  const require = createRequire(import.meta.url);
  // Resolve the plugin's entry (`<pkg>/dist/index.js`); the bundle is a sibling
  // under `js/`. Mirror the plugin's own getJavaScriptFile() candidate list so a
  // minor layout change does not break us silently.
  const entry = require.resolve("@scalar/fastify-api-reference");
  const distDir = dirname(entry);
  return [resolve(distDir, "js/standalone.js"), resolve(distDir, "../dist/js/standalone.js")];
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
