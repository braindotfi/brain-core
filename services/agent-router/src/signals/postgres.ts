/**
 * Postgres-backed signals provider (peer review #15).
 *
 * Mixes five operational components into a single 0..1 reputation per
 * (tenant, agent). Inputs:
 *
 *   - successRate          ledger_payment_intents WHERE status='executed'
 *                          AND created_by_agent_id = $agent / total proposed
 *   - policyRejectionRate  policy_decisions WHERE outcome='reject'
 *                          AND subject = payment_intent created by $agent / total
 *   - disputeRate          placeholder; 0 until BrainEscrow disputes are wired
 *   - agentStatePenalty    1 when agents.state in (revoked, quarantined, failed)
 *                          (a single hard-bad row drives this to 1, capping the
 *                          reputation no matter how good the historical rates
 *                          were)
 *   - onchainReputation    optional pointer read; defaults to 0.5 when no
 *                          reader is supplied or the lookup returns null
 *
 * Mixing weights (must sum to 1):
 *   successRate         0.40   higher better
 *   policyRejectionRate 0.25   inverted (low rejection = high reputation)
 *   onchainReputation   0.15   higher better
 *   agentStatePenalty   0.15   inverted (active = high reputation)
 *   disputeRate         0.05   inverted (placeholder slot)
 *
 * Per-(tenant, agent) cache with a 5-minute TTL keeps the router hot. The
 * cache is in-process; route() is allowed to see slightly stale signals so
 * long as they refresh within the TTL.
 *
 * Cost is taken from an injected per-agent cost map (defaults to 0). The
 * agent catalog does not carry a cost field yet; when it does, swap the
 * argument.
 */

import { withTenantScope } from "@brain/shared";
import type { Pool } from "pg";
import type { CandidateSignals } from "../types.js";

export interface OnchainReputationReader {
  /** Returns a 0..1 score for the agent, or null when no on-chain pointer exists. */
  getReputation(agentKey: string): Promise<number | null>;
}

export interface PostgresSignalsProviderOptions {
  readonly pool: Pool;
  /** Per-(tenant, agent) cache lifetime. Defaults to 5 minutes. */
  readonly cacheTtlMs?: number;
  /** Optional on-chain reputation reader (e.g. BrainReputationRegistry). */
  readonly onchain?: OnchainReputationReader;
  /** Static cost per agent key. Defaults to 0 for every agent. */
  readonly cost?: ReadonlyMap<string, number>;
}

interface CacheEntry {
  readonly signals: CandidateSignals;
  readonly expiresAt: number;
}

interface AggregateRow {
  total: string;
  executed: string;
  rejected: string;
  state: string | null;
}

// Mixing weights: success 0.40, rejection 0.25 (inverted), onchain 0.15,
// state 0.15 (inverted), dispute 0.05 (inverted).
const W_SUCCESS = 0.4;
const W_REJECTION = 0.25;
const W_ONCHAIN = 0.15;
const W_STATE = 0.15;
const W_DISPUTE = 0.05;

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_ONCHAIN_REPUTATION = 0.5;

/**
 * Smallest sample size we trust to compute rates. Below this, fall back to the
 * neutral midpoint (0.5) for the rate components so a never-used agent is not
 * artificially elevated or sunk.
 */
const MIN_SAMPLE = 5;

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export class PostgresSignalsProvider {
  private readonly cache = new Map<string, CacheEntry>();

  public constructor(private readonly opts: PostgresSignalsProviderOptions) {}

  /**
   * Operations seam: drop a cache entry so the next lookup re-reads from DB.
   * Call after an agent is revoked or after a manual reputation override.
   */
  public clearCache(agentKey?: string, tenantId?: string): void {
    if (agentKey === undefined) {
      this.cache.clear();
      return;
    }
    if (tenantId !== undefined) {
      this.cache.delete(this.key(agentKey, tenantId));
      return;
    }
    // Drop every entry for this agent across tenants.
    for (const k of this.cache.keys()) {
      if (k.startsWith(`${agentKey}::`)) this.cache.delete(k);
    }
  }

  public async load(agentKey: string, tenantId: string): Promise<CandidateSignals> {
    const now = Date.now();
    const cached = this.cache.get(this.key(agentKey, tenantId));
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.signals;
    }
    const signals = await this.compute(agentKey, tenantId);
    this.cache.set(this.key(agentKey, tenantId), {
      signals,
      expiresAt: now + (this.opts.cacheTtlMs ?? DEFAULT_TTL_MS),
    });
    return signals;
  }

  private key(agentKey: string, tenantId: string): string {
    return `${agentKey}::${tenantId}`;
  }

  private async compute(agentKey: string, tenantId: string): Promise<CandidateSignals> {
    const aggregate = await this.readAggregate(agentKey, tenantId);
    const onchainReputation = await this.readOnchain(agentKey);

    const total = Number(aggregate.total);
    const executed = Number(aggregate.executed);
    const rejected = Number(aggregate.rejected);
    const trustRates = total >= MIN_SAMPLE;

    const successRate = trustRates ? clamp01(executed / Math.max(total, 1)) : 0.5;
    const policyRejectionRate = trustRates ? clamp01(rejected / Math.max(total, 1)) : 0.5;
    const disputeRate = 0; // placeholder until BrainEscrow disputes are wired
    const agentStatePenalty = isHardBadState(aggregate.state) ? 1 : 0;

    const reputation = clamp01(
      W_SUCCESS * successRate +
        W_REJECTION * (1 - policyRejectionRate) +
        W_ONCHAIN * onchainReputation +
        W_STATE * (1 - agentStatePenalty) +
        W_DISPUTE * (1 - disputeRate),
    );

    return {
      reputation,
      cost: this.opts.cost?.get(agentKey) ?? 0,
      components: {
        successRate,
        policyRejectionRate,
        disputeRate,
        agentStatePenalty,
        onchainReputation,
        sampleSize: total,
      },
    };
  }

  private async readAggregate(agentKey: string, tenantId: string): Promise<AggregateRow> {
    return withTenantScope(this.opts.pool, tenantId, async (client) => {
      const { rows } = await client.query<AggregateRow>(
        `SELECT
           COALESCE(pi.total, 0)::text       AS total,
           COALESCE(pi.executed, 0)::text    AS executed,
           COALESCE(pd.rejected, 0)::text    AS rejected,
           a.state                            AS state
         FROM (
           SELECT
             COUNT(*)                                    AS total,
             COUNT(*) FILTER (WHERE status = 'executed') AS executed
           FROM ledger_payment_intents
           WHERE created_by_agent_id = $1
         ) AS pi
         FULL OUTER JOIN (
           SELECT COUNT(*) AS rejected
           FROM policy_decisions
           WHERE outcome = 'reject'
             AND subject_type = 'payment_intent'
             AND subject_id IN (
               SELECT id FROM ledger_payment_intents
                WHERE created_by_agent_id = $1
             )
         ) AS pd ON true
         FULL OUTER JOIN agents a ON a.id = $1`,
        [agentKey],
      );
      return rows[0] ?? { total: "0", executed: "0", rejected: "0", state: null };
    });
  }

  private async readOnchain(agentKey: string): Promise<number> {
    if (this.opts.onchain === undefined) return DEFAULT_ONCHAIN_REPUTATION;
    try {
      const r = await this.opts.onchain.getReputation(agentKey);
      return r === null ? DEFAULT_ONCHAIN_REPUTATION : clamp01(r);
    } catch {
      // Reading the on-chain pointer must never break router selection.
      return DEFAULT_ONCHAIN_REPUTATION;
    }
  }
}

function isHardBadState(state: string | null): boolean {
  return state === "revoked" || state === "quarantined" || state === "failed";
}
