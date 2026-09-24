import { brainError, withTenantScope, type ServiceCallContext } from "@brain/shared";
import type {
  CollectionsEmailSender,
  CollectionsSendEmailInput,
  CollectionsSendEmailResult,
} from "@brain/execution";
import type { Pool } from "pg";
import type { NylasAdapter } from "./adapter.js";
import { getGrant } from "./store.js";

export class NylasCollectionsEmailSender implements CollectionsEmailSender {
  public constructor(
    private readonly pool: Pool,
    private readonly adapter: NylasAdapter,
  ) {}

  public async send(
    ctx: ServiceCallContext,
    input: CollectionsSendEmailInput,
  ): Promise<CollectionsSendEmailResult> {
    return withTenantScope(this.pool, ctx.tenantId, async (client) => {
      const grant = await getGrant(client);
      if (grant === null) {
        throw brainError("integration_provider_not_configured", "email not connected", {
          statusOverride: 409,
          details: {
            friendly_message:
              "Connect Email and calendar in Sources before sending collections email.",
          },
        });
      }
      const sent = await this.adapter.sendEmail({
        grantId: grant.grant_id,
        to: input.to,
        subject: input.subject,
        body: input.body,
        replyTo: grant.email,
        ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      });
      await client.query(
        `UPDATE proposals
            SET sent_message_id = $2,
                sent_thread_id = $3,
                delivery_status = 'sent',
                sent_at = now()
          WHERE id = $1
            AND tenant_id = current_setting('app.tenant_id', true)`,
        [input.proposalId, sent.messageId, sent.threadId],
      );
      return {
        messageId: sent.messageId,
        threadId: sent.threadId,
        sentFrom: grant.email,
      };
    });
  }
}
