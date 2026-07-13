import type { BrainHttpClient } from "../client.js";
import { BrainAPIError, type BrainErrorBody } from "../errors.js";
import type { components } from "../generated/openapi.js";

type Policy = components["schemas"]["Policy"];
type PolicyDSL = components["schemas"]["PolicyDSL"];
type PolicyDecision = components["schemas"]["PolicyDecision"];
type ProposedAction = components["schemas"]["ProposedAction"];

export interface PolicySigningPayload {
  policyId: string;
  state: string;
  signingPayload: Record<string, unknown>;
}

export interface PolicySignatureSubmission {
  policyId: string;
  signatures: Array<{ address: string; signature: string }>;
}

export interface SimulatePolicyParams {
  action: ProposedAction;
  version: number;
}

function unwrap<T>(data: T | undefined, error: BrainErrorBody | undefined, status: number): T {
  if (error !== undefined || data === undefined) {
    throw new BrainAPIError(status, error);
  }
  return data;
}

export class PolicyResource {
  constructor(private readonly http: BrainHttpClient) {}

  async get(tenantId: string): Promise<Policy> {
    const { data, error, response } = await this.http.GET("/policy/{tenant_id}", {
      params: { path: { tenant_id: tenantId } },
    });
    return unwrap(data, error, response.status);
  }

  async listVersions(tenantId: string): Promise<Policy[]> {
    const { data, error, response } = await this.http.GET("/policy/{tenant_id}/versions", {
      params: { path: { tenant_id: tenantId } },
    });
    const body = unwrap(data, error, response.status);
    return body.versions ?? [];
  }

  /**
   * Documented as `brain.policy.create(...)` on docs.brain.fi. Validates
   * the DSL and returns the EIP-712 signing payload. Caller signs with
   * authorised keys, then submits via `sign()` to activate.
   */
  async compose(
    tenantId: string,
    dsl: PolicyDSL,
    quorumRequired?: number,
  ): Promise<PolicySigningPayload> {
    const composeBody: { content: PolicyDSL; quorum_required?: number } = { content: dsl };
    if (quorumRequired !== undefined) {
      composeBody.quorum_required = quorumRequired;
    }
    const { data, error, response } = await this.http.POST("/policy/{tenant_id}/compose", {
      params: { path: { tenant_id: tenantId } },
      body: composeBody,
    });
    const body = unwrap(data, error, response.status);
    if (!body.policy_id) {
      throw new BrainAPIError(response.status, undefined);
    }
    return {
      policyId: body.policy_id,
      state: body.state ?? "pending_signatures",
      signingPayload: body.signing_payload ?? {},
    };
  }

  /**
   * Submits signatures gathered against the compose() payload. When the
   * server has sufficient signatures, the policy is activated and the
   * new active Policy is returned. 409 indicates insufficient signatures
   * (more required).
   */
  async sign(
    tenantId: string,
    submission: PolicySignatureSubmission,
  ): Promise<{ policy: Policy; activated: boolean }> {
    const { data, error, response } = await this.http.POST("/policy/{tenant_id}/sign", {
      params: { path: { tenant_id: tenantId } },
      body: {
        policy_id: submission.policyId,
        signatures: submission.signatures,
      },
    });
    const body = unwrap(data, error, response.status);
    if (!body.policy) {
      throw new BrainAPIError(response.status, undefined);
    }
    return { policy: body.policy, activated: body.activated ?? false };
  }

  /**
   * Alias for `sign`. Documented as `brain.policy.activate(...)` on
   * docs.brain.fi — the spec has no separate /activate endpoint; the
   * policy activates as a side effect of submitting sufficient signatures
   * via /sign.
   */
  activate(
    tenantId: string,
    submission: PolicySignatureSubmission,
  ): Promise<{ policy: Policy; activated: boolean }> {
    return this.sign(tenantId, submission);
  }

  async evaluate(tenantId: string, action: ProposedAction): Promise<PolicyDecision> {
    const { data, error, response } = await this.http.POST("/policy/{tenant_id}/evaluate", {
      params: { path: { tenant_id: tenantId } },
      body: { action },
    });
    return unwrap(data, error, response.status);
  }

  async simulate(tenantId: string, params: SimulatePolicyParams): Promise<PolicyDecision> {
    const { data, error, response } = await this.http.POST("/policy/{tenant_id}/simulate", {
      params: { path: { tenant_id: tenantId } },
      body: { action: params.action, version: params.version },
    });
    return unwrap(data, error, response.status);
  }

  /** H-18: static-analyze a candidate policy before signing. */
  async lint(tenantId: string, policyContent: Record<string, unknown>): Promise<PolicyLintResult> {
    const { data, error, response } = await this.http.POST("/policy/{tenant_id}/lint", {
      params: { path: { tenant_id: tenantId } },
      body: { policy_content: policyContent },
    });
    return unwrap(data, error, response.status) as unknown as PolicyLintResult;
  }

  /** H-18: semantic diff between two policy versions. */
  async diff(tenantId: string, fromVersion: number, toVersion: number): Promise<PolicyDiffResult> {
    const { data, error, response } = await this.http.POST("/policy/{tenant_id}/diff", {
      params: { path: { tenant_id: tenantId } },
      body: { from_version: fromVersion, to_version: toVersion },
    });
    return unwrap(data, error, response.status) as unknown as PolicyDiffResult;
  }

  /** H-18: replay a period's actions against a candidate policy. */
  async simulateHistorical(
    tenantId: string,
    params: { policyContent: Record<string, unknown>; periodStart: string; periodEnd: string },
  ): Promise<PolicySimulationResult> {
    const { data, error, response } = await this.http.POST(
      "/policy/{tenant_id}/simulate-historical",
      {
        params: { path: { tenant_id: tenantId } },
        body: {
          policy_content: params.policyContent,
          period_start: params.periodStart,
          period_end: params.periodEnd,
        },
      },
    );
    return unwrap(data, error, response.status) as unknown as PolicySimulationResult;
  }
}

export interface PolicyLintFinding {
  code: string;
  severity: "ERROR" | "WARN";
  rule_id: string | null;
  message: string;
}
export interface PolicyLintResult {
  tenant_id: string;
  errors: number;
  warnings: number;
  findings: PolicyLintFinding[];
}
export interface PolicyDiffResult {
  from_version: number;
  to_version: number;
  added: unknown[];
  removed: unknown[];
  modified: unknown[];
}
export interface PolicySimulationResult {
  total: number;
  would_allow: number;
  would_confirm: number;
  would_reject: number;
  diff_vs_active: Record<string, unknown>;
}
