/**
 * Standard memory-page section helpers.
 *
 * The seven canonical sections per Brain_MVP_Architecture.md §3 Layer 3:
 *   - Current Truth
 *   - Key Linked Entities
 *   - Recent Activity
 *   - Open Questions / Missing Evidence
 *   - Risk Notes
 *   - Timeline
 *   - Evidence Links
 *
 * Generators compose pages via these helpers so styling is consistent.
 */

import { createHash } from "node:crypto";

export interface PageSections {
  currentTruth: string;
  linkedEntities: string;
  recentActivity: string;
  openQuestions: string;
  riskNotes: string;
  timeline: string;
  evidenceLinks: string;
}

export function renderPage(title: string, sections: Partial<PageSections>): string {
  const lines: string[] = [`# ${title}`, ""];
  const order: Array<[keyof PageSections, string]> = [
    ["currentTruth", "Current Truth"],
    ["linkedEntities", "Key Linked Entities"],
    ["recentActivity", "Recent Activity"],
    ["openQuestions", "Open Questions / Missing Evidence"],
    ["riskNotes", "Risk Notes"],
    ["timeline", "Timeline"],
    ["evidenceLinks", "Evidence Links"],
  ];
  for (const [key, heading] of order) {
    const body = sections[key];
    if (body === undefined || body.trim().length === 0) continue;
    lines.push(`## ${heading}`);
    lines.push("");
    lines.push(body.trim());
    lines.push("");
  }
  return lines.join("\n");
}

/** Build a stable revision key from a flat list of (id, updated_at) pairs. */
export function revisionFromTouches(
  touches: ReadonlyArray<{ id: string; updated_at: Date }>,
): string {
  const ordered = [...touches].sort((a, b) => a.id.localeCompare(b.id));
  const payload = ordered.map((t) => `${t.id}|${t.updated_at.toISOString()}`).join("\n");
  return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 16);
}

export function bullet(items: ReadonlyArray<string>, fallback = "_None_"): string {
  if (items.length === 0) return fallback;
  return items.map((s) => `- ${s}`).join("\n");
}
