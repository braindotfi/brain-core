import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, "../teams");
const output = resolve(packageDir, "../teams-app-package.zip");
const required = ["manifest.json", "color.png", "outline.png"];

for (const name of required) {
  const path = resolve(packageDir, name);
  if (!existsSync(path)) {
    throw new Error(`Missing Teams package file: ${path}`);
  }
}

if (existsSync(output)) rmSync(output);

execFileSync("zip", ["-q", "-r", output, ...required], {
  cwd: packageDir,
  stdio: "inherit",
});

console.log(output);
