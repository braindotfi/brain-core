import type { Pool } from "pg";
import { newApiRequestMeterEventId, withTenantScope, type ApiRequestMeter } from "@brain/shared";

export class PostgresApiRequestMeter implements ApiRequestMeter {
  public constructor(private readonly pool: Pool) {}

  public async record(event: Parameters<ApiRequestMeter["record"]>[0]): Promise<void> {
    await withTenantScope(this.pool, event.tenantId, async (client) => {
      await client.query(
        `INSERT INTO api_request_meter_events (
           id, request_id, tenant_id, key_id, occurred_at, environment, access_stage,
           method, route_template, operation_id, required_scope, product_family,
           status_code, outcome, rejection_reason, rate_limit_count,
           rate_limit_value, rate_limit_window_seconds
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
           $15, $16, $17, $18
         )
         ON CONFLICT (tenant_id, request_id) DO NOTHING`,
        [
          newApiRequestMeterEventId(),
          event.requestId,
          event.tenantId,
          event.keyId,
          event.occurredAt,
          event.environment,
          event.accessStage,
          event.method,
          event.routeTemplate,
          event.operationId,
          event.requiredScope,
          event.productFamily,
          event.statusCode,
          event.outcome,
          event.rejectionReason,
          event.rateLimitCount,
          event.rateLimitValue,
          event.rateLimitWindowSeconds,
        ],
      );
    });
  }
}
