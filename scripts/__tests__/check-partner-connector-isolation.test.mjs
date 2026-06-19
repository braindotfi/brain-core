import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findViolations } from "../check-partner-connector-isolation.mjs";

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "partner-isolation-guard-"));
  for (const [name, content] of Object.entries(files)) {
    const p = join(root, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

const REGISTRY = `
const ADAPTERS: ReadonlyArray<SourceAdapter> = [
  FooAdapter,
];
`;

const FOO_ADAPTER = `
export const FooAdapter: SourceAdapter = {
  sourceType: "foo",
};
`;

// 4-space indentation on connectorType so the object-literal anchor matches
// (the interface field uses 2-space indent and must not be picked up).
function descriptors(blocks) {
  return `
export const CONNECTOR_DESCRIPTORS: ReadonlyArray<ConnectorDescriptor> = [
${blocks}
];
`;
}

const FIRST_PARTY_FOO = `  {
    connectorType: "foo",
    delivery: ["webhook", "cursor"],
    trustTier: "first_party",
    parserVersions: ["foo_v1"],
  },`;

function baseTree(descriptorBlocks) {
  return {
    "services/raw/src/adapters/registry.ts": REGISTRY,
    "services/raw/src/adapters/foo.ts": FOO_ADAPTER,
    "services/raw/src/adapters/descriptors.ts": descriptors(descriptorBlocks),
  };
}

test("passes when every connector is first-party (live shape)", () => {
  const root = fixture(baseTree(FIRST_PARTY_FOO));
  assert.deepEqual(findViolations(root), []);
  rmSync(root, { recursive: true, force: true });
});

test("passes for a correctly out-of-process partner connector", () => {
  const partner = `  {
    connectorType: "acme_partner",
    delivery: ["file"],
    trustTier: "partner",
    parserVersions: [],
  },`;
  const root = fixture(baseTree(`${FIRST_PARTY_FOO}\n${partner}`));
  assert.deepEqual(findViolations(root), []);
  rmSync(root, { recursive: true, force: true });
});

test("flags a partner connector with an in-process adapter", () => {
  // 'foo' has a registered FooAdapter; declaring it partner-tier is a violation.
  const partnerFoo = `  {
    connectorType: "foo",
    delivery: ["file"],
    trustTier: "partner",
    parserVersions: [],
  },`;
  const root = fixture(baseTree(partnerFoo));
  const v = findViolations(root);
  assert.ok(
    v.some((x) => x.includes("'foo'") && x.includes("in-process SourceAdapter")),
    v.join("; "),
  );
  rmSync(root, { recursive: true, force: true });
});

test("flags a partner connector declaring a Ledger parser", () => {
  const partner = `  {
    connectorType: "acme_partner",
    delivery: ["file"],
    trustTier: "partner",
    parserVersions: ["acme_v1"],
  },`;
  const root = fixture(baseTree(partner));
  const v = findViolations(root);
  assert.ok(
    v.some((x) => x.includes("acme_partner") && x.includes("Ledger parser")),
    v.join("; "),
  );
  rmSync(root, { recursive: true, force: true });
});

test("flags a partner connector declaring webhook delivery", () => {
  const partner = `  {
    connectorType: "acme_partner",
    delivery: ["webhook"],
    trustTier: "partner",
    parserVersions: [],
  },`;
  const root = fixture(baseTree(partner));
  const v = findViolations(root);
  assert.ok(
    v.some((x) => x.includes("acme_partner") && x.includes("webhook delivery")),
    v.join("; "),
  );
  rmSync(root, { recursive: true, force: true });
});

test("flags a descriptor missing trustTier", () => {
  const noTier = `  {
    connectorType: "foo",
    delivery: ["file"],
    parserVersions: [],
  },`;
  const root = fixture(baseTree(noTier));
  const v = findViolations(root);
  assert.ok(
    v.some((x) => x.includes("'foo'") && x.includes("no trustTier")),
    v.join("; "),
  );
  rmSync(root, { recursive: true, force: true });
});

test("guards the real repository tree (no violations)", () => {
  // No root override -> runs against the actual descriptors + registry.
  assert.deepEqual(findViolations(), []);
});
