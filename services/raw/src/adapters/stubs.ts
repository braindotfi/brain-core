/**
 * Stubbed source adapters for MVP providers whose webhook ingestion is
 * deferred per Brain_Claude_Code_Prompt.docx §Stage 2:
 *
 * > Webhook signature verification for Plaid first; stub the other
 * > providers' webhook handlers to return 501 until we build them
 *
 * These adapters register themselves so /raw/ingest with the matching
 * source_type succeeds (the caller supplies the bytes directly) while the
 * webhook path returns 501.
 *
 * Source types here come from the single provider-named vocabulary in
 * `../sources/types.ts` (`ARTIFACT_SOURCE_TYPES`); the old artifact-side
 * aliases (`erp_netsuite`, `email`, `chain_evm`, `upload`) were reconciled
 * away by migration raw/0007.
 */

import { brainError } from "@brain/shared";
import type { SourceAdapter } from "./types.js";

function unsupportedWebhook(provider: string): NonNullable<SourceAdapter["handleWebhook"]> {
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
  // High-trust provider: only the authenticated webhook may create stripe
  // artifacts, never the generic caller-supplied /raw/ingest route.
  providerAuthenticatedOnly: true,
  handleWebhook: unsupportedWebhook("stripe"),
};

export const NetSuiteAdapter: SourceAdapter = {
  sourceType: "netsuite",
  handleWebhook: unsupportedWebhook("netsuite"),
};

export const EmailInboundAdapter: SourceAdapter = {
  sourceType: "email_inbound",
  handleWebhook: unsupportedWebhook("gmail"),
};

export const AlchemyWalletAdapter: SourceAdapter = {
  sourceType: "alchemy_wallet",
  handleWebhook: unsupportedWebhook("alchemy"),
};

export const EthAddressAdapter: SourceAdapter = {
  sourceType: "eth_address",
};

export const AgentContributedAdapter: SourceAdapter = {
  sourceType: "agent_contributed",
};

/**
 * Universal fallback: a source with no native connector lands through the
 * generic push/file entrypoint as opaque bytes tagged `other`, today, with
 * zero new code. A parser can promote it later (ingestion architecture,
 * Appendix B case 3).
 */
export const OtherAdapter: SourceAdapter = {
  sourceType: "other",
};
