import type { ApprovalOutcome } from "../core/approval.js";

export type PlainOutcome = "approved" | "held" | "pending" | "expired" | "denied" | "unknown";

export function toPlainOutcome(outcome: ApprovalOutcome | null): PlainOutcome {
  if (outcome === null) return "unknown";
  switch (outcome.status) {
    case "applied":
      return outcome.decision === "approved" ? "approved" : "held";
    case "awaiting_second_approval":
      return "pending";
    case "already_decided":
      return outcome.decision === "approved" ? "approved" : "held";
    case "expired":
      return "expired";
    case "denied":
      return "denied";
    case "unknown_actor":
      return "unknown";
  }
}

export function renderPlainOutcomePage(outcome: PlainOutcome): string {
  const copy: Record<PlainOutcome, string> = {
    approved: "Approved. Brain recorded the decision and handed it off.",
    held: "Held. Brain recorded the decision and took no action.",
    pending: "Recorded. Brain is waiting for a second approver.",
    expired: "Expired. This proposal can no longer be decided.",
    denied: "Denied. This identity is not authorized to decide this proposal.",
    unknown: "Unknown. This approval link or decision could not be resolved.",
  };
  return `<!doctype html><html><head><meta charset="utf-8"><title>Brain Approval</title></head><body><main><h1>${escapeHtml(copy[outcome])}</h1></main></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
