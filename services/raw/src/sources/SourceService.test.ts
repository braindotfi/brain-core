import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryAuditEmitter, isBrainError, type ServiceCallContext } from "@brain/shared";
import { InMemorySourceRepository, SourceService } from "./SourceService.js";
import { CONCRETE_SOURCE_TYPES, recordToWire, SOURCE_TYPES, STUB_SOURCE_TYPES } from "./types.js";

const CTX: ServiceCallContext = {
  tenantId: "tnt_acme",
  actor: "user_test",
  requestId: "req_x",
};

let service: SourceService;

beforeEach(() => {
  service = new SourceService(new InMemorySourceRepository());
});

describe("SOURCE_TYPES coverage", () => {
  it("includes the 8 MVP values from docs/sdk-audit.md decision K2", () => {
    // The set is extensible by the connector scaffold (ingestion
    // architecture Phase 1); the K2 MVP values must always remain.
    expect(SOURCE_TYPES).toEqual(
      expect.arrayContaining([
        "plaid",
        "stripe",
        "netsuite",
        "email_inbound",
        "csv_upload",
        "pdf_upload",
        "alchemy_wallet",
        "eth_address",
      ]),
    );
  });

  it("partitions every source type into exactly stub or concrete", () => {
    for (const t of SOURCE_TYPES) {
      expect(STUB_SOURCE_TYPES.has(t) !== CONCRETE_SOURCE_TYPES.has(t)).toBe(true);
    }
    expect([...CONCRETE_SOURCE_TYPES]).toEqual(expect.arrayContaining(["plaid", "stripe"]));
  });
});

describe("SourceService.connect", () => {
  it("creates a Plaid source with valid credentials", async () => {
    const src = await service.connect(CTX, {
      type: "plaid",
      credentials: { access_token: "access-test-abc" },
      metadata: { label: "Mercury operating account" },
    });
    expect(src.id).toMatch(/^src_/);
    expect(src.tenant_id).toBe("tnt_acme");
    expect(src.type).toBe("plaid");
    expect(src.status).toBe("active");
    expect(src.is_stub).toBe(false);
    expect(src.metadata).toEqual({ label: "Mercury operating account" });
  });

  it("rejects Plaid with missing access_token (source_credential_invalid)", async () => {
    try {
      await service.connect(CTX, {
        type: "plaid",
        credentials: {},
      });
      throw new Error("expected throw");
    } catch (e) {
      expect(isBrainError(e)).toBe(true);
      expect((e as { code: string }).code).toBe("source_credential_invalid");
    }
  });

  it("rejects Stripe with malformed api_key", async () => {
    try {
      await service.connect(CTX, {
        type: "stripe",
        credentials: { api_key: "totally_wrong" },
      });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as { code: string }).code).toBe("source_credential_invalid");
    }
  });

  it("accepts every stub source type without validating credentials", async () => {
    for (const t of [...STUB_SOURCE_TYPES]) {
      const src = await service.connect(CTX, {
        type: t,
        credentials: {},
      });
      expect(src.is_stub).toBe(true);
      expect(src.status).toBe("active");
    }
  });

  it("emits is_stub=false for concrete types", async () => {
    const src = await service.connect(CTX, {
      type: "stripe",
      credentials: { api_key: "sk_test_xyz" },
    });
    expect(src.is_stub).toBe(false);
  });
});

describe("SourceService.get / list", () => {
  it("get returns null for non-existent ids", async () => {
    expect(await service.get(CTX, "src_missing")).toBeNull();
  });

  it("get scopes by tenant — different tenant cannot read", async () => {
    const created = await service.connect(CTX, {
      type: "plaid",
      credentials: { access_token: "x" },
    });
    const other = await service.get({ ...CTX, tenantId: "tnt_other" }, created.id);
    expect(other).toBeNull();
  });

  it("list filters by type and status", async () => {
    await service.connect(CTX, {
      type: "plaid",
      credentials: { access_token: "p1" },
    });
    await service.connect(CTX, {
      type: "stripe",
      credentials: { api_key: "sk_test_1" },
    });
    const stripeOnly = await service.list(CTX, { type: "stripe" });
    expect(stripeOnly).toHaveLength(1);
    expect(stripeOnly[0]?.type).toBe("stripe");
  });
});

describe("recordToWire source freshness", () => {
  it("derives freshness from status and last_synced_at", async () => {
    const src = await service.connect(CTX, {
      type: "plaid",
      credentials: { access_token: "x" },
    });
    const now = new Date("2026-07-18T12:00:00.000Z");

    expect(recordToWire(src, now).freshness).toBe("never_synced");
    expect(
      recordToWire({ ...src, last_synced_at: "2026-07-18T11:30:00.000Z" }, now).freshness,
    ).toBe("fresh");
    expect(
      recordToWire({ ...src, last_synced_at: "2026-07-16T11:30:00.000Z" }, now).freshness,
    ).toBe("stale");
    expect(recordToWire({ ...src, status: "error", error_message: "timeout" }, now).freshness).toBe(
      "error",
    );
  });
});

describe("SourceService.disconnect", () => {
  it("moves status to disconnected", async () => {
    const src = await service.connect(CTX, {
      type: "plaid",
      credentials: { access_token: "x" },
    });
    const dc = await service.disconnect(CTX, src.id);
    expect(dc?.status).toBe("disconnected");
  });

  it("returns null when source is missing", async () => {
    expect(await service.disconnect(CTX, "src_missing")).toBeNull();
  });

  it("emits source status changes when audit is configured", async () => {
    const repo = new InMemorySourceRepository();
    const audit = new InMemoryAuditEmitter();
    const svc = new SourceService(repo, undefined, audit);
    const src = await svc.connect(CTX, {
      type: "plaid",
      credentials: { access_token: "x" },
    });

    await svc.disconnect(CTX, src.id);

    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      tenantId: CTX.tenantId,
      actor: CTX.actor,
      layer: "raw",
      action: "raw.source.status_changed",
      inputs: { source_id: src.id, source_type: "plaid" },
      outputs: {
        before: { status: "active" },
        after: { status: "disconnected" },
      },
    });
  });
});

describe("SourceService.sync", () => {
  it("persists a sync job that can be polled by id", async () => {
    const repo = new InMemorySourceRepository();
    const svc = new SourceService(repo, undefined, undefined, repo);
    const src = await svc.connect(CTX, {
      type: "plaid",
      credentials: { access_token: "x" },
    });

    const job = await svc.sync(CTX, src.id);
    expect(job).not.toBeNull();
    const stored = await svc.getSyncJob(CTX, job!.job_id);
    expect(stored).toMatchObject({
      job_id: job!.job_id,
      source_id: src.id,
      status: "enqueued",
    });
  });

  it("returns a job descriptor for concrete sources without `notes`", async () => {
    const src = await service.connect(CTX, {
      type: "plaid",
      credentials: { access_token: "x" },
    });
    const job = await service.sync(CTX, src.id);
    expect(job?.source_id).toBe(src.id);
    expect(job?.job_id).toMatch(/^sjob_/);
    expect(job?.status).toBe("enqueued");
    expect(job?.notes).toBeUndefined();
  });

  it('returns a job descriptor with `notes: "stub"` for stub sources', async () => {
    const src = await service.connect(CTX, {
      type: "netsuite",
      credentials: {},
    });
    const job = await service.sync(CTX, src.id);
    expect(job?.notes).toBe("stub");
  });

  it("refuses to sync a disconnected source", async () => {
    const src = await service.connect(CTX, {
      type: "plaid",
      credentials: { access_token: "x" },
    });
    await service.disconnect(CTX, src.id);
    try {
      await service.sync(CTX, src.id);
      throw new Error("expected throw");
    } catch (e) {
      expect((e as { code: string }).code).toBe("source_not_found");
    }
  });

  it("updates last_synced_at after a successful sync", async () => {
    const src = await service.connect(CTX, {
      type: "plaid",
      credentials: { access_token: "x" },
    });
    expect(src.last_synced_at).toBeNull();
    await service.sync(CTX, src.id);
    const after = await service.get(CTX, src.id);
    expect(after?.last_synced_at).not.toBeNull();
  });

  it("returns null when a source is missing", async () => {
    await expect(service.sync(CTX, "src_missing")).resolves.toBeNull();
  });

  it("emits source freshness changes on sync", async () => {
    const repo = new InMemorySourceRepository();
    const audit = new InMemoryAuditEmitter();
    const svc = new SourceService(repo, undefined, audit, repo);
    const src = await svc.connect(CTX, {
      type: "plaid",
      credentials: { access_token: "x" },
    });

    await svc.sync(CTX, src.id);

    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      tenantId: CTX.tenantId,
      actor: CTX.actor,
      layer: "raw",
      action: "raw.source.status_changed",
      inputs: { source_id: src.id, source_type: "plaid" },
      outputs: {
        before: { status: "active", last_synced_at: null },
        after: { status: "active" },
      },
    });
    expect(
      (audit.events[0]?.outputs as { after?: { last_synced_at?: string | null } }).after
        ?.last_synced_at,
    ).not.toBeNull();
  });

  it("returns null for sync jobs when no sync-job repository is configured", async () => {
    await expect(service.getSyncJob(CTX, "sjob_missing")).resolves.toBeNull();
  });
});
