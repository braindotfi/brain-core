/**
 * /policies/{policy_id} — page generator.
 *
 * Reads policy state through the injected PolicyReader (a port backed by the
 * owning Policy service), never by querying the `policies` table directly —
 * the sanctioned Wiki read-projection covers Ledger tables only.
 */

import { brainError } from "@brain/shared";
import type { PageGenerationContext, PageGenerationOutput, PageGenerator } from "./types.js";
import { bullet, renderPage, revisionFromTouches } from "./sections.js";

export class PolicyPageGenerator implements PageGenerator {
  public readonly pageType = "policy" as const;

  public resolveSlug(slugOrId: string): { subjectId: string | null; slug: string } | null {
    if (slugOrId.startsWith("pol_")) {
      return { subjectId: slugOrId, slug: `/policies/${slugOrId}` };
    }
    if (slugOrId === "/policies/active" || slugOrId === "active") {
      return { subjectId: null, slug: "/policies/active" };
    }
    if (slugOrId.startsWith("/policies/")) {
      const id = slugOrId.slice("/policies/".length);
      return { subjectId: id, slug: slugOrId };
    }
    return null;
  }

  public async render(
    deps: PageGenerationContext,
    subject: { subjectId: string | null; slug: string },
  ): Promise<PageGenerationOutput> {
    if (deps.policyReader === undefined) {
      throw brainError(
        "dependency_unavailable",
        "policy reader not configured for this deployment",
      );
    }
    const policy =
      subject.subjectId !== null
        ? await deps.policyReader.byId(deps.ctx, subject.subjectId)
        : await deps.policyReader.active(deps.ctx);

    if (policy === null) {
      const body = renderPage("Policy", {
        currentTruth: "_No active policy found for this tenant._",
        riskNotes:
          "**No active policy.** Payment intents cannot be approved without an active policy. Create and activate a policy immediately.",
      });
      return {
        page_type: this.pageType,
        subject_id: subject.subjectId,
        slug: subject.slug,
        body_md: body,
        source_revision: "no_policy",
      };
    }

    const signers: Array<{ address: string }> = policy.signers;

    const currentTruth =
      `**Policy v${policy.version}**\n` +
      `State: \`${policy.state}\`\n` +
      `Quorum required: ${policy.quorum_required} signature(s)\n` +
      (policy.activated_at !== null
        ? `Activated: ${policy.activated_at.toISOString().slice(0, 10)}\n`
        : "") +
      (policy.deactivated_at !== null
        ? `Deactivated: ${policy.deactivated_at.toISOString().slice(0, 10)}\n`
        : "") +
      `Created by: \`${policy.created_by}\``;

    const linkedEntities = bullet(
      signers.map((s) => `Signer: \`${s.address}\``),
      "_No signers recorded._",
    );

    const openQuestions =
      policy.state === "pending_signatures"
        ? `Awaiting signatures: need ${policy.quorum_required} signer(s); ${signers.length} signed so far.`
        : policy.state === "draft"
          ? "Policy is in draft. It must be submitted for signatures before activation."
          : "_None._";

    const riskNotes =
      policy.state === "deactivated"
        ? "This policy version is no longer active. If no replacement is active, payment execution is blocked."
        : policy.state === "cancelled" || policy.state === "expired"
          ? `Policy is \`${policy.state}\`. No payments can execute under this policy.`
          : "_No risk flags._";

    const timeline = [
      policy.activated_at !== null
        ? `Activated: ${policy.activated_at.toISOString().slice(0, 10)}`
        : null,
      policy.deactivated_at !== null
        ? `Deactivated: ${policy.deactivated_at.toISOString().slice(0, 10)}`
        : null,
    ]
      .filter((s): s is string => s !== null)
      .join("\n");

    const revision = revisionFromTouches([{ id: policy.id, updated_at: policy.created_at }]);

    return {
      page_type: this.pageType,
      subject_id: policy.id,
      slug: subject.subjectId !== null ? subject.slug : `/policies/${policy.id}`,
      body_md: renderPage(`Policy · v${policy.version}`, {
        currentTruth,
        linkedEntities,
        openQuestions,
        riskNotes,
        ...(timeline.length > 0 ? { timeline } : {}),
      }),
      source_revision: revision,
    };
  }
}
