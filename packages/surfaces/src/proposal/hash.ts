import { createHash } from "node:crypto";
import type { Proposal } from "./schema.js";

/**
 * Deterministic hash of the fields a human relies on when deciding. This is the
 * proof-of-what-was-shown anchor. The Slack message or email body is ephemeral.
 * This hash, written into the Audit layer alongside the approval, is the record.
 *
 * Excludes volatile or display-only fields that do not change the decision
 * (createdAt, contentHash itself). Includes everything the approver acts on.
 */
export function hashProposal(p: Proposal): string {
  const canonical = stableStringify({
    id: p.id,
    tenantId: p.tenantId,
    agent: p.agent,
    title: p.title,
    claim: p.claim,
    evidence: p.evidence,
    action: p.action,
    policy: p.policy,
    expiresAt: p.expiresAt,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Attach the content hash. Call once, at emit time, before dispatch. */
export function withContentHash(p: Proposal): Proposal {
  return { ...p, contentHash: hashProposal(p) };
}

/** Stable key ordering so the same logical proposal always hashes identically. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const body = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",");
  return `{${body}}`;
}
