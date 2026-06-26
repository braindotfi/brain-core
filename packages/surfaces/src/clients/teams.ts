import { CardFactory, TurnContext } from "botbuilder";
import type { BotFrameworkAdapter, ConversationReference } from "botbuilder";
import type { TeamsClient } from "../surfaces/teams/adapter.js";

export interface ConversationReferenceStore {
  get(to: string): Promise<Partial<ConversationReference> | null>;
  set(to: string, reference: Partial<ConversationReference>): Promise<void>;
}

export class InMemoryConversationReferenceStore implements ConversationReferenceStore {
  private readonly refs = new Map<string, Partial<ConversationReference>>();

  async get(to: string): Promise<Partial<ConversationReference> | null> {
    return this.refs.get(to) ?? null;
  }

  async set(to: string, reference: Partial<ConversationReference>): Promise<void> {
    this.refs.set(to, reference);
  }
}

export class TeamsBotFrameworkClient implements TeamsClient {
  constructor(
    private readonly adapter: BotFrameworkAdapter,
    private readonly appId: string,
    private readonly references: ConversationReferenceStore,
  ) {}

  async postConversationReference(to: string, reference: ConversationReference): Promise<void> {
    await this.references.set(to, reference);
  }

  async sendCard(args: {
    conversationRef: string;
    card: Record<string, unknown>;
  }): Promise<{ ok: boolean; activityId?: string; error?: string }> {
    const reference = await this.references.get(args.conversationRef);
    if (!reference) return { ok: false, error: "missing_conversation_reference" };

    let activityId: string | undefined;
    await this.adapter.continueConversationAsync(this.appId, reference, async (context) => {
      const response = await context.sendActivity({
        attachments: [CardFactory.adaptiveCard(args.card)],
      });
      activityId = response?.id;
    });

    return {
      ok: true,
      ...(activityId !== undefined ? { activityId } : {}),
    };
  }

  async updateCard(args: {
    conversationRef: string;
    activityId: string;
    card: Record<string, unknown>;
  }): Promise<{ ok: boolean; error?: string }> {
    const reference = await this.references.get(args.conversationRef);
    if (!reference) return { ok: false, error: "missing_conversation_reference" };

    await this.adapter.continueConversationAsync(this.appId, reference, async (context) => {
      await context.updateActivity({
        type: "message",
        id: args.activityId,
        attachments: [CardFactory.adaptiveCard(args.card)],
      });
    });
    return { ok: true };
  }
}

export function rememberConversationReference(input: {
  store: ConversationReferenceStore;
  to: string;
  context: TurnContext;
}): Promise<void> {
  return input.store.set(input.to, TurnContext.getConversationReference(input.context.activity));
}
