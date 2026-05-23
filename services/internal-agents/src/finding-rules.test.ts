import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface FindingRule {
  id: string;
  finding_kind: string;
  severity: string;
  description: string;
}
interface FindingCatalog {
  agent: string;
  version: number;
  rules: FindingRule[];
}

const SEVERITIES = new Set(["low", "medium", "high", "critical"]);

function load(agent: string): FindingCatalog {
  return JSON.parse(
    readFileSync(new URL(`./${agent}/finding-rules.json`, import.meta.url), "utf8"),
  ) as FindingCatalog;
}

describe("high-risk finding-rule catalogs (2.6)", () => {
  it.each(["vendor_risk", "compliance"])("%s catalog is versioned and well-formed", (agent) => {
    const cat = load(agent);
    expect(cat.agent).toBe(agent);
    expect(cat.version).toBeGreaterThanOrEqual(1);
    expect(cat.rules.length).toBeGreaterThan(0);
    const ids = new Set<string>();
    for (const r of cat.rules) {
      expect(r.id).toMatch(/^[a-z][a-z0-9_]+$/);
      expect(r.finding_kind.length).toBeGreaterThan(0);
      expect(SEVERITIES.has(r.severity)).toBe(true);
      expect(ids.has(r.id)).toBe(false); // unique rule ids
      ids.add(r.id);
    }
  });
});
