// Deterministic hash of the in-scope Solidity sources, used to bind an approved
// audit record to the exact source tree that was audited (P1 build-evidence).
//
// The tree hash is sha256 over a SORTED, newline-joined list of
// "<relpath>:<sha256(file bytes)>" entries, so it is independent of filesystem
// iteration order and stable across machines. Any added / removed / modified
// .sol file under the source dir changes the hash.
//
// Pure (no process state); callers pass the source dir.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createHash } from "node:crypto";

export function listSolFiles(srcDir) {
  const out = [];
  function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".sol")) out.push(p);
    }
  }
  walk(srcDir);
  return out;
}

export function hashContractSources(srcDir) {
  const entries = listSolFiles(srcDir).map((p) => {
    const rel = relative(srcDir, p).split(sep).join("/");
    const h = createHash("sha256").update(readFileSync(p)).digest("hex");
    return `${rel}:${h}`;
  });
  entries.sort();
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}
