import type { Pool } from "pg";
import { newCommercialShadowObservationId, withTenantScope } from "@brain/shared";
import { evaluateCommercialShadow, type CommercialShadowResult } from "./shadow.js";

interface CatalogRow {
  id: string;
  maximum_entities: number | null;
  maximum_agents: number | null;
  execution_limit_minor_units: string | number | bigint | null;
  api_unit_allowance: string | number | bigint;
  mcp_unit_allowance: string | number | bigint;
  api_reconciliation_run_id: string | null;
  api_reconciliation_status: "matched" | "mismatch" | "incomplete" | null;
  api_units: string | number | bigint | null;
  api_meter_persistence_failures: string | number | bigint | null;
  api_period_start: Date | string | null;
  api_period_end: Date | string | null;
  mcp_reconciliation_run_id: string | null;
  mcp_reconciliation_status: "matched" | "mismatch" | "incomplete" | null;
  mcp_units: string | number | bigint | null;
  mcp_meter_persistence_failures: string | number | bigint | null;
  mcp_period_start: Date | string | null;
  mcp_period_end: Date | string | null;
}

interface CountRow {
  entity_count: string | number | bigint;
  agent_count: string | number | bigint;
}

interface ExecutionRow {
  settled_minor_units: string | number | bigint;
  reserved_minor_units: string | number | bigint;
  unsupported_currency_count: string | number | bigint;
}

export interface CommercialShadowObservation {
  readonly id: string;
  readonly result: CommercialShadowResult;
  readonly entityCount: number;
  readonly countedAgentCount: number;
  readonly executionSettledMinorUnits: bigint;
  readonly executionReservedMinorUnits: bigint;
  readonly executionEvidenceComplete: boolean;
  readonly apiUnits: bigint;
  readonly mcpUnits: bigint;
  readonly apiEvidenceComplete: boolean;
  readonly mcpEvidenceComplete: boolean;
}

export class CommercialShadowRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly enabled: boolean,
  ) {}

  public async observe(input: {
    readonly tenantId: string;
    readonly shadowPeriodId: string;
  }): Promise<CommercialShadowObservation> {
    if (!this.enabled) {
      throw new Error("commercial shadow observation is disabled");
    }
    return withTenantScope(this.pool, input.tenantId, async (client) => {
      const contractResult = await client.query<CatalogRow>(
        `SELECT catalog.id, catalog.maximum_entities, catalog.maximum_agents,
                catalog.execution_limit_minor_units,
                contract.api_unit_allowance, contract.mcp_unit_allowance,
                api_run.id AS api_reconciliation_run_id,
                api_run.status AS api_reconciliation_status,
                api_run.raw_billable_units AS api_units,
                api_run.meter_persistence_failures AS api_meter_persistence_failures,
                api_run.period_start AS api_period_start,
                api_run.period_end AS api_period_end,
                mcp_run.id AS mcp_reconciliation_run_id,
                mcp_run.status AS mcp_reconciliation_status,
                mcp_run.raw_billable_units AS mcp_units,
                mcp_run.meter_persistence_failures AS mcp_meter_persistence_failures,
                mcp_run.period_start AS mcp_period_start,
                mcp_run.period_end AS mcp_period_end
           FROM commercial_shadow_contracts AS contract
           JOIN commercial_shadow_periods AS period
             ON period.id = contract.shadow_period_id
           JOIN api_commercial_tier_catalog AS catalog
             ON catalog.id = contract.catalog_revision_id
           LEFT JOIN LATERAL (
             SELECT reconciliation.id, reconciliation.status,
                    reconciliation.raw_billable_units,
                    reconciliation.meter_persistence_failures,
                    reconciliation.period_start, reconciliation.period_end
               FROM api_usage_reconciliation_runs AS reconciliation
              WHERE reconciliation.tenant_id = contract.tenant_id
                AND reconciliation.environment = contract.environment
                AND reconciliation.period_start = period.started_at
              ORDER BY reconciliation.period_end DESC, reconciliation.created_at DESC
              LIMIT 1
           ) AS api_run ON TRUE
           LEFT JOIN LATERAL (
             SELECT reconciliation.id, reconciliation.status,
                    reconciliation.raw_billable_units,
                    reconciliation.meter_persistence_failures,
                    reconciliation.period_start, reconciliation.period_end
               FROM mcp_usage_reconciliation_runs AS reconciliation
              WHERE reconciliation.tenant_id = contract.tenant_id
                AND reconciliation.shadow_period_id = contract.shadow_period_id
                AND reconciliation.environment = contract.environment
                AND reconciliation.period_start = period.started_at
                AND reconciliation.period_end = api_run.period_end
              ORDER BY reconciliation.created_at DESC
              LIMIT 1
           ) AS mcp_run ON TRUE
          WHERE contract.tenant_id = $1
            AND contract.shadow_period_id = $2
            AND period.state = 'running'
            AND period.completed_at IS NULL`,
        [input.tenantId, input.shadowPeriodId],
      );
      const countResult = await client.query<CountRow>(
        `SELECT
           (SELECT count(*) FROM robotmoney_entities
             WHERE tenant_id = $1 AND state IN ('active', 'capacity_paused')) AS entity_count,
           (SELECT count(*) FROM robotmoney_agent_instances
             WHERE tenant_id = $1
               AND lifecycle_state = 'active'
               AND system_bootstrap = FALSE
               AND demo_instance = FALSE) AS agent_count`,
        [input.tenantId],
      );
      const executionResult = await client.query<ExecutionRow>(
        `SELECT
           COALESCE(sum(round(amount * 100)::bigint) FILTER (
             WHERE status = 'executed' AND currency = 'USD'
           ), 0) AS settled_minor_units,
           COALESCE(sum(round(amount * 100)::bigint) FILTER (
             WHERE status = 'approved' AND currency = 'USD'
           ), 0) AS reserved_minor_units,
           count(*) FILTER (WHERE currency <> 'USD') AS unsupported_currency_count
         FROM ledger_payment_intents
         WHERE owner_id = $1
           AND action_type IN (
             'ach_outbound', 'ach_inbound', 'wire', 'onchain_transfer', 'card_payment'
           )
           AND status IN ('approved', 'executed')
           AND updated_at >= date_trunc('month', now())
           AND updated_at < date_trunc('month', now()) + interval '1 month'`,
        [input.tenantId],
      );

      const counts = requiredRow(countResult.rows[0], "commercial shadow counts");
      const execution = requiredRow(executionResult.rows[0], "commercial shadow execution");
      const entityCount = Number(counts.entity_count);
      const countedAgentCount = Number(counts.agent_count);
      const settled = BigInt(execution.settled_minor_units);
      const reserved = BigInt(execution.reserved_minor_units);
      const executionEvidenceComplete =
        entityCount === 1 && BigInt(execution.unsupported_currency_count) === 0n;
      const catalog = requiredRow(contractResult.rows[0], "commercial shadow contract");
      const apiUnits = BigInt(catalog.api_units ?? 0);
      const mcpUnits = BigInt(catalog.mcp_units ?? 0);
      const apiEvidenceComplete =
        catalog.api_reconciliation_run_id !== null &&
        catalog.api_reconciliation_status === "matched" &&
        BigInt(catalog.api_meter_persistence_failures ?? 0) === 0n;
      const mcpEvidenceComplete =
        catalog.mcp_reconciliation_run_id !== null &&
        catalog.mcp_reconciliation_status === "matched" &&
        BigInt(catalog.mcp_meter_persistence_failures ?? 0) === 0n &&
        sameInstant(catalog.api_period_start, catalog.mcp_period_start) &&
        sameInstant(catalog.api_period_end, catalog.mcp_period_end);
      const result = evaluateCommercialShadow({
        catalog: {
          catalogRevisionId: catalog.id,
          maximumEntities: catalog.maximum_entities,
          maximumAgents: catalog.maximum_agents,
          executionLimitMinorUnits:
            catalog.execution_limit_minor_units === null
              ? null
              : BigInt(catalog.execution_limit_minor_units),
          includedApiUnits: BigInt(catalog.api_unit_allowance),
          includedMcpUnits: BigInt(catalog.mcp_unit_allowance),
        },
        entityCount,
        countedAgentCount,
        executionSettledMinorUnits: settled,
        executionReservedMinorUnits: reserved,
        executionEvidenceComplete,
        apiUnits,
        mcpUnits,
        apiEvidenceComplete,
        mcpEvidenceComplete,
      });
      const observationId = newCommercialShadowObservationId();
      await client.query(
        `INSERT INTO commercial_shadow_observations (
           id, tenant_id, shadow_period_id, catalog_revision_id, catalog_resolution,
           entity_count, counted_agent_count, execution_settled_minor_units,
           execution_reserved_minor_units, entity_capacity_result,
           agent_capacity_result, execution_limit_result, api_units, mcp_units,
           api_unit_result, mcp_unit_result, api_evidence_complete,
           mcp_evidence_complete, api_reconciliation_run_id,
           mcp_reconciliation_run_id, divergence_codes, evidence,
           enforcement_applied
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
           $14, $15, $16, $17, $18, $19, $20, $21, $22::jsonb, FALSE
         )`,
        [
          observationId,
          input.tenantId,
          input.shadowPeriodId,
          result.catalogRevisionId,
          result.catalogResolution,
          entityCount,
          countedAgentCount,
          settled.toString(),
          reserved.toString(),
          result.entityCapacityResult,
          result.agentCapacityResult,
          result.executionLimitResult,
          apiUnits.toString(),
          mcpUnits.toString(),
          result.apiUnitResult,
          result.mcpUnitResult,
          apiEvidenceComplete,
          mcpEvidenceComplete,
          catalog.api_reconciliation_run_id,
          catalog.mcp_reconciliation_run_id,
          [...result.divergenceCodes],
          JSON.stringify({
            contract_source: "commercial_shadow_contracts",
            catalog_source: "commercial_shadow_contracts.catalog_revision_id",
            entity_source: "robotmoney_entities",
            agent_source: "robotmoney_agent_instances",
            execution_source: "ledger_payment_intents",
            unsupported_currency_count: String(execution.unsupported_currency_count),
            api_source: "api_usage_reconciliation_runs.raw_billable_units",
            api_reconciliation_run_id: catalog.api_reconciliation_run_id,
            api_reconciliation_status: catalog.api_reconciliation_status,
            mcp_source: "mcp_usage_reconciliation_runs.raw_billable_units",
            mcp_reconciliation_run_id: catalog.mcp_reconciliation_run_id,
            mcp_reconciliation_status: catalog.mcp_reconciliation_status,
          }),
        ],
      );
      return {
        id: observationId,
        result,
        entityCount,
        countedAgentCount,
        executionSettledMinorUnits: settled,
        executionReservedMinorUnits: reserved,
        executionEvidenceComplete,
        apiUnits,
        mcpUnits,
        apiEvidenceComplete,
        mcpEvidenceComplete,
      };
    });
  }
}

function sameInstant(left: Date | string | null, right: Date | string | null): boolean {
  if (left === null || right === null) return false;
  return new Date(left).getTime() === new Date(right).getTime();
}

function requiredRow<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} query returned no row`);
  return value;
}
