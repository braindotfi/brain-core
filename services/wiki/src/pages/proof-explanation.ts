/**
 * H-07 Proof narrative renderer (Wiki layer).
 *
 * Renders the 2–4 sentence `human_explanation` for a Proof. This is a DERIVED
 * VIEW: it reads the already-assembled, structured proof and produces prose. It
 * is NOT a source of truth and performs no Ledger/Policy reads — preserving the
 * Wiki invariant (§8.4). The Proof API attaches the returned string to the
 * structured proof it serves.
 */

import type { Proof } from "@brain/shared";

/** The structured proof fields the narrative reads (everything but the prose). */
export type ProofExplanationInput = Omit<Proof, "human_explanation">;

function outcomeClause(outcome: Proof["outcome"]): string {
  switch (outcome) {
    case "executed":
      return "was executed after clearing the deterministic pre-execution gate";
    case "failed":
      return "cleared the gate but the payment rail reported a failure";
    case "rejected":
      return "was rejected by the pre-execution gate";
    case "confirmed":
      return "cleared the gate and is awaiting the required human confirmation";
    case "allowed":
      return "was allowed by policy and gated, pending settlement";
    case "shadow_completed":
      return "ran in shadow mode — fully gated and recorded, but no money moved";
  }
}

export function renderProofExplanation(p: ProofExplanationInput): string {
  const agent = p.agent_id === "" ? "An agent" : `Agent ${p.agent_id}`;
  const passed = p.gate_checks.filter((c) => c.passed).length;
  const total = p.gate_checks.length;
  const ruleClause = p.matched_rule_id !== null ? ` under rule ${p.matched_rule_id}` : "";

  const sentences: string[] = [];
  sentences.push(`${agent}'s action ${p.action_id} ${outcomeClause(p.outcome)}.`);
  sentences.push(
    `${passed} of ${total} §6 gate checks passed against policy version ${p.policy_version || "unknown"}${ruleClause}, ` +
      `supported by ${p.evidence.length} evidence artifact${p.evidence.length === 1 ? "" : "s"}.`,
  );

  if (p.outcome === "executed" && p.rail_receipt !== null) {
    sentences.push("The payment rail returned a settlement receipt.");
  }

  if (p.chain_anchor !== null) {
    sentences.push(
      `Every step is recorded on Brain's append-only audit chain, anchored on ${p.chain_anchor.chain} ` +
        `(tx ${p.chain_anchor.tx_hash}); the Merkle root makes this proof independently verifiable.`,
    );
  } else {
    sentences.push(
      "Every step is recorded on Brain's append-only audit chain; once the next batch is anchored on-chain the " +
        "Merkle root will make this proof independently verifiable.",
    );
  }

  return sentences.join(" ");
}
