import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  newTenantId,
  type AuditEmitter,
  type AuditEvent,
  type BlobAdapter,
  type ServiceCallContext,
} from "@brain/shared";
import type { Pool } from "pg";
import { DecisionAuditLogEmitter, DecisionAuditLogService } from "./service.js";

const TENANT = newTenantId();

function ctx(): ServiceCallContext {
  return { tenantId: TENANT, actor: "user_01TEST00000000000000000000", scopes: ["execution:read"] };
}

describe("DecisionAuditLogService", () => {
  it("consumes decision event types into the audit log", async () => {
    const db = fakeDb();
    const service = new DecisionAuditLogService(db.pool);

    for (const action of [
      "decision.executed",
      "decision.proposed",
      "decision.auto_executed",
      "decision.escalated",
    ]) {
      await service.consume(event(action, `evt_${action}`));
    }

    const listed = await service.list(ctx(), { limit: 10 });
    expect(listed.entries.map((entry) => entry.event_action).sort()).toEqual([
      "decision.auto_executed",
      "decision.escalated",
      "decision.executed",
      "decision.proposed",
    ]);
  });

  it("filters by actor type, agent, decision, and time", async () => {
    const db = fakeDb();
    const service = new DecisionAuditLogService(db.pool);
    await service.consume(event("decision.executed", "evt_1"));
    await service.consume({
      ...event("decision.executed", "evt_2"),
      actor: "system:rules-engine",
      inputs: { proposal_id: "prop_2", decision: "confirm_all_matches" },
      outputs: { agent: "reconciliation", outcome: "close_confirmed" },
    });

    const filtered = await service.list(ctx(), {
      actor_type: "system",
      agent: "reconciliation",
      decision: "confirm_all_matches",
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-03T00:00:00.000Z",
    });

    expect(filtered.entries).toHaveLength(1);
    expect(filtered.entries[0]).toMatchObject({
      actor: { type: "system" },
      agent: "reconciliation",
      decision: "confirm_all_matches",
    });
  });

  it("exports CSV through object storage", async () => {
    const db = fakeDb();
    const blob = fakeBlob();
    const service = new DecisionAuditLogService(db.pool, blob);
    await service.consume(event("decision.executed", "evt_1"));

    const exported = await service.exportCsv(ctx(), {});

    expect(exported.count).toBe(1);
    expect(exported.url).toContain("signed:");
    expect(blob.put).toHaveBeenCalled();
  });

  it("archives old rows while keeping them readable", async () => {
    const db = fakeDb();
    const service = new DecisionAuditLogService(db.pool, fakeBlob());
    await service.consume(event("decision.executed", "evt_1"));

    await expect(
      service.archiveOlderThan(ctx(), new Date("2026-02-01T00:00:00.000Z")),
    ).resolves.toBe(1);
    const listed = await service.list(ctx(), {});
    expect(listed.entries[0]?.archived_at).not.toBeNull();
  });

  it("wraps an audit emitter and consumes decision events", async () => {
    const db = fakeDb();
    const auditLog = new DecisionAuditLogService(db.pool);
    const inner: AuditEmitter = {
      emit: vi.fn(async (input) => event(input.action, "evt_wrapped")),
    };
    const emitter = new DecisionAuditLogEmitter(inner, auditLog);

    await emitter.emit(event("decision.executed", "evt_wrapped"));

    expect((await auditLog.list(ctx(), {})).entries).toHaveLength(1);
  });
});

function event(action: string, id: string): AuditEvent {
  return {
    id,
    tenantId: TENANT,
    layer: "agent",
    actor: "user_01TEST00000000000000000000",
    action,
    inputs: { proposal_id: "prop_1", decision: "approve" },
    outputs: { agent: "vendor_risk", outcome: "approved" },
    createdAt: "2026-01-02T00:00:00.000Z",
    eventHash: "hash",
    prevEventHash: null,
  };
}

function fakeBlob(): BlobAdapter {
  return {
    put: vi.fn(async (path) => ({
      uri: String(path),
      bytes: 1,
      sha256: "hash",
      mimeType: "text/csv",
    })),
    get: vi.fn(async () => Readable.from([])),
    signedUrl: vi.fn(async (path) => `signed:${path}`),
    tombstone: vi.fn(async () => undefined),
    purgeTenant: vi.fn(async () => ({ deleted: 0, failures: [] })),
    purgeObject: vi.fn(async () => undefined),
    healthcheck: vi.fn(async () => true),
  } as unknown as BlobAdapter;
}

function fakeDb(): { pool: Pool } {
  let tenant: string | null = null;
  const entries: Array<Record<string, unknown>> = [];
  const snapshots: Array<Record<string, unknown>> = [];
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK")
        return { rows: [], rowCount: 0 };
      if (sql.startsWith("SELECT set_config")) {
        tenant = values[0] as string;
        return { rows: [], rowCount: 0 };
      }
      if (tenant !== TENANT) throw new Error("tenant scope missing");
      if (sql.includes("FROM decision_audit_log") && sql.includes("event_id")) {
        return { rows: entries.filter((entry) => entry.event_id === values[0]), rowCount: 0 };
      }
      if (sql.includes("INSERT INTO proposal_payload_snapshots")) {
        const row = {
          id: values[0],
          tenant_id: TENANT,
          payload: JSON.parse(values[1] as string),
          payload_sha256: values[2],
          created_by: values[3],
          created_at: new Date("2026-01-02T00:00:00.000Z"),
        };
        snapshots.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO decision_audit_log_archive_runs")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO decision_audit_log")) {
        entries.push({
          id: values[0],
          tenant_id: TENANT,
          occurred_at: new Date(values[1] as string),
          actor: JSON.parse(values[2] as string),
          proposal_id: values[3],
          agent: values[4],
          decision: values[5],
          outcome: JSON.parse(values[6] as string),
          policy_context: JSON.parse(values[7] as string),
          payload_snapshot_id: values[8],
          event_id: values[9],
          event_action: values[10],
          archived_at: null,
          cold_storage_uri: null,
          created_at: new Date("2026-01-02T00:00:00.000Z"),
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE decision_audit_log")) {
        for (const entry of entries) entry.archived_at = new Date("2026-02-01T00:00:00.000Z");
        return { rows: [], rowCount: entries.length };
      }
      if (sql.includes("FROM decision_audit_log")) {
        let filtered = entries;
        if (sql.includes("actor->>'type'")) {
          filtered = filtered.filter((entry) => {
            const actor = entry.actor as { type: string };
            return actor.type === "system";
          });
        }
        if (sql.includes("agent =")) {
          filtered = filtered.filter((entry) => entry.agent === "reconciliation");
        }
        if (sql.includes("decision =")) {
          filtered = filtered.filter((entry) => entry.decision === "confirm_all_matches");
        }
        return { rows: filtered, rowCount: filtered.length };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  return { pool: { connect: async () => client } as unknown as Pool };
}
