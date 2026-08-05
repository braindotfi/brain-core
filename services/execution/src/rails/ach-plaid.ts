/**
 * H-05 — Plaid Transfer ACH rail.
 *
 * Replaces the fabricated `stub: true` ACH receipt (rails/stubs.ts) with a real
 * two-step Plaid Transfer flow:
 *   1. /transfer/authorization/create — Plaid risk-checks the debit/credit.
 *   2. /transfer/create               — creates the transfer once approved.
 *
 * Both steps are keyed by the outbox row's `idempotency_key` (as Plaid's
 * `client_transaction_id` / `idempotency_key`), so a re-dispatch after a crash
 * returns the SAME transfer rather than moving money twice — this is the
 * money-mover exactly-once guarantee the outbox (H-04) depends on.
 *
 * ACH settles ASYNCHRONOUSLY. `dispatch` returns a `status: 'pending'` receipt;
 * the terminal state arrives later on the Plaid `TRANSFER_EVENTS_UPDATE` webhook
 * (`/raw/webhooks/plaid`). `applyPlaidTransferEvent` maps that event onto the
 * outbox row: a terminal success → `markSettled`, a return/failure/cancel →
 * `markFailed` (which bumps attempt_count and routes to `reconciling` once the
 * budget is exhausted).
 *
 * Dependency injection: this module deliberately does NOT import the `plaid`
 * SDK. The rail takes a minimal `PlaidTransferClient` (the two methods it uses),
 * so the dispatch logic is fully unit-testable with a mock. The real client is
 * constructed at boot from `new PlaidApi(...)` and adapted to this interface —
 * see services/execution/README.md. (Sandbox: the `plaid` package is not
 * installed, so the live client + sandbox round-trip are blocked here.)
 */

import { brainError, type TenantScopedClient } from "@brain/shared";
import type { Rail, RailDispatchInput, RailDispatchResult } from "./types.js";
import type { OutboxService } from "../outbox/OutboxService.js";

/** Tenant-scoped (or privileged) query surface the settlement path needs. */
type OutboxClient = Pick<TenantScopedClient, "query">;

/** Plaid /transfer/authorization/create response (minimal projection). */
export interface PlaidAuthorizationResponse {
  authorization: {
    id: string;
    decision: "approved" | "declined" | "user_action_required";
    decision_rationale?: { code: string; description: string } | null;
  };
}

/** Plaid /transfer/create response (minimal projection). */
export interface PlaidTransferResponse {
  transfer: { id: string; status: string };
}

/**
 * The two Plaid Transfer methods the rail uses. Mirrors the shape of the
 * official `plaid` SDK's `PlaidApi` so a thin adapter wires it at boot.
 */
export interface PlaidTransferClient {
  transferAuthorizationCreate(req: Record<string, unknown>): Promise<PlaidAuthorizationResponse>;
  transferCreate(req: Record<string, unknown>): Promise<PlaidTransferResponse>;
}

/** The action fields an ACH transfer proposal must carry. */
export interface AchTransferAction {
  /** Plaid item access token for the funding account. */
  access_token: string;
  /** Plaid account id to debit/credit. */
  account_id: string;
  /** Amount as a DECIMAL STRING (money math rule — never a float). */
  amount: string;
  /** "debit" pulls funds in, "credit" pushes funds out. Defaults to "credit". */
  type?: "debit" | "credit";
  /** ACH SEC code. Defaults to "ppd". */
  ach_class?: string;
  /** Defaults to "ach". */
  network?: string;
  /** Account holder legal name (required by Plaid). */
  user: { legal_name: string };
  /** Statement descriptor (Plaid caps at 15 chars). */
  description?: string;
  /**
   * F5 (H-05 follow-up): the ledger counterparty every gate check upstream
   * (5, 5.25, 6, 11.5, actor-not-payee) validated this dispatch against.
   * Required so the rail cannot silently drop the only field that ties the
   * Plaid call to the approved payee -- see the caveat on dispatch() below.
   */
  destination_counterparty_id: string;
}

function parseAchAction(action: Record<string, unknown>): AchTransferAction {
  const accessToken = action["access_token"];
  const accountId = action["account_id"];
  const amount = action["amount"];
  const user = action["user"];
  const legalName =
    typeof user === "object" && user !== null
      ? (user as Record<string, unknown>)["legal_name"]
      : undefined;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw brainError("validation_failed", "ACH action requires a string access_token");
  }
  if (typeof accountId !== "string" || accountId.length === 0) {
    throw brainError("validation_failed", "ACH action requires a string account_id");
  }
  // Money math: amount must be a non-empty decimal string, never a number.
  if (typeof amount !== "string" || !/^\d+(\.\d+)?$/.test(amount)) {
    throw brainError("validation_failed", "ACH action amount must be a decimal string");
  }
  if (typeof legalName !== "string" || legalName.length === 0) {
    throw brainError("validation_failed", "ACH action requires user.legal_name");
  }
  // F5: the payload already carries destination_counterparty_id (every rail's
  // input.action is built from the same base payload in
  // PaymentIntentService.execute) -- this rail simply never read it. Every
  // gate check that validated this payment (counterparty_allowed, trust,
  // verification threshold, duplicate-payment / vendor-swap detection,
  // actor-not-payee) did so against that id, so a dispatch that cannot bind
  // to it has no verified relationship to any approved payee and must fail
  // closed rather than silently proceed with only a funding-account identity.
  const destinationCounterpartyId = action["destination_counterparty_id"];
  if (typeof destinationCounterpartyId !== "string" || destinationCounterpartyId.length === 0) {
    throw brainError(
      "validation_failed",
      "ACH action requires a string destination_counterparty_id",
    );
  }
  const out: AchTransferAction = {
    access_token: accessToken,
    account_id: accountId,
    amount,
    user: { legal_name: legalName },
    destination_counterparty_id: destinationCounterpartyId,
  };
  const type = action["type"];
  if (type === "debit" || type === "credit") out.type = type;
  const achClass = action["ach_class"];
  if (typeof achClass === "string") out.ach_class = achClass;
  const network = action["network"];
  if (typeof network === "string") out.network = network;
  const description = action["description"];
  if (typeof description === "string") out.description = description;
  return out;
}

export interface AchPlaidRailDeps {
  client: PlaidTransferClient;
}

export class AchPlaidRail implements Rail {
  public readonly kind = "bank_ach" as const;
  private readonly client: PlaidTransferClient;

  public constructor(deps: AchPlaidRailDeps) {
    this.client = deps.client;
  }

  /**
   * F5 CAVEAT — read before touching account_id/access_token below. Both are
   * always resolved from the FUNDING (source) account's own Plaid credential
   * (PaymentIntentService.sourceCredentialResolver), never from
   * destination_counterparty_id, for BOTH "debit" and "credit" transfers.
   * Whether Plaid Transfer's `type: credit` actually requires the payee's
   * OWN linked Plaid item to land funds in their account, or genuinely
   * settles to an arbitrary counterparty via the funding account's own ACH
   * rail once authorized, is UNCONFIRMED — this codebase has no mechanism to
   * resolve a counterparty-side Plaid credential at all (no counterparty
   * equivalent of sourceCredentialResolver exists). This fix binds and
   * requires destination_counterparty_id (parseAchAction fails closed if it
   * is absent) and carries it into the receipt for forensic traceability; it
   * deliberately does NOT change which Plaid account_id/access_token the
   * transfer actually uses. Confirm the real fund-direction semantics against
   * a Plaid sandbox transfer before changing that part.
   */
  public async dispatch(input: RailDispatchInput): Promise<RailDispatchResult> {
    const action = parseAchAction(input.action);
    const type = action.type ?? "credit";
    const network = action.network ?? "ach";
    const achClass = action.ach_class ?? "ppd";

    // Step 1: authorization. Idempotency-keyed so a retry re-uses the decision.
    const auth = await this.client.transferAuthorizationCreate({
      access_token: action.access_token,
      account_id: action.account_id,
      type,
      network,
      amount: action.amount,
      ach_class: achClass,
      user: { legal_name: action.user.legal_name },
      idempotency_key: input.idempotencyKey,
    });

    if (auth.authorization.decision !== "approved") {
      throw brainError(
        "execution_rail_declined",
        `Plaid declined the ACH authorization (${auth.authorization.decision})`,
        { details: { decision_rationale: auth.authorization.decision_rationale ?? null } },
      );
    }

    // Step 2: create the transfer. `client_transaction_id` is Plaid's
    // idempotency token — a second create with the same key returns the SAME
    // transfer instead of moving money twice.
    const created = await this.client.transferCreate({
      access_token: action.access_token,
      account_id: action.account_id,
      authorization_id: auth.authorization.id,
      type,
      network,
      amount: action.amount,
      ach_class: achClass,
      description: (action.description ?? "Brain ACH").slice(0, 15),
      user: { legal_name: action.user.legal_name },
      client_transaction_id: input.idempotencyKey,
    });

    return {
      receipt: {
        rail: "ach",
        authorization_id: auth.authorization.id,
        transfer_id: created.transfer.id,
        status: "pending",
        destination_counterparty_id: action.destination_counterparty_id,
      },
    };
  }
}

/** A normalized Plaid transfer event (one entry of a TRANSFER_EVENTS_UPDATE sync). */
export interface PlaidTransferEvent {
  transfer_id: string;
  /** Plaid transfer status, e.g. "settled", "failed", "returned", "posted". */
  transfer_status: string;
}

/**
 * Map a Plaid transfer status onto an outbox settlement action.
 *   - settled / funds_available → terminal success
 *   - failed / returned / cancelled → terminal failure
 *   - everything else (pending / posted) → not yet terminal, ignore
 */
export function classifyPlaidTransferStatus(status: string): "settle" | "fail" | "pending" {
  switch (status) {
    case "settled":
    case "funds_available":
      return "settle";
    case "failed":
    case "returned":
    case "cancelled":
      return "fail";
    default:
      return "pending";
  }
}

/**
 * Apply a Plaid `TRANSFER_EVENTS_UPDATE` event to the durable outbox row that
 * dispatched it. Called by the `/raw/webhooks/plaid` handler after it resolves
 * the transfer_id → outbox row (the raw→execution wiring is a boot-time
 * integration point; the mapping + outbox mutation are unit-tested here).
 *
 * Returns the terminal state applied, or "ignored" for a non-terminal event.
 */
export async function applyPlaidTransferEvent(args: {
  outbox: OutboxService;
  client: OutboxClient;
  outboxId: string;
  event: PlaidTransferEvent;
}): Promise<"settled" | "failed" | "ignored"> {
  const decision = classifyPlaidTransferStatus(args.event.transfer_status);
  if (decision === "settle") {
    await args.outbox.markSettled(args.client, args.outboxId);
    return "settled";
  }
  if (decision === "fail") {
    await args.outbox.markFailed(
      args.client,
      args.outboxId,
      `plaid transfer ${args.event.transfer_id} ${args.event.transfer_status}`,
    );
    return "failed";
  }
  return "ignored";
}
