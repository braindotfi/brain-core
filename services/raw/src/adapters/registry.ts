/**
 * Source adapter registry. Centralizes the source_type → adapter mapping.
 *
 * A request with an unknown source_type returns raw_source_unsupported
 * rather than silently accepting unstructured data.
 */

import { brainError } from "@brain/shared";
import { PlaidAdapter } from "./plaid.js";
import {
  AgentContributedAdapter,
  EvmAdapter,
  GmailAdapter,
  NetSuiteAdapter,
  StripeAdapter,
} from "./stubs.js";
import type { SourceAdapter } from "./types.js";
import { UploadAdapter } from "./upload.js";

const ADAPTERS: ReadonlyArray<SourceAdapter> = [
  UploadAdapter,
  PlaidAdapter,
  StripeAdapter,
  NetSuiteAdapter,
  GmailAdapter,
  EvmAdapter,
  AgentContributedAdapter,
];

const BY_SOURCE_TYPE = new Map(ADAPTERS.map((a) => [a.sourceType, a]));
const BY_PROVIDER: ReadonlyMap<string, SourceAdapter> = new Map([
  ["plaid", PlaidAdapter],
  ["stripe", StripeAdapter],
  ["netsuite", NetSuiteAdapter],
  ["alchemy", EvmAdapter],
  ["generic_hmac", UploadAdapter],
]);

export function adapterForSourceType(sourceType: string): SourceAdapter {
  const a = BY_SOURCE_TYPE.get(sourceType);
  if (a === undefined) {
    throw brainError("raw_source_unsupported", `unknown source_type: ${sourceType}`);
  }
  return a;
}

export function adapterForWebhookProvider(provider: string): SourceAdapter {
  const a = BY_PROVIDER.get(provider);
  if (a === undefined) {
    throw brainError("raw_source_unsupported", `unknown webhook provider: ${provider}`);
  }
  return a;
}

export function listAdapters(): ReadonlyArray<SourceAdapter> {
  return ADAPTERS;
}
