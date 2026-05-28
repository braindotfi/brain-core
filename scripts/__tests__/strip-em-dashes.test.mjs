import { test } from "node:test";
import assert from "node:assert/strict";
import { stripEmDashes } from "../strip-em-dashes.mjs";

test("em dash with surrounding spaces becomes period + capitalised next word", () => {
  assert.equal(
    stripEmDashes("The gate runs deterministic checks — it never defers."),
    "The gate runs deterministic checks. It never defers.",
  );
});

test("em dash without spaces (compound) becomes a hyphen", () => {
  assert.equal(stripEmDashes("M2M—commerce on Base"), "M2M-commerce on Base");
});

test("em dash at end of line becomes a period", () => {
  assert.equal(stripEmDashes("Look at the viewer —"), "Look at the viewer.");
});

test("multiple em dashes in one line all get rewritten", () => {
  assert.equal(stripEmDashes("One — two — three."), "One. Two. Three.");
});

test("hyphens, en dashes, and existing periods are untouched", () => {
  const src = "well-formed: 1-9; en–dash range; ends.";
  assert.equal(stripEmDashes(src), src);
});

test("em dash followed by a lowercase phrase still capitalises that phrase", () => {
  assert.equal(
    stripEmDashes("Brain enforces RLS at the storage layer — not the query layer."),
    "Brain enforces RLS at the storage layer. Not the query layer.",
  );
});

test("preserves surrounding markdown (lists, headings, code spans)", () => {
  const src = `# Heading — clarifier

- Bullet — point
- \`code — span\`
`;
  // Headings + list items + inline code all get the same period+capitalise.
  assert.equal(
    stripEmDashes(src),
    `# Heading. Clarifier

- Bullet. Point
- \`code. Span\`
`,
  );
});
