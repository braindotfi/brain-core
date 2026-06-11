/**
 * Finch source adapter (scaffolded).
 *
 * TODO(connector): implement the modality methods this provider needs and
 * update the ConnectorDescriptor capability claims to match:
 *  - handleWebhook for signed provider push (add the verifier in
 *    shared/src/webhooks/finch.ts and the provider mapping in registry.ts)
 *  - fetchIncremental + syncObjectTypes for the authenticated pull path
 *    (per-object-type SyncPartition checkpoints, ingestion architecture §10)
 *
 * Until then the connector lands artifacts via the generic /raw/ingest push
 * at customer-push trust, which already works with zero further code.
 */

import type { SourceAdapter } from "./types.js";

export const FinchAdapter: SourceAdapter = {
  sourceType: "finch",
};
