/**
 * H-07 Proof source gathering.
 *
 * Assembles the cross-layer `ProofSources` bundle for an action under a tenant
 * scope (RLS provides isolation — no tenant_id WHERE filters). Reads are
 * read-only across the Ledger (payment intent + executions), Policy (decision +
 * policy hash), Audit (event chain + anchor + Merkle proof, reusing @brain/audit
 * Merkle helpers), and Raw (evidence) schemas — the API gateway is the
 * composition root, so this aggregation is sanctioned.
 *
 * Returns null when the action does not exist for this tenant (the route maps
 * that to 404 so existence is never leaked across tenants).
 *
 * SANDBOX NOTE: the SQL shape + row→ProofSources mapping is unit-tested with a
 * fake query client; the live joins, RLS isolation, and Merkle proof against a
 * real anchor window require Postgres and are an integration test blocked here
 * (no Docker/pg — see the H-07 summary).
 */

import type { TenantScopedClient } from "@brain/shared";
import { buildTree, makeProof } from "@brain/audit";
import type { ProofChainAnchor } from "@brain/shared";
import type { ProofSources } from "./assembler.js";

type Client = Pick<TenantScopedClient, "query">;

export interface FetchProofOptions {
  /** On-chain anchor contract address (config) — null if not configured. */
  anchorContractAddress: string | null;
  chain: "base" | "base-sepolia";
}

/** event_hash/prev_event_hash come back as BYTEA (Buffer) — render hex. */
function hex(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return v.toString("hex");
  return String(v);
}

interface PaymentIntentLite {
  id: string;
  created_by_agent_id: string | null;
  status: string;
  policy_decision_id: string | null;
  evidence_ids: string[];
  execution_receipt_ids: string[];
}

export async function fetchProofSources(
  client: Client,
  tenantId: string,
  actionId: string,
  opts: FetchProofOptions,
): Promise<ProofSources | null> {
  // 1 — PaymentIntent (RLS-scoped). Absent => 404 upstream.
  const piRes = await client.query<PaymentIntentLite>(
    `SELECT id, created_by_agent_id, status, policy_decision_id, evidence_ids, execution_receipt_ids
       FROM ledger_payment_intents WHERE id = $1 LIMIT 1`,
    [actionId],
  );
  const pi = piRes.rows[0];
  if (pi === undefined) return null;

  // 2 — Policy decision for this action (latest).
  const pdRes = await client.query<{
    policy_id: string;
    policy_version: number;
    matched_rule_id: string | null;
    ledger_snapshot_hash: string;
    outcome: "allow" | "confirm" | "reject";
  }>(
    `SELECT policy_id, policy_version, matched_rule_id, ledger_snapshot_hash, outcome
       FROM policy_decisions
      WHERE subject_type = 'payment_intent' AND subject_id = $1
      ORDER BY decided_at DESC LIMIT 1`,
    [actionId],
  );
  const pd = pdRes.rows[0] ?? null;

  // 3 — policy content hash (BrainPolicyRegistry) for that version, best-effort.
  let policyHash: string | null = null;
  if (pd !== null) {
    const phRes = await client.query<{ content_hash: string | null }>(
      `SELECT content_hash FROM policies WHERE id = $1 AND version = $2 LIMIT 1`,
      [pd.policy_id, pd.policy_version],
    );
    policyHash = phRes.rows[0]?.content_hash ?? null;
  }

  // 4 — audit events touching this action, oldest first.
  const evRes = await client.query<{
    id: string;
    action: string;
    layer: string;
    outputs: Record<string, unknown> | null;
    event_hash: Buffer | string;
    prev_event_hash: Buffer | string | null;
    created_at: Date | string;
  }>(
    `SELECT id, action, layer, outputs, event_hash, prev_event_hash, created_at
       FROM audit_events
      WHERE inputs->>'payment_intent_id' = $1
      ORDER BY created_at ASC`,
    [actionId],
  );
  const auditEvents = evRes.rows.map((e) => ({
    id: e.id,
    action: e.action,
    layer: e.layer,
    event_hash: hex(e.event_hash) ?? "",
    prev_event_hash: hex(e.prev_event_hash),
    created_at: e.created_at instanceof Date ? e.created_at.toISOString() : String(e.created_at),
  }));

  // 5 — gate_checks from the execute.before event the gate persisted (H-07).
  const beforeEvent = evRes.rows.find((e) => e.action === "payment_intent.execute.before");
  const rawChecks = (beforeEvent?.outputs?.gate_checks ?? []) as Array<{
    index: number;
    name: string;
    passed: boolean;
    detail?: Record<string, unknown>;
  }>;
  const gateChecks = rawChecks.map((c) => ({
    index: c.index,
    name: c.name,
    passed: c.passed,
    ...(c.detail !== undefined ? { detail: c.detail } : {}),
  }));

  // 6 — evidence (raw_parsed joined to raw_artifacts), best-effort field map.
  let evidence: ProofSources["evidence"] = [];
  if (pi.evidence_ids.length > 0) {
    const exRes = await client.query<{
      id: string;
      sha256: string | null;
      source_type: string | null;
      kind: string | null;
      trust_level: string | null;
    }>(
      `SELECT p.id AS id,
              encode(a.content_sha256, 'hex') AS sha256,
              a.source_type AS source_type,
              p.extracted->>'kind' AS kind,
              a.trust_level AS trust_level
         FROM raw_parsed p
         JOIN raw_artifacts a ON a.id = p.raw_artifact_id
        WHERE p.id = ANY($1::text[])`,
      [pi.evidence_ids],
    );
    evidence = exRes.rows.map((r) => ({
      raw_parsed_id: r.id,
      sha256: r.sha256 ?? "",
      source_type: r.source_type ?? "unknown",
      kind: r.kind ?? "unknown",
      trust_level: r.trust_level ?? "unknown",
    }));
  }

  // 7 — rail receipt from the linked execution (last one wins).
  let railReceipt: Record<string, unknown> | null = null;
  if (pi.execution_receipt_ids.length > 0) {
    const rcRes = await client.query<{ rail_receipt: Record<string, unknown> | null }>(
      `SELECT rail_receipt FROM executions WHERE id = ANY($1::text[]) ORDER BY started_at DESC LIMIT 1`,
      [pi.execution_receipt_ids],
    );
    railReceipt = rcRes.rows[0]?.rail_receipt ?? null;
  }

  // 8 — Merkle proof + anchor against the latest anchored window.
  const { merkleRoot, merkleProof, chainAnchor } = await buildMerkleProof(
    client,
    beforeEvent?.id ?? evRes.rows[0]?.id ?? null,
    opts,
  );

  // 9 — behavior hash of the originating agent (best-effort; null if absent).
  let behaviorHash: string | null = null;
  if (pi.created_by_agent_id !== null) {
    const bhRes = await client.query<{ scope_hash: Buffer | string | null }>(
      `SELECT scope_hash FROM agents WHERE id = $1 LIMIT 1`,
      [pi.created_by_agent_id],
    );
    behaviorHash = hex(bhRes.rows[0]?.scope_hash ?? null);
  }

  // 10 — shadow flag from the originating agent run, if one is linked.
  const shadowRes = await client.query<{ shadow_mode: boolean }>(
    `SELECT shadow_mode FROM agent_runs WHERE payment_intent_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [actionId],
  );
  const shadow = shadowRes.rows[0]?.shadow_mode ?? false;

  return {
    actionId,
    tenantId,
    paymentIntent: {
      id: pi.id,
      created_by_agent_id: pi.created_by_agent_id,
      status: pi.status,
    },
    shadow,
    policyDecision:
      pd === null
        ? null
        : {
            policy_version: pd.policy_version,
            matched_rule_id: pd.matched_rule_id,
            ledger_snapshot_hash: pd.ledger_snapshot_hash,
            outcome: pd.outcome,
          },
    policyHash,
    behaviorHash,
    gateChecks,
    evidence,
    auditEvents,
    merkleRoot,
    merkleProof,
    chainAnchor,
    railReceipt,
  };
}

/** Build the inclusion proof for `leafEventId` against the latest anchor window. */
async function buildMerkleProof(
  client: Client,
  leafEventId: string | null,
  opts: FetchProofOptions,
): Promise<{ merkleRoot: string; merkleProof: string[]; chainAnchor: ProofChainAnchor | null }> {
  if (leafEventId === null) return { merkleRoot: "", merkleProof: [], chainAnchor: null };

  const anchorRes = await client.query<{
    period_start: Date | string;
    period_end: Date | string;
    onchain_tx_hash: Buffer | string | null;
    onchain_block_number: number | string | null;
  }>(
    `SELECT period_start, period_end, onchain_tx_hash, onchain_block_number
       FROM audit_anchors ORDER BY period_end DESC LIMIT 1`,
    [],
  );
  const anchor = anchorRes.rows[0];
  if (anchor === undefined) return { merkleRoot: "", merkleProof: [], chainAnchor: null };

  const windowRes = await client.query<{ id: string; event_hash: Buffer | string }>(
    `SELECT id, event_hash FROM audit_events
      WHERE created_at >= $1 AND created_at <= $2 ORDER BY created_at ASC, id ASC`,
    [anchor.period_start, anchor.period_end],
  );
  const idx = windowRes.rows.findIndex((e) => e.id === leafEventId);
  if (idx === -1) return { merkleRoot: "", merkleProof: [], chainAnchor: null };

  const leaves = windowRes.rows.map((e) =>
    Buffer.isBuffer(e.event_hash) ? e.event_hash : Buffer.from(String(e.event_hash), "hex"),
  );
  const tree = buildTree(leaves);
  const merkleRoot = tree.root.toString("hex");
  const merkleProof = makeProof(tree, idx).map((b) => b.toString("hex"));

  const txHash = hex(anchor.onchain_tx_hash);
  const chainAnchor: ProofChainAnchor | null =
    txHash !== null && opts.anchorContractAddress !== null
      ? {
          tx_hash: txHash,
          block_number:
            anchor.onchain_block_number === null ? 0 : Number(anchor.onchain_block_number),
          contract_address: opts.anchorContractAddress,
          chain: opts.chain,
        }
      : null;

  return { merkleRoot, merkleProof, chainAnchor };
}
