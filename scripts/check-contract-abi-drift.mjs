#!/usr/bin/env node
/**
 * CI guard: every `parseAbi([...])` signature in TypeScript code must match a
 * function entry in the corresponding Foundry build artifact at
 * `contracts/out/<Contract>.sol/<Contract>.json`. Catches the drift case
 * where a contract is upgraded (selector / signature changes) and a TS
 * caller continues to use the old shape -- which would silently revert on
 * chain when run against the new bytecode.
 *
 * Scope (batch 13 P2 / Opus 4.8): the Brain-owned contracts the TS code
 * actually calls. Third-party ABIs (USDC, etc.) are out of scope -- those
 * are governed by their vendor, not us.
 *
 * Variable -> contract mapping. Anchored at the TS variable name the call
 * site uses (e.g. `const ESCROW_ABI = parseAbi([...])`), this is the
 * smallest stable cue that ties the call site to its on-chain target.
 *
 *   ESCROW_ABI               -> BrainEscrow
 *   REGISTRY_ABI             -> BrainMCPAgentRegistry
 *   REPUTATION_ABI           -> BrainReputationRegistry
 *   BRAIN_SMART_ACCOUNT_ABI  -> BrainSmartAccount
 *
 * To add a new mapping, extend `KNOWN_VARS` below. Anything else is silently
 * ignored (so USDC_ABI etc. stay out of scope without the guard tripping).
 *
 * How the check works:
 *
 *   1. Walk every .ts file outside node_modules/dist for `const <NAME> = parseAbi([...])`.
 *   2. For each matched variable, look up the contract via KNOWN_VARS.
 *   3. Load `contracts/out/<Contract>.sol/<Contract>.json` and extract its
 *      function entries.
 *   4. For each signature string in the TS array, parse out the function
 *      name + parameter type list and confirm a function with that exact
 *      shape exists in the on-disk ABI. Drift on either name or input types
 *      fails the guard.
 *
 * Run modes:
 *
 *   --check  (default): exit 1 with a per-finding diagnostic on any drift.
 *   --quiet         : exit 1 on drift, no per-finding noise -- for CI.
 *
 * If `contracts/out/` does not exist (no `forge build` ever ran in this
 * checkout, e.g. a fresh clone without Foundry), the guard skips with a
 * clear notice rather than failing. `forge build` is a prerequisite, not a
 * concern of this script.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

// Anchored to process.cwd() so tests can redirect the guard at a fixture
// tree, and so the script always runs against the operator's checkout root.
const ROOT = process.cwd();
const CONTRACTS_OUT = join(ROOT, "contracts", "out");

/**
 * Variable-name -> contract-name map. Add a new entry to extend the guard.
 */
const KNOWN_VARS = {
  ESCROW_ABI: "BrainEscrow",
  REGISTRY_ABI: "BrainMCPAgentRegistry",
  REPUTATION_ABI: "BrainReputationRegistry",
  BRAIN_SMART_ACCOUNT_ABI: "BrainSmartAccount",
};

/**
 * Hand-rolled 4-byte selector literals.
 *
 * A hand-written selector is invisible to the parseAbi scan above, and that is
 * exactly how `escrow-base.ts` shipped `0x84f97fba` for
 * `release(bytes32,uint256)` -- a selector BrainEscrow does not dispatch at
 * all. Since the contract has no fallback, every escrow release reverted, and
 * this guard reported OK the whole time.
 *
 * Every selector constant must therefore be registered here with the signature
 * it claims to encode. The guard verifies that signature still exists on the
 * named contract; the KECCAK correctness of the literal itself is pinned by the
 * companion unit test named in `pinnedBy`, which recomputes it with viem.
 *
 * Prefer `parseAbi` + `encodeFunctionData` over a literal. Register one here
 * only when the module must stay SDK-free.
 */
const PINNED_SELECTORS = {
  RELEASE_SELECTOR: {
    contract: "BrainEscrow",
    signature: "function release(bytes32 escrowId, uint256 amount)",
    pinnedBy: "services/execution/src/rails/escrow-base.selector.test.ts",
  },
};

/**
 * Standard ERC-20 selectors. Out of scope for the same reason USDC_ABI is:
 * these are governed by the token standard, not by us, and they cannot drift.
 * Keyed by literal so a typo in one still trips the guard.
 */
const THIRD_PARTY_SELECTORS = new Set([
  "0xa9059cbb", // transfer(address,uint256)
  "0x23b872dd", // transferFrom(address,address,uint256)
  "0x095ea7b3", // approve(address,uint256)
  "0x70a08231", // balanceOf(address)
]);

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".venv",
  "venv",
  "coverage",
  ".turbo",
  ".pnpm-store",
  ".claude",
  "out",
]);

function* walkTs(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walkTs(p);
    else if (st.isFile() && /\.tsx?$/.test(name)) yield p;
  }
}

/**
 * Extract `const <VAR> = parseAbi([...])` occurrences. Returns
 * { file, variable, signatures, line }.
 *
 * Liberal on whitespace; tolerates multi-line array literals.
 */
function extractParseAbiBlocks(file) {
  const src = readFileSync(file, "utf8");
  const blocks = [];
  // Match either `const NAME = parseAbi([` or `NAME = parseAbi([` to be
  // permissive about prior `export` / `let` / direct assignment.
  const re = /(?:^|\s)(?:const|let|var|export\s+const)?\s*(\w+)\s*=\s*parseAbi\s*\(\s*\[/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    const variable = m[1];
    if (!Object.prototype.hasOwnProperty.call(KNOWN_VARS, variable)) continue;
    // Find the closing `])` for this block. parseAbi takes a string-array, so
    // a simple bracket-balance walk is fine.
    let i = re.lastIndex;
    let depth = 1;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === "[") depth++;
      else if (ch === "]") depth--;
      i++;
    }
    if (depth !== 0) continue;
    const body = src.slice(re.lastIndex, i - 1); // text between the [ ... ]
    const signatures = [];
    const sigRe = /["'`]([^"'`]+)["'`]/g;
    let sm;
    while ((sm = sigRe.exec(body)) !== null) {
      const s = sm[1].trim();
      if (s.length > 0) signatures.push(s);
    }
    blocks.push({
      file,
      variable,
      signatures,
      line: src.slice(0, m.index).split("\n").length,
    });
  }
  return blocks;
}

/**
 * Parse a viem-style signature like
 *   "function getEscrow(bytes32 escrowId) external view returns (...)"
 * into { name, inputTypes: ["bytes32"] }. Returns null if it doesn't look
 * like a function (event/error/etc.).
 */
function parseSignature(sig) {
  const m = /^function\s+(\w+)\s*\(([^)]*)\)/.exec(sig);
  if (m === null) return null;
  const name = m[1];
  const argList = m[2].trim();
  if (argList.length === 0) return { name, inputTypes: [] };
  const inputTypes = argList.split(",").map((part) => {
    // Each arg looks like "<type> [<storage-location>] <name>" -- e.g.
    // "bytes32 escrowId", "bytes calldata data", "address payer". The TYPE
    // is the leading token before any storage location keyword.
    const tokens = part.trim().split(/\s+/);
    const head = tokens[0] ?? "";
    return head;
  });
  return { name, inputTypes };
}

/**
 * Extract `const <NAME> = "0x<8 hex>"` occurrences -- hand-rolled 4-byte
 * selectors. Returns { file, variable, literal, line }.
 *
 * Deliberately matches ANY 8-hex-digit string constant, not just names ending
 * in _SELECTOR, so a selector cannot hide behind a different name.
 */
function extractSelectorLiterals(file) {
  // Tests legitimately hand-build calldata and bytecode fixtures (a contract's
  // 0x60806040 creation prefix matches the same shape). The guard is about
  // production call sites.
  if (/\.(test|spec)\.tsx?$/.test(file)) return [];
  const src = readFileSync(file, "utf8");
  const out = [];
  const re = /(?:^|\s)(?:const|let|var|export\s+const)\s+(\w+)\s*(?::\s*[^=]+)?=\s*["'`](0x[0-9a-fA-F]{8})["'`]/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push({
      file,
      variable: m[1],
      literal: m[2].toLowerCase(),
      line: src.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}

function loadAbi(contract) {
  const path = join(CONTRACTS_OUT, `${contract}.sol`, `${contract}.json`);
  if (!existsSync(path)) return null;
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(j.abi)) return null;
    return j.abi;
  } catch {
    return null;
  }
}

function findMatchingFunction(abi, name, inputTypes) {
  for (const entry of abi) {
    if (entry.type !== "function") continue;
    if (entry.name !== name) continue;
    const abiTypes = Array.isArray(entry.inputs) ? entry.inputs.map((i) => String(i.type)) : [];
    if (abiTypes.length !== inputTypes.length) continue;
    let match = true;
    for (let i = 0; i < abiTypes.length; i++) {
      if (abiTypes[i] !== inputTypes[i]) {
        match = false;
        break;
      }
    }
    if (match) return entry;
  }
  return null;
}

function main() {
  const quiet = process.argv.includes("--quiet");
  if (!existsSync(CONTRACTS_OUT)) {
    if (!quiet) {
      console.log(
        `[check-contract-abi-drift] skip: ${CONTRACTS_OUT} does not exist. ` +
          "Run `forge build` in contracts/ before this guard can run.",
      );
    }
    process.exit(0);
  }

  const blocks = [];
  const selectorLiterals = [];
  for (const file of walkTs(ROOT)) {
    blocks.push(...extractParseAbiBlocks(file));
    selectorLiterals.push(...extractSelectorLiterals(file));
  }

  // Selector-literal findings are collected before the "no parseAbi blocks"
  // early exit below, so a repo with no parseAbi blocks still cannot smuggle
  // in a raw selector -- PROVIDED contracts/out/ exists. It does not follow
  // that these checks are artifact-independent: the CONTRACTS_OUT guard
  // above is a full early exit (process.exit(0) before this file walk even
  // runs), so with no `forge build` output this whole function -- including
  // the "unregistered selector" finding, which needs no ABI at all -- never
  // runs. This guard is only load-bearing in a job that ran `forge build`
  // first (see .github/workflows/pr.yml, `contracts` job).
  const selectorFindings = [];
  for (const lit of selectorLiterals) {
    if (THIRD_PARTY_SELECTORS.has(lit.literal)) continue;
    const pinned = PINNED_SELECTORS[lit.variable];
    if (pinned === undefined) {
      selectorFindings.push({
        kind: "selector-unregistered",
        file: lit.file,
        line: lit.line,
        variable: lit.variable,
        msg:
          `hand-rolled 4-byte selector ${lit.literal} is not registered in PINNED_SELECTORS. ` +
          "Prefer parseAbi + encodeFunctionData; if the module must stay SDK-free, register it " +
          "with its signature and a unit test that recomputes the keccak.",
      });
      continue;
    }
    const abi = loadAbi(pinned.contract);
    if (abi === null) {
      selectorFindings.push({
        kind: "selector-abi-missing",
        file: lit.file,
        line: lit.line,
        variable: lit.variable,
        msg: `forge artifact missing for ${pinned.contract}. Run \`forge build\`.`,
      });
      continue;
    }
    const parsed = parseSignature(pinned.signature);
    if (parsed === null || findMatchingFunction(abi, parsed.name, parsed.inputTypes) === null) {
      selectorFindings.push({
        kind: "selector-drift",
        file: lit.file,
        line: lit.line,
        variable: lit.variable,
        msg:
          `registered signature "${pinned.signature}" has no exact-match function in ` +
          `${pinned.contract}.json. The selector encodes a call the contract no longer has.`,
      });
    }
  }

  if (selectorFindings.length > 0) {
    for (const f of selectorFindings) {
      console.error(`[SELECTOR] ${f.file}:${f.line} (${f.variable})`);
      console.error(`           ${f.msg}`);
    }
    process.exit(1);
  }

  if (blocks.length === 0) {
    if (!quiet) {
      console.log(
        "[check-contract-abi-drift] no parseAbi blocks matched KNOWN_VARS. " +
          "If you added a new mapping, this is the moment to verify it took.",
      );
    }
    // Not a hard fail -- the repo could legitimately be without any
    // matched callers (e.g. during a refactor). The Foundry side still
    // has its own forge test suite.
    process.exit(0);
  }

  const findings = [];
  for (const blk of blocks) {
    const contract = KNOWN_VARS[blk.variable];
    const abi = loadAbi(contract);
    if (abi === null) {
      findings.push({
        kind: "abi-missing",
        file: blk.file,
        line: blk.line,
        variable: blk.variable,
        contract,
        msg: `forge artifact missing for contract ${contract} (looked in contracts/out/${contract}.sol/${contract}.json). Run \`forge build\`.`,
      });
      continue;
    }
    for (const sig of blk.signatures) {
      const parsed = parseSignature(sig);
      if (parsed === null) continue; // event / error / non-function, skip
      const hit = findMatchingFunction(abi, parsed.name, parsed.inputTypes);
      if (hit === null) {
        findings.push({
          kind: "drift",
          file: blk.file,
          line: blk.line,
          variable: blk.variable,
          contract,
          signature: sig,
          msg: `signature has no exact-match function in ${contract}.json (name + input-type list must match)`,
        });
      }
    }
  }

  if (findings.length === 0) {
    if (!quiet) {
      console.log(
        `[check-contract-abi-drift] OK -- ${blocks.length} parseAbi block(s) verified against ${
          new Set(blocks.map((b) => KNOWN_VARS[b.variable])).size
        } contract artifact(s).`,
      );
    }
    process.exit(0);
  }

  for (const f of findings) {
    const where = `${f.file}:${f.line}`;
    if (f.kind === "drift") {
      console.error(`[ABI DRIFT] ${where} (${f.variable} -> ${f.contract})`);
      console.error(`            signature: ${f.signature}`);
      console.error(`            ${f.msg}`);
    } else if (f.kind === "abi-missing") {
      console.error(`[ABI MISSING] ${where} (${f.variable} -> ${f.contract})`);
      console.error(`              ${f.msg}`);
    }
  }
  process.exit(1);
}

main();
