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
  AlchemyWalletAdapter,
  EmailInboundAdapter,
  EthAddressAdapter,
  NetSuiteAdapter,
  OtherAdapter,
} from "./stubs.js";
import { StripeAdapter } from "./stripe.js";
import type { SourceAdapter } from "./types.js";
import { CsvUploadAdapter, PdfUploadAdapter } from "./upload.js";
import { CONNECTOR_DESCRIPTORS, type ConnectorDescriptor } from "./descriptors.js";
import { MergeAccountingAdapter } from "./merge_accounting.js";

const ADAPTERS: ReadonlyArray<SourceAdapter> = [
  CsvUploadAdapter,
  PdfUploadAdapter,
  PlaidAdapter,
  StripeAdapter,
  NetSuiteAdapter,
  EmailInboundAdapter,
  AlchemyWalletAdapter,
  EthAddressAdapter,
  AgentContributedAdapter,
  OtherAdapter,
  MergeAccountingAdapter,
];

const BY_SOURCE_TYPE = new Map<string, SourceAdapter>(ADAPTERS.map((a) => [a.sourceType, a]));
const BY_PROVIDER: ReadonlyMap<string, SourceAdapter> = new Map([
  ["plaid", PlaidAdapter],
  ["stripe", StripeAdapter],
  ["netsuite", NetSuiteAdapter],
  ["alchemy", AlchemyWalletAdapter],
  ["generic_hmac", OtherAdapter],
]);

export function adapterForSourceType(sourceType: string): SourceAdapter {
  const a = BY_SOURCE_TYPE.get(sourceType);
  if (a === undefined) {
    throw brainError("raw_source_unsupported", `unknown source_type: ${sourceType}`);
  }
  return a;
}

/**
 * Resolve the adapter for a source_type asserted via the GENERIC, caller-
 * supplied `/raw/ingest` route, rejecting provider-authenticated-only types.
 * A `raw:write` principal cannot label its upload `source_type: "plaid"` to mint
 * HIGH-trust evidence — `plaid`/`stripe` must arrive via the HMAC-verified
 * webhook (adapterForWebhookProvider), which is not subject to this check
 * (Codex 2026-06-06 P1 — authenticated provenance).
 */
export function adapterForGenericIngest(sourceType: string): SourceAdapter {
  const a = adapterForSourceType(sourceType);
  if (a.providerAuthenticatedOnly === true) {
    throw brainError(
      "raw_source_reserved",
      `source_type '${sourceType}' is reserved for the authenticated provider webhook ` +
        `(/raw/webhooks/${sourceType}) and cannot be asserted via /raw/ingest`,
    );
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

const DESCRIPTOR_BY_TYPE = new Map<string, ConnectorDescriptor>(
  CONNECTOR_DESCRIPTORS.map((d) => [d.connectorType, d]),
);

/** The §6 descriptor for a registered connector. */
export function descriptorForSourceType(sourceType: string): ConnectorDescriptor {
  const d = DESCRIPTOR_BY_TYPE.get(sourceType);
  if (d === undefined) {
    throw brainError("raw_source_unsupported", `no connector descriptor for: ${sourceType}`);
  }
  return d;
}

export function listDescriptors(): ReadonlyArray<ConnectorDescriptor> {
  return CONNECTOR_DESCRIPTORS;
}
