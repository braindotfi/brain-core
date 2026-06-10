import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findViolations } from "../check-connector-descriptors.mjs";

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "connector-guard-"));
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

const SOURCES_TYPES = `
export const CONCRETE_SOURCE_TYPES: ReadonlySet<SourceType> = new Set(["foo"]);
`;

const LEDGER_REGISTRY = `
registerParser("foo_v1", async () => []);
`;

function baseTree(overrides = {}) {
  return {
    "services/raw/src/adapters/registry.ts": REGISTRY,
    "services/raw/src/adapters/foo.ts": FOO_ADAPTER,
    "services/raw/src/adapters/descriptors.ts": `
      connectorType: "foo",
      parserVersions: ["foo_v1"],
    `,
    "services/raw/src/adapters/foo.test.ts": `it("ingests", () => expect("foo"))`,
    "services/raw/src/sources/types.ts": SOURCES_TYPES,
    "services/ledger/src/extractors/registry.ts": LEDGER_REGISTRY,
    ...overrides,
  };
}

test("passes on a described, parsed, tested connector", () => {
  const root = fixture(baseTree());
  assert.deepEqual(findViolations(root), []);
  rmSync(root, { recursive: true, force: true });
});

test("flags a registered adapter with no descriptor (undescribed)", () => {
  const root = fixture(
    baseTree({
      "services/raw/src/adapters/descriptors.ts": `parserVersions: ["foo_v1"],`,
    }),
  );
  const v = findViolations(root);
  assert.ok(
    v.some((x) => x.includes("'foo'") && x.includes("undescribed")),
    v.join("; "),
  );
  rmSync(root, { recursive: true, force: true });
});

test("flags a descriptor whose adapter is not registered", () => {
  const root = fixture(
    baseTree({
      "services/raw/src/adapters/descriptors.ts": `
        connectorType: "foo",
        connectorType: "ghost",
        parserVersions: ["foo_v1"],
      `,
    }),
  );
  const v = findViolations(root);
  assert.ok(
    v.some((x) => x.includes("'ghost'") && x.includes("unregistered")),
    v.join("; "),
  );
  rmSync(root, { recursive: true, force: true });
});

test("flags a declared parser that is not registered in the Ledger registry", () => {
  const root = fixture(
    baseTree({
      "services/raw/src/adapters/descriptors.ts": `
        connectorType: "foo",
        parserVersions: ["foo_v1", "missing_v9"],
      `,
    }),
  );
  const v = findViolations(root);
  assert.ok(
    v.some((x) => x.includes("missing_v9")),
    v.join("; "),
  );
  rmSync(root, { recursive: true, force: true });
});

test("flags a registered Ledger parser no descriptor claims (dormant parser)", () => {
  const root = fixture(
    baseTree({
      "services/ledger/src/extractors/registry.ts": `
        registerParser("foo_v1", async () => []);
        registerParser("orphan_v1", async () => []);
      `,
    }),
  );
  const v = findViolations(root);
  assert.ok(
    v.some((x) => x.includes("orphan_v1") && x.includes("dormant")),
    v.join("; "),
  );
  rmSync(root, { recursive: true, force: true });
});

test("flags a concrete connector with no test coverage (dormant connector)", () => {
  const tree = baseTree();
  delete tree["services/raw/src/adapters/foo.test.ts"];
  const root = fixture(tree);
  const v = findViolations(root);
  assert.ok(
    v.some((x) => x.includes("'foo'") && x.includes("no adapter test")),
    v.join("; "),
  );
  rmSync(root, { recursive: true, force: true });
});
