import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  createDebouncedUploadIngestPipelineDrain,
  createUploadIngestPipelineDrain,
  runUploadProjectionSideEffects,
} from "./post-ingest-pipeline.js";
import type * as BrainShared from "@brain/shared";

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
  rebuildAparProjectionFromCanonical: vi.fn(async () => {
    calls.order.push("ledger-apar");
  }),
  rebuildAccountTransactionProjectionFromCanonical: vi.fn(async () => {
    calls.order.push("ledger-account-transaction");
  }),
  regenerateWikiForUploadProjection: vi.fn(async () => {
    calls.order.push("wiki");
  }),
  setArtifactProjectionStatus: vi.fn(async (_client: unknown, _rawId: string, status: string) => {
    calls.order.push(`projection status ${status}`);
  }),
}));

vi.mock("@brain/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof BrainShared>();
  return {
    ...actual,
    withTenantScope: vi.fn(
      async (_pool: unknown, _tenantId: string, cb: (client: unknown) => unknown) =>
        cb({ query: vi.fn() }),
    ),
  };
});

vi.mock("@brain/raw", () => ({
  UPLOAD_DOCUMENT_SCHEMA: "brain.upload.document.v1",
  runInterpretCycle: calls.runInterpretCycle,
  setArtifactProjectionStatus: calls.setArtifactProjectionStatus,
}));

vi.mock("@brain/ledger", () => ({
  rebuildAccountTransactionProjectionFromCanonical:
    calls.rebuildAccountTransactionProjectionFromCanonical,
  rebuildAparProjectionFromCanonical: calls.rebuildAparProjectionFromCanonical,
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
    vi.useRealTimers();
    calls.order.length = 0;
    calls.runInterpretCycle.mockClear();
    calls.runNormalizeCycle.mockClear();
    calls.runProjectionCycle.mockClear();
    calls.rebuildAparProjectionFromCanonical.mockClear();
    calls.rebuildAccountTransactionProjectionFromCanonical.mockClear();
    calls.regenerateWikiForUploadProjection.mockClear();
    calls.setArtifactProjectionStatus.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drains interpret, normalize, canonical, wiki, and agents for seeded upload documents", async () => {
    const info = vi.fn();
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
      wikiSettleDelayMs: 0,
      log: { info, warn: vi.fn(), error: vi.fn() },
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
        projectionStatus: "pending",
        ingestedAt: "2026-07-25T00:00:00.000Z",
        deduplicated: false,
        extractionJob: null,
      },
    });

    expect(calls.order).toEqual([
      "interpret",
      "normalize",
      "canonical",
      "projection status projecting",
      "ledger-apar",
      "ledger-account-transaction",
      "wiki",
      "agents",
      "projection status projected",
    ]);
    expect(calls.setArtifactProjectionStatus).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      "raw_seed",
      "projecting",
    );
    expect(calls.setArtifactProjectionStatus).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      "raw_seed",
      "projected",
    );
    expect(calls.rebuildAparProjectionFromCanonical).toHaveBeenCalledWith(
      {} as Pool,
      {},
      expect.objectContaining({ tenantId: "tnt_seed", actor: "sys_upload_projection" }),
    );
    expect(calls.rebuildAccountTransactionProjectionFromCanonical).toHaveBeenCalledWith(
      {} as Pool,
      "tnt_seed",
    );
    expect(trigger.handle).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ledger.upload.projected",
        rawArtifactId: "raw_seed",
      }),
    );
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ step: "ledger_apar_rebuild" }),
      "upload projection side effect starting",
    );
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ step: "ledger_apar_rebuild" }),
      "upload projection side effect completed",
    );
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ step: "ledger_account_transaction_rebuild" }),
      "upload projection side effect starting",
    );
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ step: "wiki_regeneration" }),
      "upload projection side effect starting",
    );
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ step: "agent_trigger" }),
      "upload projection side effect completed",
    );
  });

  it("waits for ledger transaction visibility before regenerating wiki pages", async () => {
    vi.useFakeTimers();
    const trigger = { handle: vi.fn() };
    const promise = runUploadProjectionSideEffects(
      {
        ledgerProjectorPool: {} as Pool,
        tenantDiscoveryPool: {} as Pool,
        audit: {},
        pageService: {},
        uploadProjectionAgentTrigger: trigger,
        wikiSettleDelayMs: 250,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      } as unknown as Parameters<typeof runUploadProjectionSideEffects>[0],
      {
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
      },
      1_000,
    );

    await vi.advanceTimersByTimeAsync(249);
    expect(calls.regenerateWikiForUploadProjection).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(calls.regenerateWikiForUploadProjection).toHaveBeenCalledTimes(1);
    expect(trigger.handle).toHaveBeenCalledTimes(1);
  });

  it("times out and logs the exact upload projection side effect that hangs", async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    calls.rebuildAparProjectionFromCanonical.mockImplementationOnce(
      () => new Promise<never>(() => {}),
    );
    const promise = runUploadProjectionSideEffects(
      {
        ledgerProjectorPool: {} as Pool,
        tenantDiscoveryPool: {} as Pool,
        audit: {},
        pageService: {},
        uploadProjectionAgentTrigger: { handle: vi.fn() },
        log: { info: vi.fn(), warn, error: vi.fn() },
      } as unknown as Parameters<typeof runUploadProjectionSideEffects>[0],
      {
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
      },
      10,
    );

    const expectedRejection = expect(promise).rejects.toThrow(
      "upload projection side effect timed out: ledger_apar_rebuild after 10ms",
    );
    await vi.advanceTimersByTimeAsync(10);
    await expectedRejection;
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        step: "ledger_apar_rebuild",
        tenant_id: "tnt_seed",
        raw_artifact_id: "raw_seed",
        timeout_ms: 10,
      }),
      "upload projection side effect timed out",
    );
    expect(calls.setArtifactProjectionStatus).toHaveBeenLastCalledWith(
      expect.anything(),
      "raw_seed",
      "projection_timed_out",
    );
    expect(calls.rebuildAccountTransactionProjectionFromCanonical).not.toHaveBeenCalled();
    expect(calls.regenerateWikiForUploadProjection).not.toHaveBeenCalled();
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
        projectionStatus: null,
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

describe("createDebouncedUploadIngestPipelineDrain", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    calls.order.length = 0;
    calls.runInterpretCycle.mockClear();
    calls.runNormalizeCycle.mockClear();
    calls.runProjectionCycle.mockClear();
    calls.rebuildAparProjectionFromCanonical.mockClear();
    calls.rebuildAccountTransactionProjectionFromCanonical.mockClear();
    calls.regenerateWikiForUploadProjection.mockClear();
    calls.setArtifactProjectionStatus.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces sequential upload document ingests into one background drain", async () => {
    const drain = createDebouncedUploadIngestPipelineDrain(
      {
        rawWorkerPool: {} as Pool,
        appPool: {} as Pool,
        canonicalProjectorPool: {} as Pool,
        ledgerProjectorPool: {} as Pool,
        tenantDiscoveryPool: {} as Pool,
        blob: {},
        audit: {},
        pageService: {},
        uploadProjectionAgentTrigger: {
          handle: vi.fn(async () => {
            calls.order.push("agents");
          }),
        },
        wikiSettleDelayMs: 0,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      } as unknown as Parameters<typeof createDebouncedUploadIngestPipelineDrain>[0],
      { debounceMs: 25 },
    );

    const event = (rawId: string) => ({
      input: {
        tenantId: "tnt_seed",
        actor: "usr_seed",
        sourceType: "csv_upload",
        sourceRef: { filename: `${rawId}.xlsx` },
        body: Buffer.from("xlsx"),
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      result: {
        rawId,
        sha256: "a".repeat(64),
        bytes: 4,
        sourceType: "csv_upload",
        sourceSchema: "brain.upload.document.v1",
        projectionStatus: "pending" as const,
        ingestedAt: "2026-07-25T00:00:00.000Z",
        deduplicated: false,
        extractionJob: null,
      },
    });

    await drain(event("raw_ar"));
    await drain(event("raw_payroll"));

    expect(calls.runInterpretCycle).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(24);
    expect(calls.runInterpretCycle).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(calls.runInterpretCycle).toHaveBeenCalledTimes(1);
    expect(calls.runNormalizeCycle).toHaveBeenCalledTimes(1);
    expect(calls.runProjectionCycle).toHaveBeenCalledTimes(1);
  });
});
