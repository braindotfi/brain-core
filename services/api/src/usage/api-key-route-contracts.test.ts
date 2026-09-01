import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { routeContractKey, validateApiKeyRouteContracts } from "@brain/shared";
import { API_KEY_ROUTE_CONTRACTS } from "./api-key-route-contracts.js";

describe("API key route metering contracts", () => {
  it("covers the four commercially issuable product families without duplicates", () => {
    const indexed = validateApiKeyRouteContracts(API_KEY_ROUTE_CONTRACTS);
    expect(indexed.size).toBe(43);
    expect(
      Object.fromEntries(
        ["ledger", "raw", "audit", "governance"].map((family) => [
          family,
          API_KEY_ROUTE_CONTRACTS.filter((contract) => contract.productFamily === family).length,
        ]),
      ),
    ).toEqual({ ledger: 15, raw: 12, audit: 10, governance: 6 });
    expect(new Set(API_KEY_ROUTE_CONTRACTS.map((contract) => contract.requiredScope))).toEqual(
      new Set(["ledger:read", "raw:read", "raw:write", "audit:read", "governance:read"]),
    );
  });

  it("keeps every runtime operation id aligned with the public OpenAPI contract", () => {
    const specification = readFileSync(
      resolve(process.cwd(), "../../Brain_API_Specification.yaml"),
      "utf8",
    );
    for (const contract of API_KEY_ROUTE_CONTRACTS) {
      expect(specification).toContain(`operationId: ${contract.operationId}`);
    }
  });

  it("covers every route guarded by a commercially issuable scope", () => {
    const root = resolve(process.cwd(), "../..");
    const guardedRoutes = scanCommerciallyGuardedRoutes(resolve(root, "services"));
    const declared = new Set(
      API_KEY_ROUTE_CONTRACTS.map((contract) => routeContractKey(contract.method, contract.route)),
    );
    const missing = [...guardedRoutes].filter((route) => !declared.has(route));
    expect(missing).toEqual([]);
  });
});

const COMMERCIAL_SCOPES = new Set([
  "ledger:read",
  "raw:read",
  "raw:write",
  "audit:read",
  "governance:read",
]);

function scanCommerciallyGuardedRoutes(servicesRoot: string): Set<string> {
  const routes = new Set<string>();
  for (const file of listSourceFiles(servicesRoot)) {
    const sourceText = readFileSync(file, "utf8");
    if (!sourceText.includes("requireScope(")) continue;
    const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
    const constants = new Map<string, string>();
    walk(source, (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        ts.isStringLiteral(node.initializer)
      ) {
        constants.set(node.name.text, node.initializer.text);
      }
    });
    walk(source, (node) => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      const method = node.expression.name.text.toUpperCase();
      if (!new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]).has(method)) return;
      const routeNode = node.arguments[0];
      if (routeNode === undefined || !ts.isStringLiteralLike(routeNode)) return;
      const scopes = new Set<string>();
      walk(node, (child) => {
        if (
          !ts.isCallExpression(child) ||
          !ts.isIdentifier(child.expression) ||
          child.expression.text !== "requireScope"
        ) {
          return;
        }
        const scopeNode = child.arguments[1];
        if (scopeNode === undefined) return;
        if (ts.isStringLiteralLike(scopeNode)) scopes.add(scopeNode.text);
        if (ts.isIdentifier(scopeNode)) {
          const resolved = constants.get(scopeNode.text);
          if (resolved !== undefined) scopes.add(resolved);
        }
      });
      if ([...scopes].some((scope) => COMMERCIAL_SCOPES.has(scope))) {
        routes.add(routeContractKey(method, routeNode.text));
      }
    });
  }
  return routes;
}

function listSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(path));
    if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
      files.push(path);
    }
  }
  return files;
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}
