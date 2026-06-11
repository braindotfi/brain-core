#!/usr/bin/env node
/**
 * CI guard: rails catalog (`services/api/src/composition/rail-catalog.ts`) vs
 * `docs/rails-matrix.md`. Drift between them damages buyer trust because the
 * matrix is diligence-facing and the catalog is the runtime source of truth.
 *
 * Fails the build if:
 *   - a rail name appears in the catalog but not the doc (or vice versa)
 *   - production_allowed differs
 *   - audit_required differs
 *   - the set of required env vars differs
 *
 * This is a structural check on text, NOT a semantic one. It cannot catch
 * "the doc claims chain id 8453 but the catalog defaults Sepolia" (that's a
 * runtime concern). It catches the drift class the reviewers actually saw:
 * "the docs say erp_writeback isn't production-allowed; the catalog forgot
 * to flip the flag."
 *
 * Wired into `pnpm run lint`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const CATALOG_PATH = join(ROOT, "services/api/src/composition/rail-catalog.ts");
const DOC_PATH = join(ROOT, "docs/rails-matrix.md");

/**
 * Parse the static RAIL_CATALOG array out of the .ts source. We don't load
 * the module (would need a TS compiler pass); we regex-extract the literal.
 * The catalog is a tiny, stable structure so a targeted regex is fine here.
 */
function parseCatalog(src) {
  // Pull each RailDescriptor literal between the catalog brackets.
  const re =
    /\{\s*name:\s*"([^"]+)",[\s\S]*?productionAllowed:\s*(true|false),[\s\S]*?requiredEnv:\s*\[([^\]]*)\],[\s\S]*?evmChain:\s*(true|false),[\s\S]*?auditRequired:\s*(true|false)[\s\S]*?\}/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const envList = m[3]
      .split(",")
      .map((s) => s.trim().replace(/^"|"$/g, ""))
      .filter((s) => s.length > 0);
    out.push({
      name: m[1],
      productionAllowed: m[2] === "true",
      requiredEnv: envList.sort(),
      auditRequired: m[5] === "true",
    });
  }
  return out;
}

/**
 * Parse the per-rail tables out of docs/rails-matrix.md. Each rail has a
 * `### \`<name>\`` heading followed by an attribute table.
 */
function parseDoc(src) {
  const out = [];
  // Split into rail sections.
  const sections = src.split(/^### `([^`]+)`/m);
  // sections[0] is preamble; pairs after are [name, body, name, body, ...].
  for (let i = 1; i < sections.length; i += 2) {
    const name = sections[i];
    const body = sections[i + 1] ?? "";
    const prodLine = /\|\s*Production allowed\s*\|\s*([^|]+?)\s*\|/.exec(body)?.[1] ?? "";
    const auditLine = /\|\s*Audit required\s*\|\s*([^|]+?)\s*\|/.exec(body)?.[1] ?? "";
    const envLine = /\|\s*Required env\s*\|\s*([^|]+?)\s*\|/.exec(body)?.[1] ?? "";
    const requiredEnv =
      envLine.match(/`([A-Z_][A-Z0-9_]*)`/g)?.map((m) => m.replaceAll("`", "")) ?? [];
    out.push({
      name,
      // The doc uses prose like "yes" / "**no** (stub-only)" / "**yes**" — strip
      // markdown bold + parenthetical and compare the lowercase yes/no token.
      productionAllowed: /^\**\s*yes\b/i.test(prodLine.replace(/\*/g, "")),
      // erp_writeback says "n/a" for audit_required → treat as false.
      auditRequired: /^\**\s*yes\b/i.test(auditLine.replace(/\*/g, "")),
      requiredEnv: requiredEnv.sort(),
    });
  }
  return out;
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function main() {
  const catalogSrc = readFileSync(CATALOG_PATH, "utf8");
  const docSrc = readFileSync(DOC_PATH, "utf8");

  const catalog = parseCatalog(catalogSrc);
  const doc = parseDoc(docSrc);

  if (catalog.length === 0) {
    console.error(`fail: parsed 0 rails from ${CATALOG_PATH}; regex broken?`);
    process.exit(2);
  }
  if (doc.length === 0) {
    console.error(`fail: parsed 0 rails from ${DOC_PATH}; format changed?`);
    process.exit(2);
  }

  const errors = [];
  const catalogByName = new Map(catalog.map((r) => [r.name, r]));
  const docByName = new Map(doc.map((r) => [r.name, r]));

  // Both directions: presence drift.
  for (const r of catalog) {
    if (!docByName.has(r.name)) {
      errors.push(`rail ${r.name} is in RAIL_CATALOG but not in docs/rails-matrix.md`);
    }
  }
  for (const r of doc) {
    if (!catalogByName.has(r.name)) {
      errors.push(`rail ${r.name} is documented in docs/rails-matrix.md but not in RAIL_CATALOG`);
    }
  }

  // For each rail present in BOTH, check the comparable attributes.
  for (const r of catalog) {
    const d = docByName.get(r.name);
    if (d === undefined) continue;
    if (r.productionAllowed !== d.productionAllowed) {
      errors.push(
        `rail ${r.name}: catalog.productionAllowed=${r.productionAllowed} vs doc=${d.productionAllowed}`,
      );
    }
    if (r.auditRequired !== d.auditRequired) {
      errors.push(
        `rail ${r.name}: catalog.auditRequired=${r.auditRequired} vs doc=${d.auditRequired}`,
      );
    }
    if (!arraysEqual(r.requiredEnv, d.requiredEnv)) {
      errors.push(
        `rail ${r.name}: requiredEnv differs.\n  catalog: [${r.requiredEnv.join(", ")}]\n  doc:     [${d.requiredEnv.join(", ")}]`,
      );
    }
  }

  if (errors.length > 0) {
    console.error("rails-catalog-drift guard: FAIL");
    for (const e of errors) console.error("  " + e);
    console.error(
      "\nUpdate either RAIL_CATALOG in services/api/src/composition/rail-catalog.ts\n" +
        "or docs/rails-matrix.md so the two agree. They are the runtime source of\n" +
        "truth and the buyer-facing reference; drift between them is a trust bug.",
    );
    process.exit(1);
  }

  console.log(`rails-catalog-drift guard: OK (${catalog.length} rails in sync)`);
}

main();
