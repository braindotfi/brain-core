/**
 * MCP resources. Stable `brain://...` URIs that resolve to JSON
 * snapshots of Brain entities. Resources are syntactic sugar over the
 * equivalent tools — useful for clients that pin URIs in their context.
 *
 * Scope checks are identical to the corresponding tool: reading
 * `brain://ledger/...` requires `ledger:read`, etc.
 */

import { brainError } from "@brain/shared";
import type { ResourceDescriptor, ResourceListResult, ResourceReadResult } from "./types.js";
import type { ToolContext } from "./tools/types.js";

export const RESOURCE_DESCRIPTORS: ReadonlyArray<ResourceDescriptor> = [
  {
    uri: "brain://ledger/accounts/{account_id}",
    name: "Account",
    description: "Account row + latest balance.",
    mimeType: "application/json",
  },
  {
    uri: "brain://ledger/transactions/{transaction_id}",
    name: "Transaction",
    description: "Transaction row.",
    mimeType: "application/json",
  },
  {
    uri: "brain://ledger/obligations/{obligation_id}",
    name: "Obligation",
    description: "Obligation row.",
    mimeType: "application/json",
  },
  {
    uri: "brain://ledger/payment-intents/{id}",
    name: "PaymentIntent",
    description: "PaymentIntent row + PolicyDecision id.",
    mimeType: "application/json",
  },
  {
    uri: "brain://wiki/pages/{slug}",
    name: "Wiki page",
    description: "Memory page (markdown body).",
    mimeType: "text/markdown",
  },
  {
    uri: "brain://payments/action_types",
    name: "PaymentIntent action types",
    description: "Canonical action_type vocabulary + required fields for payment_intent.propose.",
    mimeType: "application/json",
  },
];

/**
 * Canonical payment-intent action-type vocabulary, served read-only so an agent
 * can discover exactly what to send to payment_intent.propose. On-chain
 * settlement types are requested by NAME — there is no implicit
 * onchain_transfer→x402/escrow resolver — and each lists the extra fields the
 * propose tool requires (validated identically on the HTTP route).
 */
const ACTION_TYPE_CATALOG = {
  description:
    "action_type vocabulary for payment_intent.propose. On-chain settlement types are named explicitly (no implicit resolver from onchain_transfer).",
  action_types: [
    { action_type: "ach_outbound", currency: "ISO-4217 (3-letter)", required_fields: [] },
    { action_type: "ach_inbound", currency: "ISO-4217 (3-letter)", required_fields: [] },
    { action_type: "wire", currency: "ISO-4217 (3-letter)", required_fields: [] },
    { action_type: "card_payment", currency: "ISO-4217 (3-letter)", required_fields: [] },
    { action_type: "erp_writeback", currency: "ISO-4217 (3-letter)", required_fields: [] },
    { action_type: "onchain_transfer", currency: "ISO-4217 (3-letter)", required_fields: [] },
    {
      action_type: "x402_settle",
      currency: "USDC",
      required_fields: ["pay_to"],
      note: "pay_to = 0x EVM recipient; §6 gate check 6.5 re-validates it against the counterparty address.",
    },
    {
      action_type: "escrow_release",
      currency: "USDC",
      required_fields: ["escrow_id", "job_terms_hash"],
      note: "0x bytes32 escrow_id + job_terms_hash; §6 gate check 6.6 binds them to the on-chain BrainEscrow lock.",
    },
  ],
} as const;

export interface ResourceScopeRequirement {
  scopes: string[];
}

export function listResources(): ResourceListResult {
  return { resources: [...RESOURCE_DESCRIPTORS] };
}

/**
 * Resolve a brain:// URI to a JSON-string body via the same Brain
 * services the tools call. Throws BrainError on missing resources;
 * the dispatcher maps to the right JSON-RPC code.
 */
export async function readResource(
  uri: string,
  ctx: ToolContext,
): Promise<{ result: ResourceReadResult; requiredScopes: string[] }> {
  const parsed = parseBrainUri(uri);
  if (parsed === null) {
    throw brainError("request_params_invalid", `unsupported resource URI: ${uri}`);
  }

  switch (parsed.kind) {
    case "ledger.account": {
      const result = await ctx.ledger.getAccount(ctx.ctx, parsed.id);
      if (result === null) throw brainError("ledger_row_not_found", "account not found");
      return {
        requiredScopes: ["ledger:read"],
        result: {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify(result, null, 2),
            },
          ],
        },
      };
    }
    case "ledger.transaction": {
      const result = await ctx.ledger.getTransaction(ctx.ctx, parsed.id);
      if (result === null) throw brainError("ledger_row_not_found", "transaction not found");
      return {
        requiredScopes: ["ledger:read"],
        result: {
          contents: [{ uri, mimeType: "application/json", text: JSON.stringify(result, null, 2) }],
        },
      };
    }
    case "ledger.obligation": {
      const list = await ctx.ledger.listObligations(ctx.ctx, { limit: 1 });
      const match = list.items.find((o) => o.id === parsed.id);
      if (match === undefined) throw brainError("ledger_row_not_found", "obligation not found");
      return {
        requiredScopes: ["ledger:read"],
        result: {
          contents: [{ uri, mimeType: "application/json", text: JSON.stringify(match, null, 2) }],
        },
      };
    }
    case "ledger.payment_intent": {
      const result = await ctx.paymentIntents.get(ctx.ctx, parsed.id);
      if (result === null) throw brainError("payment_intent_not_found", "payment intent not found");
      return {
        requiredScopes: ["ledger:read"],
        result: {
          contents: [{ uri, mimeType: "application/json", text: JSON.stringify(result, null, 2) }],
        },
      };
    }
    case "wiki.page": {
      const page = await ctx.wiki.getPage(ctx.ctx, parsed.id);
      if (page === null) throw brainError("wiki_page_not_found", "page not found");
      return {
        requiredScopes: ["wiki:read"],
        result: {
          contents: [{ uri, mimeType: "text/markdown", text: page.body_md }],
        },
      };
    }
    case "payments.action_types": {
      return {
        requiredScopes: ["payment_intent:propose"],
        result: {
          contents: [
            { uri, mimeType: "application/json", text: JSON.stringify(ACTION_TYPE_CATALOG, null, 2) },
          ],
        },
      };
    }
  }
}

interface ParsedBrainUri {
  kind:
    | "ledger.account"
    | "ledger.transaction"
    | "ledger.obligation"
    | "ledger.payment_intent"
    | "wiki.page"
    | "payments.action_types";
  id: string;
}

/**
 * Parse a brain:// URI. Returns null on a URI shape we don't recognize
 * so the caller can throw a structured error. Accepts both
 * `brain://ledger/accounts/acct_X` and `brain://ledger/accounts/acct_X/`
 * with optional trailing slash.
 */
export function parseBrainUri(uri: string): ParsedBrainUri | null {
  if (!uri.startsWith("brain://")) return null;
  const rest = uri.slice("brain://".length).replace(/\/+$/, "");
  const segments = rest.split("/");
  // Collection-level resource (no id): the static action-type catalog.
  if (segments.length === 2 && segments[0] === "payments" && segments[1] === "action_types") {
    return { kind: "payments.action_types", id: "" };
  }
  if (segments.length < 3) return null;
  const [layer, collection, id] = segments;
  if (layer === "ledger" && collection === "accounts" && id) return { kind: "ledger.account", id };
  if (layer === "ledger" && collection === "transactions" && id)
    return { kind: "ledger.transaction", id };
  if (layer === "ledger" && collection === "obligations" && id)
    return { kind: "ledger.obligation", id };
  if (layer === "ledger" && collection === "payment-intents" && id)
    return { kind: "ledger.payment_intent", id };
  if (layer === "wiki" && collection === "pages" && id) return { kind: "wiki.page", id };
  return null;
}
