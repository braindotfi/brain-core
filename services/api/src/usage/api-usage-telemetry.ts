import type { Pool } from "pg";
import {
  withTenantScope,
  type ApiKeyGatewayTelemetryEvent,
  type ApiKeyMeterFailureTelemetryEvent,
} from "@brain/shared";

/**
 * Durable reconciliation evidence written independently from the request
 * meter. Gateway observations are awaited before request handling, so a
 * successful commercial request can never outrun its independent count.
 */
export class PostgresApiUsageTelemetry {
  public constructor(private readonly pool: Pool) {}

  public async recordGateway(event: ApiKeyGatewayTelemetryEvent): Promise<void> {
    await withTenantScope(this.pool, event.tenantId, (client) =>
      client.query(
        `INSERT INTO api_gateway_request_observations (
           tenant_id, request_id, key_id, environment, occurred_at,
           limiter_decision
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, request_id) DO NOTHING`,
        [
          event.tenantId,
          event.requestId,
          event.keyId,
          event.environment,
          event.occurredAt,
          event.limiterDecision,
        ],
      ),
    );
  }

  public async recordMeterFailure(event: ApiKeyMeterFailureTelemetryEvent): Promise<void> {
    await withTenantScope(this.pool, event.tenantId, (client) =>
      client.query(
        `INSERT INTO api_meter_persistence_failure_events (
           tenant_id, request_id, key_id, environment, occurred_at
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, request_id) DO NOTHING`,
        [event.tenantId, event.requestId, event.keyId, event.environment, event.occurredAt],
      ),
    );
  }
}
