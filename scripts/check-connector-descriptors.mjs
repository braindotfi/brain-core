#!/usr/bin/env node
/**
 * Connector-descriptor guard (ingestion architecture Phase 1).
 *
 * CI fails on any unregistered, undescribed, or dormant connector:
 *   1. every adapter registered in services/raw/src/adapters/registry.ts has
 *      a ConnectorDescriptor in descriptors.ts (and vice versa);
 *   2. every parser id a descriptor declares in `parserVersions` is actually
 *      registered in the Ledger parser registry
 *      (services/ledger/src/extractors/registry.ts) — a descriptor must not
 *      advertise interpretation that does not exist;
 *   3. every parser registered in the Ledger registry is claimed by at least
 *      one descriptor — a parser nothing feeds is dormant;
 *   4. every CONCRETE source type (services/raw/src/sources/types.ts) has a
 *      test file exercising its adapter (fixtures/conformance), so a concrete
 *      connector cannot ship untested.
 *
 * Static text checks only (no TS build needed); the semantic capability-vs-
 * implementation assertions live in services/raw/src/adapters/descriptors.test.ts.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT =
  process.env.BRAIN_DESCRIPTOR_GUARD_ROOT ?? fileURLToPath(new URL("..", import.meta.url));

function adapterSourceTypes(adaptersDir, registryFile) {
  // sourceType: "x" declarations across adapter modules that the registry
  // actually imports. Registry is the source of truth for "registered".
  const registry = readFileSync(registryFile, "utf8");
  const adapterNames = [...registry.matchAll(/^\s{2}(\w+Adapter),$/gm)].map((m) => m[1]);
  const types = new Set();
  for (const file of readdirSync(adaptersDir)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file.endsWith(".d.ts")) continue;
    const text = readFileSync(join(adaptersDir, file), "utf8");
    for (const m of text.matchAll(
      /export const (\w+Adapter): SourceAdapter = \{\s*\n\s*sourceType: "([a-z_]+)"/g,
    )) {
      if (adapterNames.includes(m[1])) types.add(m[2]);
    }
  }
  return types;
}

function descriptorEntries(descriptorsFile) {
  const text = readFileSync(descriptorsFile, "utf8");
  const types = [...text.matchAll(/connectorType: "([a-z_]+)"/g)].map((m) => m[1]);
  const parserVersions = new Set();
  for (const m of text.matchAll(/parserVersions: \[([^\]]*)\]/g)) {
    for (const p of m[1].matchAll(/"([^"]+)"/g)) parserVersions.add(p[1]);
  }
  return { types: new Set(types), parserVersions };
}

function registeredLedgerParsers(ledgerRegistryFile) {
  const text = readFileSync(ledgerRegistryFile, "utf8");
  return new Set([...text.matchAll(/registerParser\(\s*"([^"]+)"/g)].map((m) => m[1]));
}

function concreteSourceTypes(sourcesTypesFile) {
  const text = readFileSync(sourcesTypesFile, "utf8");
  const m = text.match(/CONCRETE_SOURCE_TYPES[^=]*=\s*new Set\(\[([^\]]*)\]\)/s);
  if (m === null) return new Set();
  return new Set([...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]));
}

export function findViolations(root = DEFAULT_ROOT) {
  const adaptersDir = join(root, "services/raw/src/adapters");
  const violations = [];
  const adapters = adapterSourceTypes(adaptersDir, join(adaptersDir, "registry.ts"));
  const { types: described, parserVersions } = descriptorEntries(
    join(adaptersDir, "descriptors.ts"),
  );
  const ledgerParsers = registeredLedgerParsers(
    join(root, "services/ledger/src/extractors/registry.ts"),
  );

  for (const t of adapters) {
    if (!described.has(t)) {
      violations.push(`adapter '${t}' is registered but has no ConnectorDescriptor (undescribed)`);
    }
  }
  for (const t of described) {
    if (!adapters.has(t)) {
      violations.push(`descriptor '${t}' has no registered adapter (unregistered)`);
    }
  }

  for (const p of parserVersions) {
    if (!ledgerParsers.has(p)) {
      violations.push(
        `descriptor declares parser '${p}' which is not registered in the Ledger parser registry`,
      );
    }
  }
  for (const p of ledgerParsers) {
    if (!parserVersions.has(p)) {
      violations.push(
        `Ledger parser '${p}' is registered but no connector descriptor claims it (dormant parser)`,
      );
    }
  }

  const adapterTestText = readdirSync(adaptersDir)
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => readFileSync(join(adaptersDir, f), "utf8"))
    .join("\n");
  const webhookTestFile = join(root, "services/raw/src/routes/webhook.test.ts");
  const webhookTestText = existsSync(webhookTestFile) ? readFileSync(webhookTestFile, "utf8") : "";
  for (const t of concreteSourceTypes(join(root, "services/raw/src/sources/types.ts"))) {
    // Pascal-case adapter export, e.g. stripe -> StripeAdapter. NetSuite-style
    // names are normalized by the lowercase source-type convention.
    const adapterName = `${t
      .split("_")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join("")}Adapter`;
    const tested =
      adapterTestText.includes(`"${t}"`) ||
      adapterTestText.includes(adapterName) ||
      webhookTestText.includes(t);
    if (!tested) {
      violations.push(`concrete connector '${t}' has no adapter test/fixtures (dormant)`);
    }
  }

  return violations;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) {
  const violations = findViolations();
  if (violations.length > 0) {
    for (const v of violations) console.error(`connector-descriptor guard: ${v}`);
    console.error(
      `\n${violations.length} violation(s). Every registered connector needs a ConnectorDescriptor ` +
        "(services/raw/src/adapters/descriptors.ts), every declared parser must be registered in " +
        "services/ledger/src/extractors/registry.ts, and concrete connectors need tests.",
    );
    process.exit(1);
  }
  console.log("connector-descriptor guard: OK");
}
