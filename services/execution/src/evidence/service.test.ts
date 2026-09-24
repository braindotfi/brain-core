import { describe, expect, it } from "vitest";
import {
  InMemoryAuditEmitter,
  newProposalId,
  newTenantId,
  newUserId,
  type ServiceCallContext,
} from "@brain/shared";
import type { Pool } from "pg";
import { InMemoryEvidenceBlobStore } from "./blob-store.js";
import { EvidenceStorageService } from "./service.js";

const TENANT = newTenantId();
const USER = newUserId();
const PROPOSAL = newProposalId();

function ctx(): ServiceCallContext {
  return {
    tenantId: TENANT,
    actor: USER,
    principalType: "user",
    scopes: ["execution:read", "execution:write"],
  };
}

describe("EvidenceStorageService", () => {
  it("uploads, lists, reads, and deletes evidence", async () => {
    const store = makeStore();
    const service = store.service;

    const uploaded = await service.upload(ctx(), {
      kind: "pdf",
      name: "Invoice PDF",
      content: Buffer.from("invoice"),
      mimeType: "application/pdf",
      proposalId: PROPOSAL,
    });

    expect(uploaded.evidence.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(uploaded.signedUrl).toMatch(/^memory:/);

    await expect(service.list(ctx(), { proposalId: PROPOSAL })).resolves.toHaveLength(1);
    await expect(service.get(ctx(), uploaded.evidence.id)).resolves.toMatchObject({
      evidence: { id: uploaded.evidence.id, name: "Invoice PDF" },
    });

    const deleted = await service.delete(ctx(), uploaded.evidence.id);
    expect(deleted.deletedAt).toBeInstanceOf(Date);
    expect(store.audit.events.map((event) => event.action)).toEqual([
      "evidence.uploaded",
      "evidence.downloaded",
      "evidence.deleted",
    ]);
  });

  it("registers external links without stored content", async () => {
    const { service } = makeStore();

    const result = await service.registerExternal(ctx(), {
      name: "Regulatory page",
      url: "https://example.test/ofac",
    });

    expect(result.evidence.kind).toBe("external");
    expect(result.evidence.sha256).toBeNull();
    expect(result.signedUrl).toBe("https://example.test/ofac");
  });

  it("detects tampered stored content on read", async () => {
    const store = makeStore();
    const uploaded = await store.service.upload(ctx(), {
      kind: "report",
      name: "OFAC report",
      content: Buffer.from("clean"),
      mimeType: "application/json",
    });
    store.blob.objects.set(uploaded.evidence.storageRef, Buffer.from("changed"));

    await expect(store.service.get(ctx(), uploaded.evidence.id)).rejects.toMatchObject({
      code: "evidence_tamper_detected",
    });
    expect(store.audit.events.at(-1)?.action).toBe("tamper_detected");
  });

  it("archives expired standard evidence and keeps it queryable", async () => {
    const store = makeStore();
    const uploaded = await store.service.upload(ctx(), {
      kind: "data",
      name: "Snapshot",
      content: Buffer.from("snapshot"),
      mimeType: "application/json",
    });
    store.rows[0]!.captured_at = new Date("2026-01-01T00:00:00.000Z");

    await expect(
      store.service.archiveExpiredStandard(ctx(), new Date("2026-05-01T00:00:00.000Z")),
    ).resolves.toBe(1);

    const listed = await store.service.list(ctx(), {});
    expect(listed[0]?.id).toBe(uploaded.evidence.id);
    expect(listed[0]?.archivedAt).toBeInstanceOf(Date);
  });

  it("refuses delete when evidence is attached to an open proposal", async () => {
    const store = makeStore({ openAttachment: true });
    const uploaded = await store.service.upload(ctx(), {
      kind: "record",
      name: "Transaction",
      content: Buffer.from("record"),
      mimeType: "application/json",
      proposalId: PROPOSAL,
    });

    await expect(store.service.delete(ctx(), uploaded.evidence.id)).rejects.toMatchObject({
      code: "evidence_delete_blocked",
    });
  });
});

interface Row {
  id: string;
  tenant_id: string;
  kind: string;
  name: string;
  source: string;
  storage_ref: string;
  sha256: string | null;
  mime_type: string;
  byte_size: string;
  captured_at: Date;
  captured_by: string;
  retention_class: string;
  metadata: Record<string, unknown>;
  archived_at: Date | null;
  deleted_at: Date | null;
  delete_reason: string | null;
  created_at: Date;
}

function makeStore(options: { openAttachment?: boolean } = {}) {
  const rows: Row[] = [];
  const links: Array<{ proposal_id: string; evidence_id: string }> = [];
  let tenant: string | null = null;
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("SELECT set_config")) {
        tenant = String(values[0]);
        return { rows: [], rowCount: 0 };
      }
      if (tenant !== TENANT) throw new Error("tenant scope was not set");
      if (sql.startsWith("INSERT INTO evidence")) {
        const row: Row = {
          id: String(values[0]),
          tenant_id: String(values[1]),
          kind: String(values[2]),
          name: String(values[3]),
          source: String(values[4]),
          storage_ref: String(values[5]),
          sha256: values[6] === null ? null : String(values[6]),
          mime_type: String(values[7]),
          byte_size: String(values[8]),
          captured_at: values[9] as Date,
          captured_by: String(values[10]),
          retention_class: String(values[11]),
          metadata: JSON.parse(String(values[12])) as Record<string, unknown>,
          archived_at: null,
          deleted_at: null,
          delete_reason: null,
          created_at: new Date(),
        };
        rows.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.startsWith("INSERT INTO proposal_evidence_links")) {
        links.push({ proposal_id: String(values[1]), evidence_id: String(values[2]) });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("FROM evidence") && sql.includes("WHERE id = $1")) {
        const row = rows.find((candidate) => candidate.id === values[0]);
        return { rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 };
      }
      if (sql.includes("FROM evidence e")) {
        const proposalId = values.find((value) => value === PROPOSAL);
        const filtered =
          proposalId === undefined
            ? rows
            : rows.filter((row) =>
                links.some(
                  (link) => link.proposal_id === proposalId && link.evidence_id === row.id,
                ),
              );
        return {
          rows: filtered.filter((row) => row.deleted_at === null),
          rowCount: filtered.length,
        };
      }
      if (
        sql.trimStart().startsWith("SELECT") &&
        sql.includes("FROM proposal_evidence_links pel") &&
        sql.includes("JOIN proposals")
      ) {
        return { rows: options.openAttachment === true ? [{ found: 1 }] : [], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE evidence") && sql.includes("delete_reason")) {
        const row = rows.find((candidate) => candidate.id === values[0]);
        if (row === undefined) return { rows: [], rowCount: 0 };
        row.deleted_at = new Date();
        row.delete_reason = String(values[1]);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes("UPDATE evidence e") && sql.includes("archived_at")) {
        const now = values[0] as Date;
        let count = 0;
        for (const row of rows) {
          if (row.archived_at === null && row.deleted_at === null) {
            row.archived_at = now;
            count += 1;
          }
        }
        return { rows: [], rowCount: count };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  const pool = { connect: async () => client } as unknown as Pool;
  const blob = new InMemoryEvidenceBlobStore();
  const audit = new InMemoryAuditEmitter();
  return { service: new EvidenceStorageService(pool, blob, audit), blob, audit, rows };
}
