import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Pool } from "pg";
import { createUploadIngestPipelineDrain } from "./post-ingest-pipeline.js";

const calls = vi.hoisted(() => ({
  order: [] as string[],
  runInterpretCycle: vi.fn(async () => {
    calls.order.push("interpret");
  }),
  runNormalizeCycle: vi.fn(async () => {
    calls.order.push("normalize");
  }),
  runProjectionCycle: vi.fn(
    async (deps: { onUploadProjected?: (event: unknown) => Promise<void> }) => {
      calls.order.push("canonical");
      await deps.onUploadProjected?.({
        event: "ledger.upload.projected",
        tenantId: "tnt_seed",
        rawArtifactId: "raw_seed",
        rawParsedId: "prs_seed",
        projector: "bank_statement_upload_canonical_v1",
        summary: {
          accounts: 1,
          transactions: 19,
          receivables: 0,
          obligations: 0,
          newCounterparties: 4,
        },
      });
    },
  ),
  runLedgerAparProjectionCycle: vi.fn(async () => {
    calls.order.push("ledger-apar");
  }),
  runLedgerAccountTransactionProjectionCycle: vi.fn(async () => {
    calls.order.push("ledger-account-transaction");
  }),
  regenerateWikiForUploadProjection: vi.fn(async () => {
    calls.order.push("wiki");
  }),
}));

vi.mock("@brain/raw", () => ({
  UPLOAD_DOCUMENT_SCHEMA: "brain.upload.document.v1",
  runInterpretCycle: calls.runInterpretCycle,
}));

vi.mock("@brain/ledger", () => ({
  runLedgerAccountTransactionProjectionCycle: calls.runLedgerAccountTransactionProjectionCycle,
  runLedgerAparProjectionCycle: calls.runLedgerAparProjectionCycle,
  runNormalizeCycle: calls.runNormalizeCycle,
}));

vi.mock("@brain/canonical", () => ({
  runProjectionCycle: calls.runProjectionCycle,
}));

vi.mock("../wiki/regeneration-worker.js", () => ({
  regenerateWikiForUploadProjection: calls.regenerateWikiForUploadProjection,
}));

describe("createUploadIngestPipelineDrain", () => {
  beforeEach(() => {
    calls.order.length = 0;
    calls.runInterpretCycle.mockClear();
    calls.runNormalizeCycle.mockClear();
    calls.runProjectionCycle.mockClear();
    calls.runLedgerAparProjectionCycle.mockClear();
    calls.runLedgerAccountTransactionProjectionCycle.mockClear();
    calls.regenerateWikiForUploadProjection.mockClear();
  });

  it("drains interpret, normalize, canonical, wiki, and agents for seeded upload documents", async () => {
    const trigger = {
      handle: vi.fn(async () => {
        calls.order.push("agents");
      }),
    };
    const drain = createUploadIngestPipelineDrain({
      rawWorkerPool: {} as Pool,
      appPool: {} as Pool,
      canonicalProjectorPool: {} as Pool,
      ledgerProjectorPool: {} as Pool,
      tenantDiscoveryPool: {} as Pool,
      blob: {},
      audit: {},
      pageService: {},
      uploadProjectionAgentTrigger: trigger,
      log: { warn: vi.fn(), error: vi.fn() },
    } as unknown as Parameters<typeof createUploadIngestPipelineDrain>[0]);

    await drain({
      input: {
        tenantId: "tnt_seed",
        actor: "usr_seed",
        sourceType: "pdf_upload",
        sourceRef: { filename: "bank_statement_2026-06.pdf" },
        body: Buffer.from("pdf"),
        mimeType: "application/pdf",
      },
      result: {
        rawId: "raw_seed",
        sha256: "a".repeat(64),
        bytes: 3,
        sourceType: "pdf_upload",
        sourceSchema: "brain.upload.document.v1",
        ingestedAt: "2026-07-25T00:00:00.000Z",
        deduplicated: false,
        extractionJob: null,
      },
    });

    expect(calls.order).toEqual([
      "interpret",
      "normalize",
      "canonical",
      "ledger-apar",
      "ledger-account-transaction",
      "wiki",
      "agents",
    ]);
    expect(trigger.handle).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ledger.upload.projected",
        rawArtifactId: "raw_seed",
      }),
    );
  });

  it("warns and skips upload artifacts that are missing the registered source schema", async () => {
    const warn = vi.fn();
    const drain = createUploadIngestPipelineDrain({
      rawWorkerPool: {} as Pool,
      appPool: {} as Pool,
      canonicalProjectorPool: {} as Pool,
      ledgerProjectorPool: {} as Pool,
      tenantDiscoveryPool: {} as Pool,
      blob: {},
      audit: {},
      pageService: {},
      uploadProjectionAgentTrigger: { handle: vi.fn() },
      log: { warn, error: vi.fn() },
    } as unknown as Parameters<typeof createUploadIngestPipelineDrain>[0]);

    await drain({
      input: {
        tenantId: "tnt_seed",
        actor: "usr_seed",
        sourceType: "csv_upload",
        sourceRef: {},
        body: Buffer.from("csv"),
        mimeType: "text/csv",
      },
      result: {
        rawId: "raw_seed",
        sha256: "a".repeat(64),
        bytes: 3,
        sourceType: "csv_upload",
        sourceSchema: null,
        ingestedAt: "2026-07-25T00:00:00.000Z",
        deduplicated: false,
        extractionJob: null,
      },
    });

    expect(calls.runInterpretCycle).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ source_schema: null }),
      expect.stringContaining("missing registered document source_schema"),
    );
  });
});
