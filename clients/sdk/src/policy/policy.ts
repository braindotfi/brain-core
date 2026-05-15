/**
 * `brain.policy.*` — rule composition, signing, evaluation (Layer 4).
 *
 * Source pages:
 *   - https://docs.brain.fi/api-reference/policy-api
 *   - https://docs.brain.fi/sdks/policy
 *
 * @packageDocumentation
 */

import type { BrainHttp } from "../http/index.js";
import type { Components } from "../index.js";

type Schemas = Components["schemas"];
export type Policy = Schemas["Policy"];
export type PolicyDSL = Schemas["PolicyDSL"];
export type PolicyDecision = Schemas["PolicyDecision"];
export type ProposedAction = Schemas["ProposedAction"];

export interface GetActiveOptions {
  readonly tenantId: string;
}

export interface ListVersionsOptions {
  readonly tenantId: string;
}

export interface ComposeOptions {
  readonly tenantId: string;
  readonly content: PolicyDSL;
}

export interface SignOptions {
  readonly tenantId: string;
  readonly contentHash: string;
  readonly signatures: ReadonlyArray<{ signer: string; signature: string }>;
}

export interface EvaluateOptions {
  readonly tenantId: string;
  readonly action: ProposedAction;
}

export interface SimulateOptions {
  readonly tenantId: string;
  readonly action: ProposedAction;
  readonly version: number;
}

export class PolicyModule {
  public constructor(private readonly http: BrainHttp) {}

  /**
   * Get the active policy for a tenant.
   *
   * Implements `GET /policy/{tenant_id}` (operationId `getActivePolicy`).
   * @see https://docs.brain.fi/api-reference/policy-api
   */
  public async getActive(opts: GetActiveOptions): Promise<Policy> {
    return this.http.get<Policy>(
      `/policy/${encodeURIComponent(opts.tenantId)}`,
    );
  }

  /**
   * List historical versions of the tenant's policy.
   *
   * Implements `GET /policy/{tenant_id}/versions` (operationId
   * `listPolicyVersions`).
   */
  public async listVersions(opts: ListVersionsOptions): Promise<{ versions: Policy[] }> {
    return this.http.get<{ versions: Policy[] }>(
      `/policy/${encodeURIComponent(opts.tenantId)}/versions`,
    );
  }

  /**
   * Compose a new policy. Returns an EIP-712 signing payload; submit
   * the resulting signatures via `sign()`.
   *
   * Implements `POST /policy/{tenant_id}/compose` (operationId
   * `composePolicy`).
   */
  public async compose(opts: ComposeOptions): Promise<{
    content_hash: string;
    typed_data: Record<string, unknown>;
    required_signers: string[];
  }> {
    return this.http.post(
      `/policy/${encodeURIComponent(opts.tenantId)}/compose`,
      opts.content,
    );
  }

  /**
   * Submit signatures for a composed policy. Activates the policy when
   * the required signer threshold is met.
   *
   * Implements `POST /policy/{tenant_id}/sign` (operationId `signPolicy`).
   */
  public async sign(opts: SignOptions): Promise<Policy> {
    return this.http.post<Policy>(
      `/policy/${encodeURIComponent(opts.tenantId)}/sign`,
      {
        content_hash: opts.contentHash,
        signatures: opts.signatures,
      },
    );
  }

  /**
   * Evaluate an action against the active policy and current Ledger
   * state. Returns `{ decision: "allow" | "confirm" | "reject", ... }`
   * per audit decision B.
   *
   * Implements `POST /policy/{tenant_id}/evaluate` (operationId
   * `evaluatePolicy`).
   */
  public async evaluate(opts: EvaluateOptions): Promise<PolicyDecision> {
    return this.http.post<PolicyDecision>(
      `/policy/${encodeURIComponent(opts.tenantId)}/evaluate`,
      opts.action,
    );
  }

  /**
   * Replay an action against a historical policy version.
   *
   * Implements `POST /policy/{tenant_id}/simulate` (operationId
   * `simulatePolicy`).
   */
  public async simulate(opts: SimulateOptions): Promise<PolicyDecision> {
    return this.http.post<PolicyDecision>(
      `/policy/${encodeURIComponent(opts.tenantId)}/simulate`,
      { action: opts.action, version: opts.version },
    );
  }
}
