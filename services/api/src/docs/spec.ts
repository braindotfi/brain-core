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
 *     exposed by `@scalar/fastify-api-reference` through its JavaScript route. We
 *     reuse that bundle (served same-origin) rather than registering the
 *     plugin: the plugin emits an inline `Scalar.createApiReference(...)` <script>
 *     that the gateway's strict `script-src 'self'` CSP would block. Our hand-
 *     rolled page (view.ts) auto-inits from a `data-url` attribute instead, so no
 *     inline script is needed and script-src stays strict.
 *
 * Both reads are cached after first call — the spec and bundle never change at
 * runtime.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import scalarApiReference from "@scalar/fastify-api-reference";

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

interface ScalarRoute {
  url: string;
  handler?: (request: unknown, reply: ScalarReply) => unknown;
}

interface ScalarReply {
  header(name: string, value: string): ScalarReply;
  send(payload: unknown): unknown;
}

/**
 * Extract Scalar's renderer through the package's public Fastify route contract.
 *
 * Recent Scalar releases embed the bundle in their plugin entry instead of
 * publishing `dist/js/standalone.js`. Capturing the response from its documented
 * JavaScript route avoids coupling this loader to either package layout while our
 * own docs routes retain their strict, no-inline-script CSP behavior.
 */
function scalarBundleFromPlugin(): string {
  const routes: ScalarRoute[] = [];
  const routePrefix = "/__brain_scalar_bundle";
  const fakeApp = {
    route(route: ScalarRoute): void {
      routes.push(route);
    },
    hasPlugin(): boolean {
      return false;
    },
    initialConfig: { routerOptions: { ignoreTrailingSlash: true } },
    log: { warn(): void {} },
  };

  scalarApiReference(
    fakeApp as never,
    { routePrefix, configuration: { url: "/openapi.yaml" } },
    (error?: Error | null) => {
      if (error !== undefined && error !== null) {
        throw error;
      }
    },
  );

  const route = routes.find(({ url }) => url === `${routePrefix}/js/scalar.js`);
  if (route?.handler === undefined) {
    throw new Error("Scalar JavaScript route was not registered by @scalar/fastify-api-reference");
  }

  let bundle: unknown;
  const reply: ScalarReply = {
    header(): ScalarReply {
      return this;
    },
    send(payload: unknown): unknown {
      bundle = payload;
      return payload;
    },
  };
  route.handler({}, reply);
  if (typeof bundle !== "string" || bundle.length === 0) {
    throw new Error("Scalar JavaScript route did not return a renderer bundle");
  }
  return bundle;
}

/** Load and cache the Scalar standalone renderer bundle. Throws if not found. */
export function loadScalarBundle(): string {
  if (cachedBundle !== undefined) {
    return cachedBundle;
  }
  cachedBundle = scalarBundleFromPlugin();
  return cachedBundle;
}
