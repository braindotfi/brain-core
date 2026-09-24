import { randomUUID } from "node:crypto";
import {
  brainError,
  withTenantScope,
  type ServiceCallContext,
  type TenantScopedClient,
} from "@brain/shared";
import type { Pool } from "pg";

export const RULE_AGENTS = [
  "fraud_anomaly",
  "vendor_risk",
  "dispute",
  "aml_compliance",
  "payment",
  "collections",
  "treasury",
  "subscription_management",
  "invoice_integrity",
  "reconciliation",
  "cash_forecast",
  "revenue_intel",
] as const;

export type RuleAgent = (typeof RULE_AGENTS)[number];
export type RuleAuthority = "auto" | "propose" | "deny";

export interface AgentAuthorityRule {
  id: string;
  tenant_id: string;
  agent: RuleAgent;
  decision: string;
  condition: Record<string, unknown>;
  authority: RuleAuthority;
  priority: number;
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
  enabled: boolean;
}

export interface RuleEvaluationResult {
  authority: RuleAuthority;
  decision: string | null;
  rule_id: string | null;
  matched: boolean;
}

export interface RuleCreateInput {
  agent: RuleAgent;
  decision: string;
  condition: Record<string, unknown>;
  authority: RuleAuthority;
  priority?: number;
  enabled?: boolean;
}

export interface RulePatchInput {
  agent?: RuleAgent;
  decision?: string;
  condition?: Record<string, unknown>;
  authority?: RuleAuthority;
  priority?: number;
  enabled?: boolean;
}

const DESTRUCTIVE_AUTO_DENY = new Set([
  "block_merchant",
  "freeze_card",
  "refund",
  "reject_duplicate",
]);

export class RulesEngineService {
  public constructor(private readonly pool: Pool) {}

  public async list(
    ctx: ServiceCallContext,
    input: { agent?: string },
  ): Promise<AgentAuthorityRule[]> {
    return withTenantScope(this.pool, ctx.tenantId, async (client) => {
      const values: unknown[] = [];
      let agentClause = "";
      if (input.agent !== undefined) {
        assertRuleAgent(input.agent);
        values.push(input.agent);
        agentClause = "AND agent = $1";
      }
      const { rows } = await client.query<RuleRow>(
        `SELECT *
           FROM agent_authority_rules
          WHERE tenant_id = current_setting('app.tenant_id', true)
            AND deleted_at IS NULL
            ${agentClause}
          ORDER BY priority DESC, created_at DESC, id DESC`,
        values,
      );
      return rows.map(ruleFromRow);
    });
  }

  public async get(ctx: ServiceCallContext, id: string): Promise<AgentAuthorityRule | null> {
    return withTenantScope(this.pool, ctx.tenantId, async (client) => {
      const row = await findRule(client, id);
      return row === null ? null : ruleFromRow(row);
    });
  }

  public async create(
    ctx: ServiceCallContext,
    input: RuleCreateInput,
  ): Promise<AgentAuthorityRule> {
    validateRuleInput(input);
    return withTenantScope(this.pool, ctx.tenantId, async (client) => {
      const now = new Date();
      const { rows } = await client.query<RuleRow>(
        `INSERT INTO agent_authority_rules (
           id, tenant_id, agent, decision, condition, authority, priority,
           created_by, created_at, updated_by, updated_at, enabled
         )
         VALUES ($1, current_setting('app.tenant_id', true), $2, $3, $4::jsonb, $5, $6,
           $7, $8, $7, $8, $9)
         RETURNING *`,
        [
          randomUUID(),
          input.agent,
          input.decision,
          JSON.stringify(input.condition),
          input.authority,
          input.priority ?? 0,
          ctx.actor,
          now,
          input.enabled ?? true,
        ],
      );
      return ruleFromRow(rows[0]!);
    });
  }

  public async patch(
    ctx: ServiceCallContext,
    id: string,
    input: RulePatchInput,
  ): Promise<AgentAuthorityRule> {
    return withTenantScope(this.pool, ctx.tenantId, async (client) => {
      const current = await findRule(client, id);
      if (current === null) throw brainError("request_params_invalid", "rule not found");
      const merged: RuleCreateInput = {
        agent: input.agent ?? current.agent,
        decision: input.decision ?? current.decision,
        condition: input.condition ?? current.condition,
        authority: input.authority ?? current.authority,
        priority: input.priority ?? current.priority,
        enabled: input.enabled ?? current.enabled,
      };
      validateRuleInput(merged);
      const { rows } = await client.query<RuleRow>(
        `UPDATE agent_authority_rules
            SET agent = $2,
                decision = $3,
                condition = $4::jsonb,
                authority = $5,
                priority = $6,
                enabled = $7,
                updated_by = $8,
                updated_at = now()
          WHERE id = $1
            AND tenant_id = current_setting('app.tenant_id', true)
            AND deleted_at IS NULL
          RETURNING *`,
        [
          id,
          merged.agent,
          merged.decision,
          JSON.stringify(merged.condition),
          merged.authority,
          merged.priority ?? 0,
          merged.enabled ?? true,
          ctx.actor,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw brainError("request_params_invalid", "rule not found");
      return ruleFromRow(row);
    });
  }

  public async delete(ctx: ServiceCallContext, id: string): Promise<void> {
    await withTenantScope(this.pool, ctx.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE agent_authority_rules
            SET deleted_at = now(),
                enabled = FALSE,
                updated_by = $2,
                updated_at = now()
          WHERE id = $1
            AND tenant_id = current_setting('app.tenant_id', true)
            AND deleted_at IS NULL`,
        [id, ctx.actor],
      );
      if (result.rowCount === 0) throw brainError("request_params_invalid", "rule not found");
    });
  }

  public async preview(
    ctx: ServiceCallContext,
    input: { agent: string; payload: Record<string, unknown> },
  ): Promise<RuleEvaluationResult> {
    assertRuleAgent(input.agent);
    return this.evaluate(ctx, input.agent, input.payload);
  }

  public async evaluate(
    ctx: ServiceCallContext,
    agent: string,
    payload: Record<string, unknown>,
  ): Promise<RuleEvaluationResult> {
    const canonicalAgent = normalizeAgent(agent);
    if (canonicalAgent === null) return noRule();
    return withTenantScope(this.pool, ctx.tenantId, async (client) => {
      const { rows } = await client.query<RuleRow>(
        `SELECT *
           FROM agent_authority_rules
          WHERE tenant_id = current_setting('app.tenant_id', true)
            AND agent = $1
            AND enabled = TRUE
            AND deleted_at IS NULL
          ORDER BY priority DESC, created_at DESC, id DESC`,
        [canonicalAgent],
      );
      for (const row of rows) {
        if (evaluateJsonLogic(row.condition, payload)) {
          return {
            authority: row.authority,
            decision: row.decision,
            rule_id: row.id,
            matched: true,
          };
        }
      }
      return noRule();
    });
  }

  public async validateStartupRules(): Promise<void> {
    const { rows } = await this.pool.query<Pick<RuleRow, "id" | "tenant_id" | "decision">>(
      `SELECT id, tenant_id, decision
         FROM agent_authority_rules
        WHERE authority = 'auto'
          AND enabled = TRUE
          AND deleted_at IS NULL
          AND decision = ANY($1::text[])
        LIMIT 1`,
      [[...DESTRUCTIVE_AUTO_DENY]],
    );
    const row = rows[0];
    if (row !== undefined) {
      throw brainError(
        "request_body_invalid",
        "auto authority is not allowed for destructive decisions",
        {
          details: { rule_id: row.id, tenant_id: row.tenant_id, decision: row.decision },
        },
      );
    }
  }
}

interface RuleRow {
  id: string;
  tenant_id: string;
  agent: RuleAgent;
  decision: string;
  condition: Record<string, unknown>;
  authority: RuleAuthority;
  priority: number;
  created_by: string;
  created_at: Date;
  updated_by: string;
  updated_at: Date;
  enabled: boolean;
}

function noRule(): RuleEvaluationResult {
  return { authority: "propose", decision: null, rule_id: null, matched: false };
}

function ruleFromRow(row: RuleRow): AgentAuthorityRule {
  return {
    ...row,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

async function findRule(client: TenantScopedClient, id: string): Promise<RuleRow | null> {
  const { rows } = await client.query<RuleRow>(
    `SELECT *
       FROM agent_authority_rules
      WHERE id = $1
        AND tenant_id = current_setting('app.tenant_id', true)
        AND deleted_at IS NULL`,
    [id],
  );
  return rows[0] ?? null;
}

function validateRuleInput(input: RuleCreateInput): void {
  assertRuleAgent(input.agent);
  if (input.decision.length === 0) throw brainError("request_body_invalid", "decision required");
  if (!["auto", "propose", "deny"].includes(input.authority)) {
    throw brainError("request_body_invalid", "authority must be auto, propose, or deny");
  }
  if (input.authority === "auto" && DESTRUCTIVE_AUTO_DENY.has(input.decision)) {
    throw brainError("request_body_invalid", "auto authority is not allowed for this decision");
  }
  assertJsonObject(input.condition, "condition");
}

export function assertRuleAgent(value: string): asserts value is RuleAgent {
  if (!(RULE_AGENTS as readonly string[]).includes(value)) {
    throw brainError("request_body_invalid", "unknown agent");
  }
}

function normalizeAgent(value: string): RuleAgent | null {
  if (value === "subscription") return "subscription_management";
  return (RULE_AGENTS as readonly string[]).includes(value) ? (value as RuleAgent) : null;
}

function assertJsonObject(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw brainError("request_body_invalid", `${field} must be an object`);
  }
}

export function evaluateJsonLogic(rule: unknown, data: unknown): boolean {
  if (rule === null || rule === undefined) return true;
  if (typeof rule === "boolean") return rule;
  if (typeof rule !== "object" || Array.isArray(rule)) return Boolean(rule);
  const entries = Object.entries(rule as Record<string, unknown>);
  if (entries.length === 0) return true;
  const [op, rawArg] = entries[0]!;
  const args = Array.isArray(rawArg) ? rawArg : [rawArg];
  switch (op) {
    case "var":
      return Boolean(resolveVar(data, String(rawArg)));
    case "==":
      return value(args[0], data) === value(args[1], data);
    case "!=":
      return value(args[0], data) !== value(args[1], data);
    case ">":
      return numberValue(args[0], data) > numberValue(args[1], data);
    case ">=":
      return numberValue(args[0], data) >= numberValue(args[1], data);
    case "<":
      return numberValue(args[0], data) < numberValue(args[1], data);
    case "<=":
      return numberValue(args[0], data) <= numberValue(args[1], data);
    case "and":
      return args.every((arg) => Boolean(value(arg, data)));
    case "or":
      return args.some((arg) => Boolean(value(arg, data)));
    case "!":
      return !value(args[0], data);
    default:
      throw brainError("request_body_invalid", `unsupported jsonlogic operator ${op}`);
  }
}

function value(input: unknown, data: unknown): unknown {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const entries = Object.entries(input as Record<string, unknown>);
    if (entries.length === 1 && entries[0]![0] === "var") {
      return resolveVar(data, String(entries[0]![1]));
    }
    return evaluateJsonLogic(input, data);
  }
  return input;
}

function numberValue(input: unknown, data: unknown): number {
  const resolved = value(input, data);
  if (typeof resolved === "number") return resolved;
  if (typeof resolved === "string" && resolved.trim().length > 0) return Number(resolved);
  return Number.NaN;
}

function resolveVar(data: unknown, path: string): unknown {
  if (path.length === 0) return data;
  let current = data;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
