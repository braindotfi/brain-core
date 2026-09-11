import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import {
  PAYMENT_AGENT_SCOPES,
  computeAgentScopeHash,
  generateAgentApiKey,
  hashAgentApiKey,
  newAgentId,
  newApiKeyId,
  newCommercialShadowPeriodId,
  newCommercialShadowTransitionId,
  newPolicyId,
  newRobotMoneyEntityId,
  newTenantId,
  newUserId,
} from "@brain/shared";
import { contentHash } from "@brain/policy";
import { buildDefaultPolicyDocument } from "../onboarding/provision.js";
import { hashApiKeySecret } from "../production-tenancy/api-key-routes.js";

export const SHADOW_TENANT_NAME = "RobotMoney Internal Commercial Shadow 2026-10";
export const SHADOW_DATA_PROFILE = "internal_commercial_shadow_v1";
export const SHADOW_ACCESS_STAGE = "production";
export const SHADOW_CATALOG_REVISION = "robotmoney_growth_v1";
export const SHADOW_API_SCOPES = ["ledger:read", "audit:read", "governance:read"] as const;

export const PROTECTED_TENANT_IDS = new Set([
  "tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ",
  "tnt_00000000010000000000000000",
  "tnt_01KYAT7A1QRKHTYW9H4RAR2SEX",
  "tnt_01M1GTBQN8R8PB6X6PN73YB6NP",
]);

export interface ShadowCredentialBundle {
  readonly tenant_id: string;
  readonly shadow_period_id: string;
  readonly agent_id: string;
  readonly agent_key_id: string;
  readonly api_key_id: string;
  readonly BRAIN_AGENT_API_KEY: string;
  readonly BRAIN_API_KEY: string;
}

export interface StartShadowInput {
  readonly approvedSha: string;
  readonly actor: string;
  readonly reason: string;
  readonly agentApiKeyPepper: string;
  readonly apiKeyPepper: string;
}

export interface PreparedShadowStart {
  readonly bundle: ShadowCredentialBundle;
  readonly databaseValues: readonly unknown[];
}

export interface ShadowTransitionInput {
  readonly action: "resume" | "pause" | "stop" | "complete";
  readonly approvedSha: string;
  readonly actor: string;
  readonly reason: string;
}

export async function inspectCommercialShadow(pool: Pool): Promise<Record<string, unknown>> {
  const result = await pool.query<{ result: Record<string, unknown> }>(
    `SELECT inspect_internal_commercial_shadow() AS result`,
  );
  return result.rows[0]?.result ?? { state: "not_started" };
}

export async function startCommercialShadow(
  pool: Pool,
  input: StartShadowInput,
): Promise<{ readonly bundle: ShadowCredentialBundle; readonly startedAt: Date | string }> {
  return commitCommercialShadowStart(pool, prepareCommercialShadowStart(input));
}

export function prepareCommercialShadowStart(input: StartShadowInput): PreparedShadowStart {
  validateEvidence(input);
  if (input.agentApiKeyPepper.length === 0 || input.apiKeyPepper.length === 0) {
    throw new Error("both key peppers are required");
  }

  const tenantId = newTenantId();
  if (PROTECTED_TENANT_IDS.has(tenantId)) throw new Error("generated tenant id is protected");
  const memberId = newUserId();
  const policyId = newPolicyId();
  const agentId = newAgentId();
  const entityId = newRobotMoneyEntityId();
  const shadowPeriodId = newCommercialShadowPeriodId();
  const transitionId = newCommercialShadowTransitionId();
  const policyContent = buildDefaultPolicyDocument();
  const agentKey = generateAgentApiKey("live");
  const apiSecret = `brain_sk_live_${randomBytes(32).toString("base64url")}`;
  const apiKeyId = newApiKeyId();

  return {
    bundle: {
      tenant_id: tenantId,
      shadow_period_id: shadowPeriodId,
      agent_id: agentId,
      agent_key_id: agentKey.id,
      api_key_id: apiKeyId,
      BRAIN_AGENT_API_KEY: agentKey.plaintext,
      BRAIN_API_KEY: apiSecret,
    },
    databaseValues: [
      tenantId,
      memberId,
      policyId,
      JSON.stringify(policyContent),
      contentHash(policyContent),
      agentId,
      Buffer.from(computeAgentScopeHash(PAYMENT_AGENT_SCOPES).slice(2), "hex"),
      agentKey.id,
      hashAgentApiKey(agentKey.plaintext, input.agentApiKeyPepper),
      agentKey.last4,
      apiKeyId,
      hashApiKeySecret(apiSecret, input.apiKeyPepper),
      apiSecret.slice(-4),
      entityId,
      shadowPeriodId,
      transitionId,
      input.approvedSha,
      input.actor,
      input.reason,
    ],
  };
}

export async function commitCommercialShadowStart(
  pool: Pool,
  prepared: PreparedShadowStart,
): Promise<{ readonly bundle: ShadowCredentialBundle; readonly startedAt: Date | string }> {
  const result = await pool.query<{
    tenant_id: string;
    shadow_period_id: string;
    started_at: Date | string;
    agent_id: string;
    agent_key_id: string;
    api_key_id: string;
  }>(
    `SELECT * FROM start_internal_commercial_shadow(
       $1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
     )`,
    [...prepared.databaseValues],
  );
  const started = result.rows[0];
  if (started === undefined) throw new Error("shadow start returned no row");
  if (
    started.tenant_id !== prepared.bundle.tenant_id ||
    started.shadow_period_id !== prepared.bundle.shadow_period_id ||
    started.agent_id !== prepared.bundle.agent_id ||
    started.agent_key_id !== prepared.bundle.agent_key_id ||
    started.api_key_id !== prepared.bundle.api_key_id
  ) {
    throw new Error("shadow start returned mismatched identifiers");
  }
  return {
    bundle: prepared.bundle,
    startedAt: started.started_at,
  };
}

export async function transitionCommercialShadow(
  pool: Pool,
  input: ShadowTransitionInput,
): Promise<Record<string, unknown>> {
  validateEvidence(input);
  const result = await pool.query(
    `SELECT * FROM transition_internal_commercial_shadow($1,$2,$3,$4,$5)`,
    [input.action, newCommercialShadowTransitionId(), input.approvedSha, input.actor, input.reason],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) throw new Error("shadow transition returned no row");
  return row;
}

function validateEvidence(input: {
  readonly approvedSha: string;
  readonly actor: string;
  readonly reason: string;
}): void {
  if (!/^[0-9a-f]{40}$/.test(input.approvedSha)) throw new Error("approved SHA is invalid");
  if (input.actor.length === 0 || input.actor.length > 200) throw new Error("actor is invalid");
  if (input.reason.length < 10 || input.reason.length > 240 || /[\r\n]/.test(input.reason)) {
    throw new Error("reason must be 10 to 240 characters on one line");
  }
}
