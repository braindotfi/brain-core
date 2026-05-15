import { beforeEach, describe, expect, it } from "vitest";
import { isBrainError, type ServiceCallContext } from "@brain/api/shared";
import {
  InMemorySourceRepository,
  SourceService,
} from "./SourceService.js";
import { SOURCE_TYPES, STUB_SOURCE_TYPES } from "./types.js";

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
  it("ships the 8 MVP values from docs/sdk-audit.md decision K2", () => {
    expect(SOURCE_TYPES).toEqual([
      "plaid",
      "stripe",
      "netsuite",
      "email_inbound",
      "csv_upload",
      "pdf_upload",
      "alchemy_wallet",
      "eth_address",
    ]);
  });

  it("classifies six types as stubs and two as concrete", () => {
    expect(STUB_SOURCE_TYPES.size).toBe(6);
    // Inverse: SOURCE_TYPES \ STUB_SOURCE_TYPES has 2 entries = concrete
    const concrete = SOURCE_TYPES.filter((t) => !STUB_SOURCE_TYPES.has(t));
    expect(concrete).toEqual(["plaid", "stripe"]);
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
    const other = await service.get(
      { ...CTX, tenantId: "tnt_other" },
      created.id,
    );
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
});

describe("SourceService.sync", () => {
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

  it("returns a job descriptor with `notes: \"stub\"` for stub sources", async () => {
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
});
