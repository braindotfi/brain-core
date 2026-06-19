#!/usr/bin/env node
/**
 * Partner-connector in-process isolation guard.
 *
 * A `partner`-tier ConnectorDescriptor (authored outside Brain's trust
 * boundary) must never run in-process. The runtime hosting of partner code in
 * an isolated operated runtime is deferred to the R-03 deploy substrate; the
 * substrate-independent invariant this enforces at lint time is the IN-PROCESS
 * EXCLUSION:
 *   1. no SourceAdapter is registered for a partner-tier connectorType;
 *   2. a partner descriptor declares no parserVersions (no Ledger parser);
 *   3. a partner descriptor declares no webhook delivery (an in-process,
 *      HMAC-verified handler that would mint authenticated provenance).
 *
 * This is the lint-time backstop for the runtime assertion in
 * services/raw/src/adapters/isolation.ts (asserted at api boot and in the
 * conformance suite). Static text checks only (no TS build needed), matching
 * check-connector-descriptors.mjs.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT =
  process.env.BRAIN_PARTNER_ISOLATION_GUARD_ROOT ?? fileURLToPath(new URL("..", import.meta.url));

/** sourceTypes with an in-process SourceAdapter the registry actually imports. */
function registeredAdapterSourceTypes(adaptersDir) {
  const registry = readFileSync(join(adaptersDir, "registry.ts"), "utf8");
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

/** Parse each descriptor object block: connectorType, trustTier, parserVersions, delivery. */
function descriptorBlocks(descriptorsFile) {
  const text = readFileSync(descriptorsFile, "utf8");
  // Anchor on the object-literal connectorType lines (4-space indent) so the
  // interface field `connectorType: ArtifactSourceType;` is not matched.
  const anchors = [...text.matchAll(/^ {4}connectorType: "([a-z_]+)",$/gm)];
  const blocks = [];
  for (let i = 0; i < anchors.length; i += 1) {
    const start = anchors[i].index;
    const end = i + 1 < anchors.length ? anchors[i + 1].index : text.length;
    const body = text.slice(start, end);
    const trustTier = body.match(/trustTier: "([a-z_]+)"/)?.[1] ?? null;
    const parserVersions = [
      ...(body.match(/parserVersions: \[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g),
    ].map((m) => m[1]);
    const delivery = [
      ...(body.match(/delivery: \[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g),
    ].map((m) => m[1]);
    blocks.push({ connectorType: anchors[i][1], trustTier, parserVersions, delivery });
  }
  return blocks;
}

export function findViolations(root = DEFAULT_ROOT) {
  const adaptersDir = join(root, "services/raw/src/adapters");
  const registered = registeredAdapterSourceTypes(adaptersDir);
  const blocks = descriptorBlocks(join(adaptersDir, "descriptors.ts"));
  const violations = [];

  for (const b of blocks) {
    if (b.trustTier === null) {
      violations.push(`descriptor '${b.connectorType}' has no trustTier (must be declared)`);
      continue;
    }
    if (b.trustTier !== "partner") continue;
    if (registered.has(b.connectorType)) {
      violations.push(
        `partner-tier '${b.connectorType}' has an in-process SourceAdapter registered`,
      );
    }
    if (b.parserVersions.length > 0) {
      violations.push(
        `partner-tier '${b.connectorType}' declares parserVersions [${b.parserVersions.join(", ")}]; ` +
          "partner code must not register a Ledger parser",
      );
    }
    if (b.delivery.includes("webhook")) {
      violations.push(
        `partner-tier '${b.connectorType}' declares webhook delivery; a partner connector reaches ` +
          "Raw only via the authenticated generic-ingest boundary",
      );
    }
  }
  return violations;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) {
  const violations = findViolations();
  if (violations.length > 0) {
    for (const v of violations) console.error(`partner-isolation guard: ${v}`);
    console.error(
      `\n${violations.length} violation(s). A partner-tier connector is authored outside Brain's ` +
        "trust boundary and must not run in-process: no registered adapter, no Ledger parser, no " +
        "webhook delivery. It reaches Raw only via /raw/ingest as an api_partner principal.",
    );
    process.exit(1);
  }
  console.log("partner-isolation guard: OK");
}
