/**
 * P0.7 — human-readable proof viewer: GET /v1/proof/{id}/view → text/html.
 *
 * The JSON Proof API (GET /v1/proof/{id}) is developer-facing. This renders the
 * same canonical Proof as a single, dependency-free HTML page a compliance
 * officer or investor can read — the screen the golden-path demo ends on.
 *
 * No auth bypass: it requires the same authenticated principal + audit:read
 * scope as the JSON route, and is tenant-isolated by the injected buildProof
 * (a cross-tenant / unknown id resolves to null → 404, no existence leak).
 * `renderProofHtml` is a pure function so it is unit-testable without a pool.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { brainError, requireScope, type Proof, type Scope } from "@brain/shared";
import type { ProofRouteDeps } from "./routes.js";

const READ: Scope = "audit:read";

function esc(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function explorerTxUrl(chain: string, txHash: string): string {
  const base = chain === "base" ? "https://basescan.org" : "https://sepolia.basescan.org";
  return `${base}/tx/${esc(txHash)}`;
}

function row(label: string, value: string): string {
  return `<tr><th>${esc(label)}</th><td>${value}</td></tr>`;
}

/** Render a Proof as a standalone HTML document. Pure — no I/O. */
export function renderProofHtml(proof: Proof): string {
  const anchored = proof.chain_anchor !== null;
  const verifiable = proof.merkle_root.length > 0 && proof.audit_events.length > 0;
  const badge = anchored
    ? `<span class="badge ok">✓ Anchored on-chain &amp; verifiable</span>`
    : verifiable
      ? `<span class="badge pending">⏳ Recorded &amp; verifiable — on-chain anchor pending</span>`
      : `<span class="badge warn">— Proof incomplete</span>`;

  const gateRows = proof.gate_checks
    .map(
      (c) =>
        `<tr><td>${esc(c.index)}</td><td>${esc(c.name)}</td><td>${
          c.passed ? '<span class="pass">pass</span>' : '<span class="fail">fail</span>'
        }</td><td><code>${c.detail ? esc(JSON.stringify(c.detail)) : ""}</code></td></tr>`,
    )
    .join("");

  const evidenceRows =
    proof.evidence.length > 0
      ? proof.evidence
          .map(
            (e) =>
              `<tr><td>${esc(e.kind)}</td><td>${esc(e.source_type)}</td><td>${esc(
                e.trust_level,
              )}</td><td><code>${esc(e.sha256)}</code></td><td><code>${esc(
                e.raw_parsed_id,
              )}</code></td></tr>`,
          )
          .join("")
      : `<tr><td colspan="5"><em>no linked evidence</em></td></tr>`;

  const auditRows = proof.audit_events
    .map(
      (a) =>
        `<tr><td>${esc(a.action)}</td><td>${esc(a.layer)}</td><td>${esc(
          a.created_at,
        )}</td><td><code>${esc(a.event_hash.slice(0, 16))}…</code></td></tr>`,
    )
    .join("");

  const proofPath =
    proof.merkle_proof.length > 0
      ? `<details><summary>Merkle proof path (${proof.merkle_proof.length} hashes)</summary><ul>${proof.merkle_proof
          .map((h) => `<li><code>${esc(h)}</code></li>`)
          .join("")}</ul></details>`
      : `<em>no inclusion proof</em>`;

  const anchorBlock = proof.chain_anchor
    ? `<table>${row("Chain", esc(proof.chain_anchor.chain))}${row(
        "Tx",
        `<a href="${explorerTxUrl(
          proof.chain_anchor.chain,
          proof.chain_anchor.tx_hash,
        )}" rel="noreferrer noopener">${esc(proof.chain_anchor.tx_hash)}</a>`,
      )}${row("Block", esc(proof.chain_anchor.block_number))}${row(
        "Contract",
        `<code>${esc(proof.chain_anchor.contract_address)}</code>`,
      )}</table>`
    : `<p><em>Not yet anchored on-chain.</em></p>`;

  const railBlock = proof.rail_receipt
    ? `<pre><code>${esc(JSON.stringify(proof.rail_receipt, null, 2))}</code></pre>`
    : `<p><em>No rail receipt (proposal/confirm only, or not yet dispatched).</em></p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Brain Proof — ${esc(proof.action_id)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         margin: 0; padding: 1.5rem; max-width: 860px; margin-inline: auto; color: #1a1a2e; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.05rem; margin: 1.6rem 0 .5rem; border-bottom: 1px solid #ddd; padding-bottom: .25rem; }
  table { border-collapse: collapse; width: 100%; font-size: .92rem; }
  th, td { text-align: left; padding: .35rem .5rem; vertical-align: top; border-bottom: 1px solid #eee; word-break: break-word; }
  th { white-space: nowrap; color: #444; font-weight: 600; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; }
  pre { background: #f6f6fb; padding: .75rem; overflow-x: auto; border-radius: 6px; }
  .badge { display: inline-block; padding: .3rem .7rem; border-radius: 999px; font-weight: 600; font-size: .9rem; }
  .badge.ok { background: #d8f5e0; color: #07632c; }
  .badge.pending { background: #fff3cd; color: #8a6d00; }
  .badge.warn { background: #fde2e1; color: #8a1c14; }
  .pass { color: #07632c; font-weight: 600; }
  .fail { color: #8a1c14; font-weight: 600; }
  .lead { background: #f6f6fb; padding: .75rem 1rem; border-radius: 8px; }
  .muted { color: #666; font-size: .85rem; }
</style>
</head>
<body>
  <h1>Brain Action Proof</h1>
  <p class="muted">Action <code>${esc(proof.action_id)}</code> · outcome <strong>${esc(
    proof.outcome,
  )}</strong></p>
  <p>${badge}</p>
  <p class="lead">${esc(proof.human_explanation)}</p>

  <h2>Agent</h2>
  <table>
    ${row("Agent", `<code>${esc(proof.agent_id)}</code>`)}
    ${row("Behavior hash", proof.behavior_hash ? `<code>${esc(proof.behavior_hash)}</code>` : "<em>unregistered</em>")}
  </table>

  <h2>Policy decision</h2>
  <table>
    ${row("Outcome", esc(proof.outcome))}
    ${row("Policy version", esc(proof.policy_version))}
    ${row("Policy hash", `<code>${esc(proof.policy_hash)}</code>`)}
    ${row("Matched rule", proof.matched_rule_id ? `<code>${esc(proof.matched_rule_id)}</code>` : "<em>none</em>")}
    ${row("Ledger snapshot", `<code>${esc(proof.ledger_snapshot_hash)}</code>`)}
  </table>

  <h2>§6 gate trace</h2>
  <table>
    <thead><tr><th>#</th><th>Check</th><th>Result</th><th>Detail</th></tr></thead>
    <tbody>${gateRows}</tbody>
  </table>

  <h2>Evidence</h2>
  <table>
    <thead><tr><th>Kind</th><th>Source</th><th>Trust</th><th>sha256</th><th>Parsed id</th></tr></thead>
    <tbody>${evidenceRows}</tbody>
  </table>

  <h2>Rail receipt</h2>
  ${railBlock}

  <h2>Audit chain</h2>
  <table>
    <thead><tr><th>Action</th><th>Layer</th><th>At</th><th>Event hash</th></tr></thead>
    <tbody>${auditRows}</tbody>
  </table>

  <h2>Merkle &amp; on-chain anchor</h2>
  <table>${row("Merkle root", `<code>${esc(proof.merkle_root)}</code>`)}</table>
  ${proofPath}
  ${anchorBlock}

  <h2>Verification</h2>
  <p>${badge}</p>
  <p class="muted">This page is a read-only projection re-derived on each request. Verify
  independently: <code>POST /v1/audit/verify</code> with the Merkle root, leaf, and proof
  path above${anchored ? ", or check the anchor transaction on the block explorer" : ""}.</p>
</body>
</html>`;
}

export async function registerProofViewRoute(
  app: FastifyInstance,
  deps: ProofRouteDeps,
): Promise<void> {
  app.get(
    "/proof/:action_id/view",
    async (request: FastifyRequest<{ Params: { action_id: string } }>, reply) => {
      const principal = request.principal;
      if (principal === undefined) {
        throw brainError("auth_token_missing", "principal required");
      }
      requireScope(principal.scopes, READ);
      const proof = await deps.buildProof(principal.tenantId, request.params.action_id);
      if (proof === null) {
        throw brainError("proof_not_found", "no proof for that action", { statusOverride: 404 });
      }
      reply.header("content-type", "text/html; charset=utf-8");
      return renderProofHtml(proof);
    },
  );
}
