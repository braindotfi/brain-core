import type { Pool } from "pg";
import { newCommercialShadowObservationId, withTenantScope } from "@brain/shared";
import { evaluateCommercialShadow, type CommercialShadowResult } from "./shadow.js";

interface CatalogRow {
  id: string;
  maximum_entities: number | null;
  maximum_agents: number | null;
  execution_limit_minor_units: string | number | bigint | null;
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
      const catalogResult = await client.query<CatalogRow>(
        `SELECT catalog.id, catalog.maximum_entities, catalog.maximum_agents,
                catalog.execution_limit_minor_units
           FROM tenant_commercial_entitlements AS entitlement
           JOIN api_commercial_tier_catalog AS catalog
             ON catalog.id = entitlement.catalog_revision_id
          WHERE entitlement.tenant_id = $1
            AND entitlement.lifecycle_status IN ('active', 'restricted')
          LIMIT 1`,
        [input.tenantId],
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
      const catalog = catalogResult.rows[0];
      const result = evaluateCommercialShadow({
        catalog:
          catalog === undefined
            ? null
            : {
                catalogRevisionId: catalog.id,
                maximumEntities: catalog.maximum_entities,
                maximumAgents: catalog.maximum_agents,
                executionLimitMinorUnits:
                  catalog.execution_limit_minor_units === null
                    ? null
                    : BigInt(catalog.execution_limit_minor_units),
              },
        entityCount,
        countedAgentCount,
        executionSettledMinorUnits: settled,
        executionReservedMinorUnits: reserved,
        executionEvidenceComplete,
      });
      const observationId = newCommercialShadowObservationId();
      await client.query(
        `INSERT INTO commercial_shadow_observations (
           id, tenant_id, shadow_period_id, catalog_revision_id, catalog_resolution,
           entity_count, counted_agent_count, execution_settled_minor_units,
           execution_reserved_minor_units, entity_capacity_result,
           agent_capacity_result, execution_limit_result, divergence_codes,
           evidence, enforcement_applied
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
           $14::jsonb, FALSE
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
          [...result.divergenceCodes],
          JSON.stringify({
            catalog_source: catalog === undefined ? "unresolved" : "tenant_commercial_entitlements",
            entity_source: "robotmoney_entities",
            agent_source: "robotmoney_agent_instances",
            execution_source: "ledger_payment_intents",
            unsupported_currency_count: String(execution.unsupported_currency_count),
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
      };
    });
  }
}

function requiredRow<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} query returned no row`);
  return value;
}
