import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const surface = JSON.parse(readFileSync(resolve(ROOT, "docs/api-surface.brainmvb.json"), "utf8"));

function endpoint(method, path) {
  for (const group of surface.endpoint_groups) {
    const found = group.endpoints.find(
      (candidate) => candidate.method === method && candidate.path === path,
    );
    if (found !== undefined) return found;
  }
  return undefined;
}

test("BrainMVB surface includes all mounted counterparty trust transitions", () => {
  const transitions = ["grant", "pause", "restore", "acknowledge"];

  for (const transition of transitions) {
    const path = `/v1/ledger/counterparties/{counterparty_id}/trust/${transition}`;
    const entry = endpoint("POST", path);

    assert.ok(entry, `missing ${path}`);
    assert.equal(entry.auth, "bearer user JWT only");
    assert.equal(entry.required_scope, "ledger:write");
    assert.equal(entry.enforcement, "route_scope_check_enforced");
    assert.match(entry.request_shape, /user principal required/);
    assert.match(entry.request_shape, /platform shared-secret and API keys are rejected/);
    assert.equal(
      entry.openapi,
      `documented:/ledger/counterparties/{counterparty_id}/trust/${transition}`,
    );
  }
});
