/**
 * Copy the repo-root OpenAPI spec into this package so it ships in the dist
 * artifact (and Docker image), where the repo root is not available. The root
 * `Brain_API_Specification.yaml` stays the single source of truth; the copy is a
 * generated, gitignored build output consumed by src/docs/spec.ts at runtime.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const source = resolve(pkgRoot, "../../Brain_API_Specification.yaml");
const destDir = resolve(pkgRoot, "assets");
const dest = resolve(destDir, "openapi.yaml");

mkdirSync(destDir, { recursive: true });
copyFileSync(source, dest);
console.warn(`[copy-openapi-spec] ${source} -> ${dest}`);
