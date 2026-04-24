/**
 * Stubbed source adapters for MVP providers whose webhook ingestion is
 * deferred per Brain_Claude_Code_Prompt.docx §Stage 2:
 *
 * > Webhook signature verification for Plaid first; stub the other
 * > providers' webhook handlers to return 501 until we build them
 *
 * These adapters register themselves so /raw/ingest with source_type =
 * stripe|erp_netsuite|email|chain_evm succeeds (the caller supplies the
 * bytes directly) while the webhook path returns 501.
 */

import { brainError } from "@brain/api/shared";
import type { SourceAdapter } from "./types.js";

function unsupportedWebhook(provider: string): SourceAdapter["handleWebhook"] {
  return async () => {
    throw brainError(
      "raw_source_unsupported",
      `${provider} webhook ingestion is not implemented yet (stage-2 stub)`,
      { statusOverride: 501 },
    );
  };
}

export const StripeAdapter: SourceAdapter = {
  sourceType: "stripe",
  handleWebhook: unsupportedWebhook("stripe"),
};

export const NetSuiteAdapter: SourceAdapter = {
  sourceType: "erp_netsuite",
  handleWebhook: unsupportedWebhook("netsuite"),
};

export const GmailAdapter: SourceAdapter = {
  sourceType: "email",
  handleWebhook: unsupportedWebhook("gmail"),
};

export const EvmAdapter: SourceAdapter = {
  sourceType: "chain_evm",
  handleWebhook: unsupportedWebhook("alchemy"),
};

export const AgentContributedAdapter: SourceAdapter = {
  sourceType: "agent_contributed",
};
