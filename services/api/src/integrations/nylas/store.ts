import { withTenantScope, type ServiceCallContext, type TenantScopedClient } from "@brain/shared";
import type { Pool } from "pg";
import type { NylasAdapter, NylasGrant } from "./adapter.js";

export interface NylasGrantRow {
  readonly tenant_id: string;
  readonly grant_id: string;
  readonly provider: "gmail" | "outlook" | "imap";
  readonly email: string;
  readonly scope: string[];
  readonly connected_at: Date;
  readonly disconnected_at: Date | null;
}

export class NylasGrantStore {
  public constructor(
    private readonly pool: Pool,
    private readonly adapter?: NylasAdapter,
  ) {}

  public async get(ctx: ServiceCallContext): Promise<NylasGrantRow | null> {
    return withTenantScope(this.pool, ctx.tenantId, (client) => getGrant(client));
  }

  public async upsert(ctx: ServiceCallContext, grant: NylasGrant): Promise<NylasGrantRow> {
    return withTenantScope(this.pool, ctx.tenantId, async (client) => {
      const existing = await getGrant(client);
      if (existing !== null && existing.grant_id !== grant.grantId) {
        await this.adapter?.disconnect({ grantId: existing.grant_id });
      }
      const { rows } = await client.query<NylasGrantRow>(
        `INSERT INTO nylas_grants (
           tenant_id, grant_id, provider, email, scope, connected_at, disconnected_at
         )
         VALUES (current_setting('app.tenant_id', true), $1, $2, $3, $4::text[], now(), NULL)
         ON CONFLICT (tenant_id) DO UPDATE SET
           grant_id = EXCLUDED.grant_id,
           provider = EXCLUDED.provider,
           email = EXCLUDED.email,
           scope = EXCLUDED.scope,
           connected_at = now(),
           disconnected_at = NULL
         RETURNING *`,
        [grant.grantId, grant.provider, grant.email, grant.scope],
      );
      return rows[0]!;
    });
  }

  public async disconnect(ctx: ServiceCallContext): Promise<void> {
    return withTenantScope(this.pool, ctx.tenantId, async (client) => {
      const existing = await getGrant(client);
      if (existing !== null) await this.adapter?.disconnect({ grantId: existing.grant_id });
      await client.query(
        `UPDATE nylas_grants
            SET disconnected_at = now()
          WHERE tenant_id = current_setting('app.tenant_id', true)
            AND disconnected_at IS NULL`,
      );
    });
  }
}

export async function getGrant(client: TenantScopedClient): Promise<NylasGrantRow | null> {
  const { rows } = await client.query<NylasGrantRow>(
    `SELECT *
       FROM nylas_grants
      WHERE tenant_id = current_setting('app.tenant_id', true)
        AND disconnected_at IS NULL
      LIMIT 1`,
  );
  return rows[0] ?? null;
}
