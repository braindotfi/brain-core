#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../packages/surfaces/src", import.meta.url).pathname;
const offenders = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      walk(path);
      continue;
    }
    if (path.endsWith(".ts") && readFileSync(path, "utf8").includes("@brain/core")) {
      offenders.push(path);
    }
  }
}

if (existsSync(root)) walk(root);

if (offenders.length > 0) {
  console.error("Acyclic check failed. packages/surfaces must not import @brain/core:");
  for (const file of offenders) console.error(`  ${file}`);
  process.exit(1);
}

console.log("Acyclic check passed: surfaces does not depend on core.");
