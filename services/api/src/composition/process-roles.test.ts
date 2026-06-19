import { describe, expect, it } from "vitest";
import {
  WORKER_GROUPS,
  parseWorkerSelection,
  resolveComposition,
} from "./process-roles.js";

describe("parseWorkerSelection", () => {
  it('"all" selects every worker group', () => {
    expect(parseWorkerSelection("all")).toEqual(new Set(WORKER_GROUPS));
  });

  it('"none" and "" select nothing', () => {
    expect(parseWorkerSelection("none").size).toBe(0);
    expect(parseWorkerSelection("").size).toBe(0);
  });

  it("parses a CSV (whitespace + case tolerant)", () => {
    expect(parseWorkerSelection(" Raw , Canonical ")).toEqual(new Set(["raw", "canonical"]));
  });

  it("throws on an unknown group (fail-closed)", () => {
    expect(() => parseWorkerSelection("raw,bogus")).toThrow(/unknown worker group/i);
  });
});

describe("resolveComposition", () => {
  it("api-only process creates only route pools, no workers", () => {
    const c = resolveComposition({ httpEnabled: true, workers: "none" });
    expect(c.httpEnabled).toBe(true);
    expect(c.workers.size).toBe(0);
    expect([...c.pools].sort()).toEqual(["audit_verifier", "resolver", "tenant_deletion"]);
  });

  it("a worker-only process creates only that group's pools, no /v1", () => {
    const c = resolveComposition({ httpEnabled: false, workers: "raw" });
    expect(c.httpEnabled).toBe(false);
    expect(c.workers).toEqual(new Set(["raw"]));
    expect([...c.pools]).toEqual(["raw_worker"]);
  });

  it("brain_app-only worker groups need no role pool", () => {
    const c = resolveComposition({ httpEnabled: false, workers: "normalize,webhook,agent_route" });
    expect(c.pools.size).toBe(0);
  });

  it("the audit worker group needs both verifier and publisher pools", () => {
    const c = resolveComposition({ httpEnabled: false, workers: "audit" });
    expect([...c.pools].sort()).toEqual(["audit_publisher", "audit_verifier"]);
  });

  it("shared pools appear once for both a route and a worker consumer", () => {
    // tenant_deletion: DELETE /v1/tenants route + blob_purge worker.
    const c = resolveComposition({ httpEnabled: true, workers: "blob_purge" });
    expect([...c.pools].filter((p) => p === "tenant_deletion")).toHaveLength(1);
  });

  it("the default all-in-one process creates every pool and worker", () => {
    const c = resolveComposition({ httpEnabled: true, workers: "all" });
    expect(c.workers).toEqual(new Set(WORKER_GROUPS));
    expect([...c.pools].sort()).toEqual([
      "audit_publisher",
      "audit_verifier",
      "canonical_projector",
      "execution_worker",
      "ledger_projector",
      "raw_worker",
      "resolver",
      "tenant_deletion",
    ]);
  });
});
