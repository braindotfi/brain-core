/**
 * Graduated money-movement promotion (Agent Autonomy v3, 1b).
 *
 * Money-movers are NOT flipped live as a group. Each agent is promoted
 * individually behind this policy, gated by strict caps (spend envelopes in the
 * signed policy template) and an allowlist of rails it may use. Default: every
 * agent is shadowed (no agent moves money) until an operator promotes it.
 *
 * The AgentRunService consults `isLive(agentId)` (a financial proposal from a
 * non-live agent terminates as shadow_completed). `isRailAllowed` is the second
 * gate: even a live agent may only use rails on its allowlist.
 */

export interface PromotionPolicy {
  /** True once an operator has promoted this agent to move money. */
  isLive(agentId: string): boolean;
  /** True if `agentId` may use `rail` (e.g. "ach" | "wire" | "erp" | "onchain"). */
  isRailAllowed(agentId: string, rail: string): boolean;
}

export interface PromotionConfig {
  /** Per-agent: the rails this agent may use once live. Absent ⇒ not live. */
  readonly liveAgents?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Static, config-driven promotion policy. With no config every agent is shadowed
 * — the safe default for Phase 1b. Promote one agent at a time by adding it with
 * its allowed rails, e.g. `{ liveAgents: { savings: ["ach"] } }`.
 */
export class StaticPromotionPolicy implements PromotionPolicy {
  private readonly live: Readonly<Record<string, readonly string[]>>;

  constructor(config: PromotionConfig = {}) {
    this.live = config.liveAgents ?? {};
  }

  isLive(agentId: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.live, agentId);
  }

  isRailAllowed(agentId: string, rail: string): boolean {
    const rails = this.live[agentId];
    return rails !== undefined && rails.includes(rail);
  }
}

/** Convenience: every agent shadowed (no money movement). The Phase 1b default. */
export const ALL_SHADOWED: PromotionPolicy = new StaticPromotionPolicy();
