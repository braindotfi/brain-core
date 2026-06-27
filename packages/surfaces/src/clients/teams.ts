import { CardFactory, TurnContext } from "botbuilder";
import type {
  Activity,
  BotFrameworkAdapter,
  ConversationReference,
  WebRequest,
  WebResponse,
} from "botbuilder";
import type { TeamsActivityVerifier, VerifiedTeamsSubmit } from "../http/teams.js";
import type { TeamsClient } from "../surfaces/teams/adapter.js";
import type { TeamsSubmitData } from "../surfaces/teams/adaptivecard.js";

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

export class BotFrameworkTeamsActivityVerifier implements TeamsActivityVerifier {
  constructor(
    private readonly adapter: BotFrameworkAdapter,
    private readonly references: ConversationReferenceStore,
  ) {}

  async verify(input: {
    authorization: string | undefined;
    rawBody: string | Buffer;
  }): Promise<VerifiedTeamsSubmit | null> {
    const activity = parseActivity(input.rawBody);
    if (!activity) return null;

    let verified: VerifiedTeamsSubmit | null = null;
    const request: WebRequest = {
      body: activity,
      headers: { authorization: input.authorization ?? "" },
      method: "POST",
    };
    const response = new MemoryWebResponse();

    try {
      await this.adapter.processActivity(request, response, async (context) => {
        const submit = readSubmitData(context.activity.value);
        const aadObjectId = readAadObjectId(context.activity);
        const conversationRef = context.activity.conversation?.id;
        if (!submit || !aadObjectId || !conversationRef) return;

        await this.references.set(
          conversationRef,
          TurnContext.getConversationReference(context.activity),
        );
        verified = {
          submit,
          aadObjectId,
          conversationRef,
          ...(context.activity.replyToId !== undefined
            ? { activityId: context.activity.replyToId }
            : context.activity.id !== undefined
              ? { activityId: context.activity.id }
              : {}),
        };
      });
    } catch {
      return null;
    }

    return verified;
  }
}

export function rememberConversationReference(input: {
  store: ConversationReferenceStore;
  to: string;
  context: TurnContext;
}): Promise<void> {
  return input.store.set(input.to, TurnContext.getConversationReference(input.context.activity));
}

function parseActivity(rawBody: string | Buffer): Activity | null {
  try {
    const parsed = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody);
    if (!isRecord(parsed)) return null;
    return parsed as unknown as Activity;
  } catch {
    return null;
  }
}

function readSubmitData(value: unknown): TeamsSubmitData | null {
  if (!isRecord(value)) return null;
  const brainDecision = value.brainDecision;
  const tenantId = value.tenantId;
  const proposalId = value.proposalId;
  if (
    (brainDecision !== "approved" && brainDecision !== "rejected") ||
    typeof tenantId !== "string"
  ) {
    return null;
  }
  if (typeof proposalId !== "string") return null;
  return { brainDecision, tenantId, proposalId };
}

function readAadObjectId(activity: Activity): string | null {
  const fromAad = readString(activity.from, "aadObjectId");
  if (fromAad) return fromAad;
  const channelDataAad = readString(activity.channelData, "aadObjectId");
  if (channelDataAad) return channelDataAad;
  return null;
}

function readString(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const found = value[key];
  return typeof found === "string" && found.length > 0 ? found : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

class MemoryWebResponse implements WebResponse {
  statusCode = 200;
  sentBody: unknown;

  end(): MemoryWebResponse {
    return this;
  }

  send(body: unknown): MemoryWebResponse {
    this.sentBody = body;
    return this;
  }

  status(status: number): MemoryWebResponse {
    this.statusCode = status;
    return this;
  }
}
