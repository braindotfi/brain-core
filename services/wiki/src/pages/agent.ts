/**
 * /agents/{agent_id} — page generator.
 *
 * Cross-service read: services/wiki reads from the `agents` table owned by
 * services/execution. This is the same exception pattern used by
 * LedgerService.normalizeFromRaw reading raw_parsed — read-only access to
 * a derived index used by the memory layer. Writes never cross the layer.
 * Surfaced here for review: the correct long-term fix is to expose an
 * IAgentService.findById read method and call it via the service contract.
 */

import type { PageGenerationContext, PageGenerationOutput, PageGenerator } from "./types.js";
import { bullet, renderPage, revisionFromTouches } from "./sections.js";

export class AgentPageGenerator implements PageGenerator {
  public readonly pageType = "agent" as const;

  public resolveSlug(slugOrId: string): { subjectId: string | null; slug: string } | null {
    if (slugOrId.startsWith("agent_")) {
      return { subjectId: slugOrId, slug: `/agents/${slugOrId}` };
    }
    if (slugOrId.startsWith("/agents/")) {
      const id = slugOrId.slice("/agents/".length);
      return { subjectId: id, slug: slugOrId };
    }
    return null;
  }

  public async render(
    deps: PageGenerationContext,
    subject: { subjectId: string | null; slug: string },
  ): Promise<PageGenerationOutput> {
    const id = subject.subjectId;
    if (id === null) throw new Error("AgentPageGenerator requires a subject id");

    const agent = await fetchAgent(deps, id);
    if (agent === null) throw new Error(`agent ${id} not found`);
    const recentIntents = await fetchRecentPaymentIntents(deps, id);

    const currentTruth =
      `**${agent.display_name}**\n` +
      `Kind: \`${agent.kind}\` · Role: \`${agent.role}\`\n` +
      `State: \`${agent.state}\`\n` +
      (agent.onchain_address !== null ? `On-chain address: \`${agent.onchain_address}\`\n` : "") +
      (agent.registered_at !== null
        ? `Registered: ${agent.registered_at.toISOString().slice(0, 10)}`
        : "Not yet registered on-chain");

    const recentActivity = bullet(
      recentIntents.map(
        (pi) =>
          `${pi.created_at.toISOString().slice(0, 10)} — PaymentIntent \`${pi.id}\` ` +
          `${pi.action_type} ${pi.amount} ${pi.currency} (${pi.status})`,
      ),
      "_No recent payment intents from this agent._",
    );

    const openQuestions =
      agent.state === "revoked"
        ? "**Revoked.** This agent's scope has been revoked and it can no longer execute actions."
        : agent.state === "failed"
          ? "**Registration failed.** On-chain registration did not complete. Check the registered_tx and retry."
          : agent.state === "pending_onchain"
            ? "Pending on-chain confirmation. The agent cannot act until registration is confirmed."
            : "_None._";

    const riskNotes =
      agent.state === "revoked"
        ? "Agent is revoked — any in-flight proposals from this agent should be reviewed and rejected."
        : agent.state === "failed"
          ? "Registration failed — investigate the on-chain transaction before re-registering."
          : "_No risk flags._";

    const timeline =
      agent.registered_at !== null
        ? `Registered on-chain: ${agent.registered_at.toISOString().slice(0, 10)}`
        : "_Awaiting on-chain registration._";

    const revision = revisionFromTouches([
      { id: agent.id, updated_at: agent.created_at },
      ...recentIntents.map((pi) => ({ id: pi.id, updated_at: pi.created_at })),
    ]);

    return {
      page_type: this.pageType,
      subject_id: id,
      slug: subject.slug,
      body_md: renderPage(`Agent · ${agent.display_name}`, {
        currentTruth,
        recentActivity,
        openQuestions,
        riskNotes,
        timeline,
      }),
      source_revision: revision,
    };
  }
}

interface AgentRow {
  id: string;
  kind: string;
  role: string;
  display_name: string;
  onchain_address: string | null;
  state: string;
  registered_at: Date | null;
  created_at: Date;
}

async function fetchAgent(deps: PageGenerationContext, id: string): Promise<AgentRow | null> {
  const { rows } = await deps.client.query<AgentRow>(
    `SELECT id, kind, role, display_name, onchain_address, state, registered_at, created_at
       FROM agents WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

interface PaymentIntentRow {
  id: string;
  action_type: string;
  amount: string;
  currency: string;
  status: string;
  created_at: Date;
}

async function fetchRecentPaymentIntents(
  deps: PageGenerationContext,
  agentId: string,
): Promise<PaymentIntentRow[]> {
  const { rows } = await deps.client.query<PaymentIntentRow>(
    `SELECT id, action_type, amount::TEXT, currency, status, created_at
       FROM ledger_payment_intents
      WHERE created_by_agent_id = $1
      ORDER BY created_at DESC
      LIMIT 10`,
    [agentId],
  );
  return rows;
}
