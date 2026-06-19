#!/usr/bin/env node
/**
 * Connector scaffold (ingestion architecture Phase 1).
 *
 * `pnpm run scaffold-connector <name>` makes a new source ingestible in one
 * command: it threads the provider-named type through every wiring point the
 * platform requires, so "add a source" is hours of parser work, not platform
 * work. Generated state passes lint, typecheck, tests, and the
 * connector-descriptor CI guard out of the box.
 *
 * Files created:
 *   services/raw/src/adapters/<name>.ts            stub adapter
 *   services/raw/src/adapters/<name>.test.ts       conformance-test skeleton
 *   services/ledger/src/extractors/<name>.ts       parser skeleton (<name>_v1)
 *   services/ledger/src/extractors/<name>.test.ts  parser registration test
 *   services/raw/migrations/NNNN_source_type_<name>.sql  CHECK-constraint widening
 *
 * Files edited (anchored insertions):
 *   services/raw/src/sources/types.ts        SOURCE_TYPES + STUB_SOURCE_TYPES
 *   services/raw/src/sources/connectors.ts   connect-time REGISTRY entry
 *   services/raw/src/adapters/registry.ts    adapter import + registration
 *   services/raw/src/adapters/descriptors.ts ConnectorDescriptor entry
 *   services/ledger/src/extractors/registry.ts parser import + registration
 *   Brain_API_Specification.yaml             RawSourceType enum value
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_ARG = process.argv.find((a) => a.startsWith("--root="));
const ROOT = ROOT_ARG
  ? ROOT_ARG.slice("--root=".length)
  : fileURLToPath(new URL("..", import.meta.url));

const name = process.argv[2];

export function pascal(snake) {
  return snake
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

function insertOnce(file, anchor, insertion, label) {
  const path = join(ROOT, file);
  const text = readFileSync(path, "utf8");
  if (!text.includes(anchor)) {
    throw new Error(`scaffold-connector: anchor not found in ${file} (${label})`);
  }
  writeFileSync(path, text.replace(anchor, insertion));
}

/**
 * Insert a new entry before the CLOSING of a block matched by `blockRe`
 * (capture group 1 = everything up to but excluding the closing token).
 * Anchoring on block closings, not on whichever entry happens to be last,
 * keeps the scaffold stable as the catalog grows (the eth_address-anchored
 * v1 broke on the first scaffolded connector after it).
 */
function insertBeforeClose(file, blockRe, entry, label) {
  const path = join(ROOT, file);
  const text = readFileSync(path, "utf8");
  const m = blockRe.exec(text);
  if (m === null) {
    throw new Error(`scaffold-connector: block not found in ${file} (${label})`);
  }
  writeFileSync(path, text.replace(m[0], `${m[1]}${entry}${m[2]}`));
}

function currentArtifactTypes() {
  const text = readFileSync(join(ROOT, "services/raw/src/sources/types.ts"), "utf8");
  const sourceBlock = text.match(/SOURCE_TYPES = \[([^\]]*)\] as const/s);
  const types = [...sourceBlock[1].matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
  return [...types, "agent_contributed", "wiki_annotation", "other"];
}

function nextMigrationSequence() {
  const dir = join(ROOT, "services/raw/migrations");
  const seqs = readdirSync(dir)
    .map((f) => /^(\d{4,})_/.exec(f)?.[1])
    .filter(Boolean)
    .map(Number);
  return String(Math.max(...seqs) + 1).padStart(4, "0");
}

export function scaffold(connectorName) {
  if (!/^[a-z][a-z0-9_]*$/.test(connectorName)) {
    throw new Error("scaffold-connector: name must be snake_case (e.g. merge_accounting)");
  }
  const existing = currentArtifactTypes();
  if (existing.includes(connectorName)) {
    throw new Error(`scaffold-connector: source type '${connectorName}' already exists`);
  }
  const Pascal = pascal(connectorName);
  const parserId = `${connectorName}_v1`;

  // 1. Source-type vocabulary (connect-time + artifact CHECK share it).
  insertBeforeClose(
    "services/raw/src/sources/types.ts",
    /(export const SOURCE_TYPES = \[\n(?:[^\]]*\n)?)(\] as const;)/,
    `  "${connectorName}",\n`,
    "SOURCE_TYPES",
  );
  insertBeforeClose(
    "services/raw/src/sources/types.ts",
    /(export const STUB_SOURCE_TYPES: ReadonlySet<SourceType> = new Set\(\[\n(?:[^\]]*\n)?)(\]\);)/,
    `  "${connectorName}",\n`,
    "STUB_SOURCE_TYPES",
  );

  // 2. Connect-time connector registry (stub credentials until implemented).
  insertBeforeClose(
    "services/raw/src/sources/connectors.ts",
    /(const REGISTRY: Readonly<Record<SourceType, Connector>> = \{\n(?:[^}]*\n)?)(\};)/,
    `  ${connectorName}: stubConnector,\n`,
    "connector REGISTRY",
  );

  // 3. Adapter module.
  writeFileSync(
    join(ROOT, `services/raw/src/adapters/${connectorName}.ts`),
    `/**
 * ${Pascal} source adapter (scaffolded).
 *
 * TODO(connector): implement the modality methods this provider needs and
 * update the ConnectorDescriptor capability claims to match:
 *  - handleWebhook for signed provider push (add the verifier in
 *    shared/src/webhooks/${connectorName}.ts and the provider mapping in registry.ts)
 *  - fetchIncremental + syncObjectTypes for the authenticated pull path
 *    (per-object-type SyncPartition checkpoints, ingestion architecture §10)
 *
 * Until then the connector lands artifacts via the generic /raw/ingest push
 * at customer-push trust, which already works with zero further code.
 */

import type { SourceAdapter } from "./types.js";

export const ${Pascal}Adapter: SourceAdapter = {
  sourceType: "${connectorName}",
};
`,
  );

  // 4. Adapter registry: import + registration.
  insertOnce(
    "services/raw/src/adapters/registry.ts",
    `import { CONNECTOR_DESCRIPTORS, type ConnectorDescriptor } from "./descriptors.js";`,
    `import { CONNECTOR_DESCRIPTORS, type ConnectorDescriptor } from "./descriptors.js";\nimport { ${Pascal}Adapter } from "./${connectorName}.js";`,
    "registry import",
  );
  insertBeforeClose(
    "services/raw/src/adapters/registry.ts",
    /(const ADAPTERS: ReadonlyArray<SourceAdapter> = \[\n(?:[^\]]*\n)?)(\];)/,
    `  ${Pascal}Adapter,\n`,
    "ADAPTERS list",
  );

  // 5. Connector descriptor (capability claims all false until implemented —
  // the descriptor guard + vitest enforce claims match implementation).
  insertOnce(
    "services/raw/src/adapters/descriptors.ts",
    "\n];\n",
    `
  {
    connectorType: "${connectorName}",
    version: "0.1.0",
    category: "other", // TODO(connector): catalog grouping
    delivery: ["file"], // TODO(connector): declared modalities
    origin: "provider", // TODO(connector)
    trustTier: "first_party", // scaffolded connectors run in-process; partner-tier connectors are not scaffolded
    format: ["structured"],
    authentication: ["api_key"], // TODO(connector)
    capabilities: NO_CAPABILITIES, // claims must match implemented methods
    objectTypes: [], // TODO(connector): provider object types
    parserVersions: ["${parserId}"],
  },
];
`,
    "descriptor entry",
  );

  // 6. Ledger parser skeleton + registration.
  writeFileSync(
    join(ROOT, `services/ledger/src/extractors/${connectorName}.ts`),
    `/**
 * ${Pascal} extractor (scaffolded): interprets \`${parserId}\` raw_parsed rows.
 *
 * TODO(connector): map the payload to Ledger entities through the
 * provenance-validating writers in ../service/writes.ts. Keep provider-only
 * fields in namespaced extensions; set provenance per the trust contract
 * (structured provider data => "extracted"; documents => "agent_contributed";
 * generic push => "customer_asserted").
 */

import type { Pool } from "pg";
import type { AuditEmitter, ServiceCallContext } from "@brain/shared";
import type { ExtractedRow, ParserExtractInput } from "./registry.js";

export async function normalize${Pascal}Artifact(
  _pool: Pool,
  _audit: AuditEmitter,
  _ctx: ServiceCallContext,
  _input: ParserExtractInput,
): Promise<ExtractedRow[]> {
  // Skeleton: lands nothing until the mapping is implemented. Artifacts stay
  // retained in Raw and replay through this parser once it is real.
  return [];
}
`,
  );
  insertOnce(
    "services/ledger/src/extractors/registry.ts",
    `import { normalizeDocObligationArtifact } from "./doc-obligation.js";`,
    `import { normalizeDocObligationArtifact } from "./doc-obligation.js";\nimport { normalize${Pascal}Artifact } from "./${connectorName}.js";`,
    "ledger registry import",
  );
  const ledgerRegistryPath = join(ROOT, "services/ledger/src/extractors/registry.ts");
  writeFileSync(
    ledgerRegistryPath,
    readFileSync(ledgerRegistryPath, "utf8") +
      `
registerParser("${parserId}", async (pool, audit, ctx, input) =>
  normalize${Pascal}Artifact(pool, audit, ctx, input),
);
`,
  );

  // 7. Tests: adapter conformance skeleton + parser registration.
  writeFileSync(
    join(ROOT, `services/raw/src/adapters/${connectorName}.test.ts`),
    `import { describe, expect, it } from "vitest";
import {
  adapterForGenericIngest,
  adapterForSourceType,
  descriptorForSourceType,
} from "./registry.js";

// Scaffolded conformance skeleton. TODO(connector): add provider fixtures and
// assert backfill, deltas, idempotent dedup, signature rejection (webhooks),
// and the evidence/provenance defaults.
describe("${connectorName} connector", () => {
  it("registers the adapter under its provider-named source type", () => {
    expect(adapterForSourceType("${connectorName}").sourceType).toBe("${connectorName}");
  });

  it("is described by a ConnectorDescriptor with a registered parser", () => {
    const d = descriptorForSourceType("${connectorName}");
    expect(d.parserVersions).toContain("${parserId}");
  });

  it("is ingestible through the universal generic-push route", () => {
    expect(adapterForGenericIngest("${connectorName}").sourceType).toBe("${connectorName}");
  });
});
`,
  );
  writeFileSync(
    join(ROOT, `services/ledger/src/extractors/${connectorName}.test.ts`),
    `import { describe, expect, it } from "vitest";
import { extractorForParser, registeredParsers } from "./registry.js";

describe("${parserId} parser registration", () => {
  it("registers in the parser registry (the worker polls it automatically)", () => {
    expect(registeredParsers()).toContain("${parserId}");
    expect(extractorForParser("${parserId}")).toBeDefined();
  });
});
`,
  );

  // 8. Widen the DB CHECK constraints (raw_artifacts + raw_sources).
  const allTypes = [...currentArtifactTypes()];
  const seq = nextMigrationSequence();
  const quoted = allTypes.map((t) => `'${t}'`).join(",");
  const sourceTypes = allTypes
    .filter((t) => !["agent_contributed", "wiki_annotation", "other"].includes(t))
    .map((t) => `'${t}'`)
    .join(",");
  writeFileSync(
    join(ROOT, `services/raw/migrations/${seq}_source_type_${connectorName}.sql`),
    `-- Brain Raw -- admit the scaffolded '${connectorName}' connector type.
-- Generated by scripts/scaffold-connector.mjs; widens both CHECK
-- constraints to the current vocabulary. Idempotent via DROP IF EXISTS.

BEGIN;

ALTER TABLE raw_artifacts DROP CONSTRAINT IF EXISTS raw_artifacts_source_type_check;
ALTER TABLE raw_artifacts
  ADD CONSTRAINT raw_artifacts_source_type_check
  CHECK (source_type IN (${quoted}));

ALTER TABLE raw_sources DROP CONSTRAINT IF EXISTS raw_sources_type_check;
ALTER TABLE raw_sources
  ADD CONSTRAINT raw_sources_type_check
  CHECK (type IN (${sourceTypes}));

COMMIT;
`,
  );

  // 9. OpenAPI RawSourceType enum (spec-first; run lint:openapi after).
  const specPath = join(ROOT, "Brain_API_Specification.yaml");
  if (existsSync(specPath)) {
    const spec = readFileSync(specPath, "utf8");
    const anchor = "        - eth_address\n        - agent_contributed";
    if (spec.includes(anchor)) {
      writeFileSync(
        specPath,
        spec.replace(
          anchor,
          `        - eth_address\n        - ${connectorName}\n        - agent_contributed`,
        ),
      );
    }
  }

  return { parserId, Pascal, migration: `${seq}_source_type_${connectorName}.sql` };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) {
  if (name === undefined || name.startsWith("--")) {
    console.error("usage: pnpm run scaffold-connector <snake_case_name> [--root=PATH]");
    process.exit(1);
  }
  try {
    const out = scaffold(name);
    console.log(`scaffolded connector '${name}':`);
    console.log(`  parser id   ${out.parserId}`);
    console.log(`  migration   services/raw/migrations/${out.migration}`);
    console.log("next: pnpm run lint && pnpm run typecheck && pnpm run test");
    console.log("then: implement the adapter modality methods + the Ledger extractor mapping");
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
