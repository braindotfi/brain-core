/**
 * Plaid source adapter.
 *
 * Accepts Plaid webhooks (already signature-verified by the webhook route)
 * and produces artifacts whose body is the JSON payload + source_ref
 * capturing the webhook identifier for idempotency.
 *
 * Real Plaid ingestion also fetches transactions via `transactions/sync`.
 * That path lands alongside the extractor pipeline in stage-3 (the Plaid
 * API client itself ships in @brain/raw's `plaid` dep).
 */

import { brainError } from "@brain/shared";
import type { FetchedArtifact, SourceAdapter } from "./types.js";

interface PlaidWebhookEnvelope {
  webhook_type?: string;
  webhook_code?: string;
  item_id?: string;
  webhook_id?: string;
  // Plaid varies the remaining shape by webhook_code; we keep the payload
  // as-is for the Wiki extraction pipeline in stage-3.
}

export const PlaidAdapter: SourceAdapter = {
  sourceType: "plaid",
  async handleWebhook(_tenantId, rawBody): Promise<FetchedArtifact[]> {
    let parsed: PlaidWebhookEnvelope;
    try {
      parsed = JSON.parse(rawBody.toString("utf8")) as PlaidWebhookEnvelope;
    } catch {
      throw brainError("request_body_invalid", "Plaid webhook body was not JSON");
    }

    const webhookId = parsed.webhook_id ?? parsed.item_id ?? "unknown";
    const webhookType = parsed.webhook_type ?? "unknown";
    const webhookCode = parsed.webhook_code ?? "unknown";

    return [
      {
        body: rawBody,
        mimeType: "application/json",
        sourceRef: {
          provider: "plaid",
          webhook_id: webhookId,
          webhook_type: webhookType,
          webhook_code: webhookCode,
          item_id: parsed.item_id ?? null,
        },
      },
    ];
  },
};
