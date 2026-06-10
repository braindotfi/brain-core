/**
 * Tests for buildWikiMemoryService — focused on the annotate write-through.
 *
 * listPages / getPage / regenerate / search delegate straight to
 * WikiPageService; `question` delegates to askWiki (covered by the wiki
 * service's own tests). The new surface here is `annotate`: it mints an
 * annotation id, writes through to Raw, and returns the linked ids.
 */

import { describe, expect, it, vi } from "vitest";
import * as raw from "@brain/raw";
import {
  InMemoryAuditEmitter,
  newTenantId,
  newUserId,
  type AnnotationInput,
  type ServiceCallContext,
} from "@brain/shared";
import type { Pool } from "pg";
import { buildWikiMemoryService, WIKI_ANNOTATION_SOURCE_TYPE } from "./wiki-memory-adapter.js";

const TENANT = newTenantId();
const USER = newUserId();

function ctx(): ServiceCallContext {
  return { tenantId: TENANT, actor: USER };
}

function deps() {
  const audit = new InMemoryAuditEmitter();
  const pool = {} as Pool;
  // The page service is unused by annotate; supply a stub.
  const pageService = {
    listPages: vi.fn(),
    getPage: vi.fn(),
    regenerate: vi.fn(),
    search: vi.fn(),
  } as never;
  const wikiDeps = {
    pool,
    audit,
    llm: {} as never,
    embed: {} as never,
    redis: {} as never,
    metrics: {} as never,
    schemas: {} as never,
    questionModel: "gpt-4o-mini",
    policyReader: {} as never,
    agentReader: {} as never,
  };
  const rawDeps = {
    pool,
    blob: {} as never,
    audit,
  };
  return { pageService, wikiDeps, rawDeps, audit };
}

describe("buildWikiMemoryService.annotate", () => {
  it("mints an annotation id and writes through to Raw with the expected envelope", async () => {
    const ingestSpy = vi.spyOn(raw, "ingestOne").mockResolvedValue({
      rawId: "raw_01ANNARTIFACT00000000000000",
      sha256: "0".repeat(64),
      bytes: 0,
      sourceType: WIKI_ANNOTATION_SOURCE_TYPE,
      sourceSchema: null,
      ingestedAt: "2026-01-01T00:00:00Z",
      deduplicated: false,
    });
    const { pageService, wikiDeps, rawDeps } = deps();
    const svc = buildWikiMemoryService(pageService, wikiDeps, rawDeps);

    const input: AnnotationInput = {
      target_type: "ledger_counterparty",
      target_id: "cp_01TESTCOUNTERPARTY000000000",
      body: "Verified vendor on 2026-05-29.",
      override_attributes: { verified_status: "document_verified" },
    };
    const result = await svc.annotate(ctx(), input);

    expect(result.annotation_id.startsWith("ann_")).toBe(true);
    expect(result.raw_artifact_id).toBe("raw_01ANNARTIFACT00000000000000");

    expect(ingestSpy).toHaveBeenCalledTimes(1);
    const call = ingestSpy.mock.calls[0]!;
    const [calledDeps, calledInput] = call;
    expect(calledDeps).toBe(rawDeps);
    expect(calledInput.tenantId).toBe(TENANT);
    expect(calledInput.actor).toBe(USER);
    expect(calledInput.sourceType).toBe(WIKI_ANNOTATION_SOURCE_TYPE);
    expect(calledInput.mimeType).toBe("application/json");
    expect(calledInput.sourceRef).toEqual({
      annotation_id: result.annotation_id,
      target_type: "ledger_counterparty",
      target_id: "cp_01TESTCOUNTERPARTY000000000",
    });

    const body = JSON.parse(calledInput.body.toString("utf8")) as Record<string, unknown>;
    expect(body.annotation_id).toBe(result.annotation_id);
    expect(body.target_id).toBe("cp_01TESTCOUNTERPARTY000000000");
    expect(body.body).toBe("Verified vendor on 2026-05-29.");
    expect(body.override_attributes).toEqual({ verified_status: "document_verified" });
    expect(body.created_by).toBe(USER);
    expect(typeof body.created_at).toBe("string");

    ingestSpy.mockRestore();
  });

  it("omits absent optional fields (body / override_attributes) from the artifact payload", async () => {
    const ingestSpy = vi.spyOn(raw, "ingestOne").mockResolvedValue({
      rawId: "raw_01ANN2000000000000000000000",
      sha256: "0".repeat(64),
      bytes: 0,
      sourceType: WIKI_ANNOTATION_SOURCE_TYPE,
      sourceSchema: null,
      ingestedAt: "2026-01-01T00:00:00Z",
      deduplicated: false,
    });
    const { pageService, wikiDeps, rawDeps } = deps();
    const svc = buildWikiMemoryService(pageService, wikiDeps, rawDeps);

    await svc.annotate(ctx(), {
      target_type: "ledger_transaction",
      target_id: "tx_01TESTTRANSACTION0000000000",
    });

    const calledInput = ingestSpy.mock.calls[0]![1];
    const body = JSON.parse(calledInput.body.toString("utf8")) as Record<string, unknown>;
    expect("body" in body).toBe(false);
    expect("override_attributes" in body).toBe(false);
    expect(body.target_type).toBe("ledger_transaction");

    ingestSpy.mockRestore();
  });

  it("propagates ingestOne failure (no swallow, no partial state)", async () => {
    const ingestSpy = vi
      .spyOn(raw, "ingestOne")
      .mockRejectedValueOnce(new Error("blob unavailable"));
    const { pageService, wikiDeps, rawDeps } = deps();
    const svc = buildWikiMemoryService(pageService, wikiDeps, rawDeps);

    await expect(
      svc.annotate(ctx(), {
        target_type: "ledger_invoice",
        target_id: "inv_01TESTINVOICE000000000000",
      }),
    ).rejects.toThrow("blob unavailable");

    ingestSpy.mockRestore();
  });
});
