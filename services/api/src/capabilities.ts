/**
 * Boot-time runtime capability registry (post-review item 5).
 *
 * Emits a single structured log line at the end of boot that answers, in one
 * place: "what's actually wired in this process right now?" — rails, §6 gate
 * loaders, MCP surfaces, workers, audit broadcaster, credential encryption.
 *
 * Without this, the answer requires spelunking through ~1700 lines of main.ts
 * and inferring from absent env-vars / silently-defaulted stubs. With it, ops
 * and demo prelude scripts can answer the question from a single log line.
 *
 * Strict: no runtime behavior change; observability only. Safe to call from any
 * boot path.
 */

import type { Logger } from "@brain/shared";

export interface RailEntry {
  /** Canonical rail key, e.g. "bank_ach" / "onchain_base" / "x402_base". */
  name: string;
  /** True when a real client/executor is wired; false when this slot is a dev stub. */
  live: boolean;
}

export interface GateLoaderState {
  /** P0.1 — per-tenant enforcement flags. */
  resolveTenantFlags: boolean;
  /** RFC 0001 §6.3 (check 5.5) — agent payee attestation read. */
  attestCounterpartyAgent: boolean;
  /** RFC 0001 §6.4 (check 8.5) — rolling-window per-agent spend. */
  sumAgentWindowSpend: boolean;
  /** RFC 0001 §7.6 (check 6.6) — on-chain escrow lock read. */
  resolveEscrowState: boolean;
  /** §6 check 8 (balance) — sum of active reservations against source account. */
  sumActiveReservations: boolean;
  /** §6 check 11 (evidence present) — pulls evidence records by id. */
  resolveEvidence: boolean;
  /** §6 check 11.5 (duplicate-payment protection) — scans for prior settlements. */
  detectDuplicates: boolean;
}

export interface BootCapabilities {
  /** process.env.NODE_ENV at boot. */
  nodeEnv: string | undefined;
  /** Every rail key registered with the RailRegistry. `live: false` ⇒ stub. */
  rails: ReadonlyArray<RailEntry>;
  /** Each §6 gate loader: true when injected, false when dormant (check records not_applicable). */
  gateLoaders: GateLoaderState;
  /** Number of agents in LIVE_AGENTS.liveAgents (post-shadow-gate promotions). */
  liveAgentsCount: number;
  /** Whether startWebhookDispatchWorker is running (item 13). */
  webhookDispatchWorker: boolean;
  /** Whether the audit anchor broadcaster is wired to a real Base RPC (publishes Merkle roots on-chain). */
  auditAnchorBroadcaster: boolean;
  /** Whether the MCP brain://proofs/{action_id} resource is wired through poolProofBuilder. */
  mcpProofBuilder: boolean;
  /** Whether at-rest credential encryption is active (a credential key is loaded). */
  sourceCredentialEncryption: boolean;
  /**
   * Which credential-key provider the boot path selected:
   *   "azure-key-vault" — KMS (production)
   *   "env-var"         — BRAIN_SOURCE_CREDENTIAL_KEY (dev/staging only)
   *   "none"            — no key configured (forbidden in production)
   */
  sourceCredentialKeyProvider: "azure-key-vault" | "env-var" | "none";
  /**
   * Whether Wiki uses an isolated Postgres role (BRAIN_WIKI_DB_URL set).
   * False ⇒ Wiki shares the main pool, an accidental ledger write from a
   * Wiki path would NOT trigger a Postgres permission error. Required true
   * in production by assertDbIsolationFences().
   */
  wikiDbIsolation: boolean;
  /**
   * Whether cross-tenant operations use the BYPASSRLS privileged role
   * (DATABASE_PRIVILEGED_URL set). False ⇒ outbox/tenant-deletion/Plaid
   * resolvers run as the same app role and silently match zero rows in any
   * RLS-armed table. Required true in production.
   */
  privilegedDbIsolation: boolean;
  /**
   * Whether outbound calls to the Python brain-agents service are HMAC-signed
   * (BRAIN_AGENTS_INBOUND_SECRET present). False ⇒ the Python verifier (which
   * fails closed in production) rejects every request. Required true whenever
   * RECONCILIATION_AGENT_URL is set in production (enforced at boot).
   */
  pythonAgentSigning: boolean;
}

/**
 * Emit the capability snapshot as one structured log line at level `info`.
 *
 * The shape is intentionally flat + JSON-friendly so log aggregators (Grafana
 * Loki / Datadog / etc.) can index it directly. Use this in a demo prelude:
 *   `kubectl logs brain-api | grep brain.runtime.capabilities | tail -1 | jq`.
 */
export function logBootCapabilities(c: BootCapabilities, log: Logger): void {
  const railsLive = c.rails.filter((r) => r.live).map((r) => r.name);
  const railsStub = c.rails.filter((r) => !r.live).map((r) => r.name);
  const loaderEntries = Object.entries(c.gateLoaders) as Array<
    [keyof GateLoaderState, boolean]
  >;
  const wired = loaderEntries.filter(([, v]) => v).map(([k]) => k);
  const dormant = loaderEntries.filter(([, v]) => !v).map(([k]) => k);

  log.info(
    {
      node_env: c.nodeEnv ?? "unset",
      rails_live: railsLive,
      rails_stub: railsStub,
      gate_loaders_wired: wired,
      gate_loaders_dormant: dormant,
      live_agents_count: c.liveAgentsCount,
      webhook_dispatch_worker: c.webhookDispatchWorker,
      audit_anchor_broadcaster: c.auditAnchorBroadcaster,
      mcp_proof_builder: c.mcpProofBuilder,
      source_credential_encryption: c.sourceCredentialEncryption,
      source_credential_key_provider: c.sourceCredentialKeyProvider,
      wiki_db_isolation: c.wikiDbIsolation,
      privileged_db_isolation: c.privilegedDbIsolation,
      python_agent_signing: c.pythonAgentSigning,
    },
    "brain.runtime.capabilities",
  );
}
