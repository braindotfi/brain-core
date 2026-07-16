import type { Proposal } from "./schema.js";

export type SurfaceSanitizerTarget = "slack" | "teams" | "email";

export function sanitizeForSurface(text: string, surface: SurfaceSanitizerTarget): string {
  switch (surface) {
    case "slack":
      return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    case "teams":
      return text.replace(/([[\]()*_`])/g, "\\$1");
    case "email":
      return text;
  }
}

export function sanitizeProposalForSurface<TSurface extends SurfaceSanitizerTarget>(
  proposal: Proposal,
  surface: TSurface,
): Proposal {
  return {
    ...proposal,
    title: sanitizeForSurface(proposal.title, surface),
    claim: sanitizeForSurface(proposal.claim, surface),
    evidence: proposal.evidence.map((evidence) => ({
      ...evidence,
      label: sanitizeForSurface(evidence.label, surface),
      value: sanitizeForSurface(evidence.value, surface),
      ...(evidence.href !== undefined ? { href: sanitizeForSurface(evidence.href, surface) } : {}),
    })),
    action: {
      ...proposal.action,
      summary: sanitizeForSurface(proposal.action.summary, surface),
    },
  };
}
