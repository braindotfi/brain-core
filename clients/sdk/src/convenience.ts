/**
 * Top-level convenience surface — the everyday methods on the docs
 * Build pages (https://docs.brain.fi/build/*).
 *
 * These are thin wrappers around the namespace methods. The positional
 * `tenantId` first arg matches the docs Build samples; under the hood
 * each method delegates to the object-args namespace method.
 *
 * Methods:
 *   brain.ask(tenantId, question)
 *   brain.pay(tenantId, opts)
 *   brain.approve(actionId, { as })
 *   brain.reject(actionId, { as, reason })
 *   brain.proof(actionId)
 *   brain.trace(actionId)
 *
 * @packageDocumentation
 */

import type { ActionsModule } from "./actions/index.js";
import type { AuditModule, AuditEvent, AuditProof } from "./audit/index.js";
import type { WikiModule, WikiAnswer } from "./wiki/index.js";

/** Args accepted by `brain.pay(tenantId, opts)`. */
export interface PayInput {
  /** Pay an invoice end-to-end. Either this or (to + amount + currency) is required. */
  readonly invoiceId?: string;
  /** Explicit destination + amount path. */
  readonly to?: { counterpartyId: string };
  readonly amount?: string;
  readonly currency?: string;
  readonly sourceAccountId?: string;
  readonly memo?: string;
  readonly idempotencyKey?: string;
  /**
   * Override the action `type`. Defaults to `"pay_invoice"` when
   * `invoiceId` is set; otherwise `"outbound_payment"`.
   */
  readonly type?: string;
}

/** Trace = the list of events for an action, ordered ascending. */
export interface ActionTrace {
  readonly events: readonly AuditEvent[];
}

/**
 * Construction-time dependency bag. The Brain class instantiates this
 * and passes it to the ConvenienceSurface constructor; tests can
 * substitute mocks for each module.
 */
export interface ConvenienceDeps {
  readonly actions: ActionsModule;
  readonly audit: AuditModule;
  readonly wiki: WikiModule;
}

/**
 * Container for the top-level convenience methods. Composed into the
 * `Brain` class via `Object.assign(this, new ConvenienceSurface(...))`
 * to keep the public surface flat (`brain.ask(...)`, not
 * `brain.convenience.ask(...)`).
 */
export class ConvenienceSurface {
  public constructor(private readonly d: ConvenienceDeps) {}

  /**
   * Natural-language question. Convenience for `brain.wiki.question`.
   * @see https://docs.brain.fi/introduction/quickstart
   */
  public async ask(tenantId: string, question: string): Promise<WikiAnswer> {
    return this.d.wiki.question({ tenantId, question });
  }

  /**
   * Propose a payment. When the policy decision is `ALLOW`, the SDK
   * auto-executes the action and returns the post-execute state — that's
   * the "auto" status the docs publish on the build page. When the
   * decision is `ESCALATE`, the action stays in `needs_approval` and
   * the caller's approval UI takes over. When `DENY`, the returned
   * action is terminal in `rejected`.
   *
   * @see https://docs.brain.fi/build/pay-an-invoice-safely
   */
  public async pay(
    tenantId: string,
    opts: PayInput,
  ): Promise<import("./actions/index.js").Action> {
    const type =
      opts.type ??
      (opts.invoiceId !== undefined ? "pay_invoice" : "outbound_payment");

    const created = await this.d.actions.create({
      tenantId,
      type,
      ...(opts.invoiceId !== undefined ? { invoiceId: opts.invoiceId } : {}),
      ...(opts.to !== undefined ? { to: opts.to } : {}),
      ...(opts.amount !== undefined ? { amount: opts.amount } : {}),
      ...(opts.currency !== undefined ? { currency: opts.currency } : {}),
      ...(opts.sourceAccountId !== undefined
        ? { sourceAccountId: opts.sourceAccountId }
        : {}),
      ...(opts.memo !== undefined ? { memo: opts.memo } : {}),
      ...(opts.idempotencyKey !== undefined
        ? { idempotencyKey: opts.idempotencyKey }
        : {}),
    });

    // Auto-execute on ALLOW per docs Build sample. The SDK matches docs
    // semantics: `action.status === "auto"` means "ran successfully
    // without human intervention".
    if (created.decision === "ALLOW") {
      await this.d.actions.execute(created.id);
      // Re-fetch to surface the post-execute state (status: executed,
      // tx_hash, settled_at).
      return this.d.actions.get(created.id);
    }
    return created;
  }

  /**
   * Sign approval on an action that's in `needs_approval`.
   * Convenience for `brain.actions.approve(actionId, { as })`.
   *
   * @see https://docs.brain.fi/build/pay-an-invoice-safely
   */
  public async approve(
    actionId: string,
    opts: { as?: string; idempotencyKey?: string } = {},
  ): Promise<import("./actions/index.js").Action> {
    return this.d.actions.approve(actionId, opts);
  }

  /**
   * Reject an action.
   * Convenience for `brain.actions.reject(actionId, opts)`.
   */
  public async reject(
    actionId: string,
    opts: { as?: string; reason?: string; idempotencyKey?: string } = {},
  ): Promise<import("./actions/index.js").Action> {
    return this.d.actions.reject(actionId, opts);
  }

  /**
   * Retrieve a verifiable receipt for an action. Returns the Merkle
   * proof bundle (anchored_root + base_tx_hash + base_block +
   * merkle_path) for off-line verification against the on-chain anchor.
   *
   * Convenience for `brain.audit.proof(eventId)`, with eventId resolved
   * from the action's audit chain.
   *
   * @see https://docs.brain.fi/build/audit-every-action
   */
  public async proof(actionId: string): Promise<AuditProof> {
    const trail = await this.actionTrail(actionId);
    // Prefer the .executed event for the receipt. If the action hasn't
    // executed yet, fall back to the latest event in the trail.
    const executed = [...trail.events]
      .reverse()
      .find((e) =>
        typeof e.action === "string" && e.action.endsWith(".executed"),
      );
    const target = executed ?? trail.events[trail.events.length - 1];
    if (target === undefined || typeof target.id !== "string") {
      throw new Error(
        `@brain/sdk: no audit events found for action ${actionId}`,
      );
    }
    return this.d.audit.proof(target.id);
  }

  /**
   * Retrieve the full audit trace for an action — every event from
   * proposed → settled, in chronological order.
   *
   * Convenience for `audit.byEntity("payment_intent", actionId)`. The
   * underlying entity type is `payment_intent` because action_id and
   * payment_intent_id share an id namespace in v0.3.
   *
   * @see https://docs.brain.fi/build/audit-every-action
   */
  public async trace(actionId: string): Promise<ActionTrace> {
    const trail = await this.actionTrail(actionId);
    return { events: trail.events };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async actionTrail(
    actionId: string,
  ): Promise<{ events: AuditEvent[] }> {
    const result = await this.d.audit.byEntity("payment_intent", actionId);
    return { events: result.events };
  }
}
