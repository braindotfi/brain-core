import type { Pool } from "pg";
import { newMcpToolMeterEventId, withTenantScope, type Principal } from "@brain/shared";

export const MCP_SHADOW_METERING_POLICY = "mcp_tools_v1_shadow" as const;

export type McpToolMeterOutcome =
  | "success"
  | "client_error"
  | "server_error"
  | "scope_rejected"
  | "auth_rejected"
  | "rate_limited";

export interface McpTransportObservation {
  readonly requestId: string;
  readonly principal: Principal;
  readonly toolName: string;
  readonly limiterDecision: boolean;
  readonly occurredAt: Date;
}

export interface McpShadowBinding {
  readonly tenantId: string;
  readonly shadowPeriodId: string;
  readonly environment: "sandbox" | "live";
  readonly requestId: string;
  readonly principalType: "agent" | "user";
  readonly principalId: string;
  readonly toolName: string;
  readonly occurredAt: Date;
}

export interface McpToolMeterEvent {
  readonly binding: McpShadowBinding;
  readonly statusCode: number;
  readonly outcome: McpToolMeterOutcome;
  readonly rejectionReason: string | null;
}

export interface McpShadowMetering {
  observeTransport(event: McpTransportObservation): Promise<McpShadowBinding | null>;
  recordTool(event: McpToolMeterEvent): Promise<void>;
  recordMeterFailure(binding: McpShadowBinding): Promise<void>;
}

interface BindingRow {
  shadow_period_id: string;
}

export class PostgresMcpShadowMetering implements McpShadowMetering {
  public constructor(
    private readonly pool: Pool,
    private readonly targetTenantId: string,
    private readonly environment: "sandbox" | "live",
  ) {}

  public async observeTransport(event: McpTransportObservation): Promise<McpShadowBinding | null> {
    if (event.principal.tenantId !== this.targetTenantId) return null;
    if (event.principal.type !== "agent" && event.principal.type !== "user") return null;
    const principalType = event.principal.type;

    return withTenantScope(this.pool, event.principal.tenantId, async (client) => {
      const result = await client.query<BindingRow>(
        `WITH active_contract AS (
           SELECT contract.tenant_id, contract.shadow_period_id, contract.environment
             FROM commercial_shadow_contracts AS contract
             JOIN commercial_shadow_periods AS period
               ON period.id = contract.shadow_period_id
            WHERE contract.tenant_id = $1
              AND contract.environment = $8
              AND period.started_at <= $7
              AND period.state = 'running'
              AND period.completed_at IS NULL
         ), inserted AS (
           INSERT INTO mcp_transport_tool_observations (
           tenant_id, request_id, shadow_period_id, environment, principal_type,
           principal_id, tool_name, limiter_decision, occurred_at
         )
         SELECT contract.tenant_id, $2, contract.shadow_period_id, contract.environment,
                $3, $4, $5, $6, $7
           FROM active_contract AS contract
         ON CONFLICT (tenant_id, request_id) DO NOTHING
         RETURNING shadow_period_id
         )
         SELECT shadow_period_id FROM inserted
         UNION ALL
         SELECT observation.shadow_period_id
           FROM mcp_transport_tool_observations AS observation
           JOIN active_contract AS contract
             ON contract.tenant_id = observation.tenant_id
            AND contract.shadow_period_id = observation.shadow_period_id
          WHERE observation.tenant_id = $1 AND observation.request_id = $2
         LIMIT 1`,
        [
          event.principal.tenantId,
          event.requestId,
          principalType,
          event.principal.id,
          event.toolName,
          event.limiterDecision,
          event.occurredAt,
          this.environment,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("active tenant-bound commercial shadow contract is missing");
      }
      return {
        tenantId: event.principal.tenantId,
        shadowPeriodId: row.shadow_period_id,
        environment: this.environment,
        requestId: event.requestId,
        principalType,
        principalId: event.principal.id,
        toolName: event.toolName,
        occurredAt: event.occurredAt,
      };
    });
  }

  public async recordTool(event: McpToolMeterEvent): Promise<void> {
    const { binding } = event;
    await withTenantScope(this.pool, binding.tenantId, (client) =>
      client.query(
        `INSERT INTO mcp_tool_meter_events (
           id, tenant_id, request_id, shadow_period_id, environment,
           principal_type, principal_id, tool_name, status_code, outcome,
           rejection_reason, metering_policy_version, billable_units, occurred_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
           $12, $13, $14
         )
         ON CONFLICT (tenant_id, request_id) DO NOTHING`,
        [
          newMcpToolMeterEventId(),
          binding.tenantId,
          binding.requestId,
          binding.shadowPeriodId,
          binding.environment,
          binding.principalType,
          binding.principalId,
          binding.toolName,
          event.statusCode,
          event.outcome,
          event.rejectionReason,
          MCP_SHADOW_METERING_POLICY,
          event.outcome === "success" ? 1 : 0,
          binding.occurredAt,
        ],
      ),
    );
  }

  public async recordMeterFailure(binding: McpShadowBinding): Promise<void> {
    await withTenantScope(this.pool, binding.tenantId, (client) =>
      client.query(
        `INSERT INTO mcp_meter_persistence_failure_events (
           tenant_id, request_id, shadow_period_id, environment, occurred_at,
           failure_class
         ) VALUES ($1, $2, $3, $4, $5, 'meter_append_failed')
         ON CONFLICT (tenant_id, request_id) DO NOTHING`,
        [
          binding.tenantId,
          binding.requestId,
          binding.shadowPeriodId,
          binding.environment,
          binding.occurredAt,
        ],
      ),
    );
  }
}
