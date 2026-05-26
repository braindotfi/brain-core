import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findViolations } from "../check-no-onchain-pii.mjs";

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "onchain-pii-"));
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

test("passes on a commitment-only contract (bytes32 / address / uint)", () => {
  const dir = fixture({
    "Ok.sol": `contract Ok {
      function anchor(bytes32 tenantId, bytes32 root, uint256 ts) external {}
      event Anchored(bytes32 indexed tenantId, bytes32 root);
    }`,
  });
  assert.deepEqual(findViolations(dir), []);
  rmSync(dir, { recursive: true, force: true });
});

test("ignores `string` inside an EIP-712 type-hash literal", () => {
  const dir = fixture({
    "Eip712.sol": `contract E {
      bytes32 constant T = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    }`,
  });
  assert.deepEqual(findViolations(dir), []);
  rmSync(dir, { recursive: true, force: true });
});

test("flags a `string` parameter on the ABI surface", () => {
  const dir = fixture({
    "Bad.sol": `contract Bad {
      function register(bytes32 id, string memory tenantName) external {}
    }`,
  });
  const v = findViolations(dir);
  assert.equal(v.length, 1);
  assert.match(v[0], /string/);
  rmSync(dir, { recursive: true, force: true });
});

test("ignores `string` in a comment", () => {
  const dir = fixture({
    "Comment.sol": `contract C {
      // the string name is intentionally not stored
      function ok(bytes32 id) external {}
    }`,
  });
  assert.deepEqual(findViolations(dir), []);
  rmSync(dir, { recursive: true, force: true });
});
