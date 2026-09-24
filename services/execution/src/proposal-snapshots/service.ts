import { randomUUID } from "node:crypto";
import {
  brainError,
  canonicalJsonSha256,
  withTenantScope,
  type ServiceCallContext,
  type TenantScopedClient,
} from "@brain/shared";
import type { Pool } from "pg";

export interface ProposalSnapshot {
  id: string;
  tenant_id: string;
  payload: Record<string, unknown>;
  payload_sha256: string;
  created_by: string;
  created_at: string;
}

export class ProposalSnapshotService {
  public constructor(private readonly pool: Pool) {}

  public async create(
    ctx: ServiceCallContext,
    payload: Record<string, unknown>,
  ): Promise<ProposalSnapshot> {
    return withTenantScope(this.pool, ctx.tenantId, (client) =>
      insertProposalSnapshot(client, ctx, payload),
    );
  }

  public async get(ctx: ServiceCallContext, id: string): Promise<ProposalSnapshot | null> {
    return withTenantScope(this.pool, ctx.tenantId, async (client) => {
      const { rows } = await client.query<SnapshotRow>(
        `SELECT *
           FROM proposal_payload_snapshots
          WHERE id = $1
            AND tenant_id = current_setting('app.tenant_id', true)`,
        [id],
      );
      const row = rows[0];
      return row === undefined ? null : snapshotFromRow(row);
    });
  }
}

export async function insertProposalSnapshot(
  client: TenantScopedClient,
  ctx: ServiceCallContext,
  payload: Record<string, unknown>,
): Promise<ProposalSnapshot> {
  assertPayload(payload);
  const { rows } = await client.query<SnapshotRow>(
    `INSERT INTO proposal_payload_snapshots (
       id, tenant_id, payload, payload_sha256, created_by
     )
     VALUES ($1, current_setting('app.tenant_id', true), $2::jsonb, $3, $4)
     RETURNING *`,
    [randomUUID(), JSON.stringify(payload), canonicalJsonSha256(payload), ctx.actor],
  );
  return snapshotFromRow(rows[0]!);
}

interface SnapshotRow {
  id: string;
  tenant_id: string;
  payload: Record<string, unknown>;
  payload_sha256: string;
  created_by: string;
  created_at: Date;
}

function snapshotFromRow(row: SnapshotRow): ProposalSnapshot {
  return {
    ...row,
    created_at: row.created_at.toISOString(),
  };
}

function assertPayload(payload: unknown): asserts payload is Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw brainError("request_body_invalid", "payload must be an object");
  }
}
