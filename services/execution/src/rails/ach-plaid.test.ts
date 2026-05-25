/**
 * H-05 — Plaid Transfer ACH rail tests.
 *
 * The live `plaid` SDK + sandbox round-trip are blocked in this environment
 * (the package is not installed). These tests exercise the full rail logic
 * against a mock PlaidTransferClient: the two-step authorization→create flow,
 * the idempotency-key threading, the declined-authorization path, and the
 * webhook settlement mapper. The sandbox integration test (gated behind
 * BRAIN_PLAID_SANDBOX_INTEGRATION=1) is documented in README.md.
 */

import { describe, expect, it, vi } from "vitest";
import { BrainError, type TenantScopedClient } from "@brain/shared";
import {
  AchPlaidRail,
  applyPlaidTransferEvent,
  classifyPlaidTransferStatus,
  type PlaidAuthorizationResponse,
  type PlaidTransferClient,
  type PlaidTransferResponse,
} from "./ach-plaid.js";
import { OutboxService } from "../outbox/OutboxService.js";
import type { RailDispatchInput } from "./types.js";

function dispatchInput(overrides: Partial<RailDispatchInput> = {}): RailDispatchInput {
  return {
    tenantId: "tnt_1",
    proposalId: "prop_1",
    executionId: "exec_1",
    idempotencyKey: "pi:pi_1:dec_1",
    action: {
      access_token: "access-sandbox-1",
      account_id: "acct_1",
      amount: "1000.00",
      type: "credit",
      user: { legal_name: "Acme Inc" },
      description: "Invoice 42 payment",
    },
    ...overrides,
  };
}

/** A mock Plaid client that records calls and returns canned/idempotent replies. */
function mockPlaid(opts?: { decision?: PlaidAuthorizationResponse["authorization"]["decision"] }): {
  client: PlaidTransferClient;
  authCalls: Array<Record<string, unknown>>;
  createCalls: Array<Record<string, unknown>>;
} {
  const authCalls: Array<Record<string, unknown>> = [];
  const createCalls: Array<Record<string, unknown>> = [];
  // Model Plaid's idempotency: same client_transaction_id → same transfer.
  const byClientTxn = new Map<string, PlaidTransferResponse>();
  let seq = 0;
  const client: PlaidTransferClient = {
    transferAuthorizationCreate: vi.fn(async (req: Record<string, unknown>) => {
      authCalls.push(req);
      return {
        authorization: { id: `auth_${++seq}`, decision: opts?.decision ?? "approved" },
      } satisfies PlaidAuthorizationResponse;
    }),
    transferCreate: vi.fn(async (req: Record<string, unknown>) => {
      createCalls.push(req);
      const key = String(req["client_transaction_id"]);
      const existing = byClientTxn.get(key);
      if (existing !== undefined) return existing;
      const fresh: PlaidTransferResponse = {
        transfer: { id: `xfer_${byClientTxn.size + 1}`, status: "pending" },
      };
      byClientTxn.set(key, fresh);
      return fresh;
    }),
  };
  return { client, authCalls, createCalls };
}

describe("AchPlaidRail.dispatch", () => {
  it("runs authorization then create, threading the idempotency key into both", async () => {
    const { client, authCalls, createCalls } = mockPlaid();
    const rail = new AchPlaidRail({ client });
    const input = dispatchInput();

    const { receipt } = await rail.dispatch(input);

    expect(receipt).toEqual({
      rail: "ach",
      authorization_id: "auth_1",
      transfer_id: "xfer_1",
      status: "pending",
    });
    // Two-call sequence, in order.
    expect(authCalls).toHaveLength(1);
    expect(createCalls).toHaveLength(1);
    expect(authCalls[0]?.["idempotency_key"]).toBe(input.idempotencyKey);
    expect(createCalls[0]?.["client_transaction_id"]).toBe(input.idempotencyKey);
    expect(createCalls[0]?.["authorization_id"]).toBe("auth_1");
    // Statement descriptor is clamped to Plaid's 15-char limit.
    expect(String(createCalls[0]?.["description"]).length).toBeLessThanOrEqual(15);
  });

  it("rejects a declined authorization without creating a transfer", async () => {
    const { client, createCalls } = mockPlaid({ decision: "declined" });
    const rail = new AchPlaidRail({ client });

    await expect(rail.dispatch(dispatchInput())).rejects.toMatchObject({
      code: "execution_rail_declined",
    });
    expect(createCalls).toHaveLength(0);
  });

  it("is idempotent: a second dispatch with the same key returns the same transfer", async () => {
    const { client, createCalls } = mockPlaid();
    const rail = new AchPlaidRail({ client });
    const input = dispatchInput();

    const first = await rail.dispatch(input);
    const second = await rail.dispatch(input);

    expect(second.receipt["transfer_id"]).toBe(first.receipt["transfer_id"]);
    // Both create calls used the same client_transaction_id.
    expect(createCalls).toHaveLength(2);
    expect(createCalls[0]?.["client_transaction_id"]).toBe(
      createCalls[1]?.["client_transaction_id"],
    );
  });

  it("rejects a non-decimal-string amount (money-math invariant)", async () => {
    const { client } = mockPlaid();
    const rail = new AchPlaidRail({ client });
    const bad = dispatchInput({
      action: { access_token: "a", account_id: "b", amount: 1000, user: { legal_name: "x" } },
    });
    await expect(rail.dispatch(bad)).rejects.toBeInstanceOf(BrainError);
  });
});

describe("classifyPlaidTransferStatus", () => {
  it("treats settled / funds_available as terminal success", () => {
    expect(classifyPlaidTransferStatus("settled")).toBe("settle");
    expect(classifyPlaidTransferStatus("funds_available")).toBe("settle");
  });
  it("treats failed / returned / cancelled as terminal failure", () => {
    expect(classifyPlaidTransferStatus("failed")).toBe("fail");
    expect(classifyPlaidTransferStatus("returned")).toBe("fail");
    expect(classifyPlaidTransferStatus("cancelled")).toBe("fail");
  });
  it("treats pending / posted as not-yet-terminal", () => {
    expect(classifyPlaidTransferStatus("pending")).toBe("pending");
    expect(classifyPlaidTransferStatus("posted")).toBe("pending");
  });
});

function fakeOutboxClient(): {
  client: Pick<TenantScopedClient, "query">;
  sql: string[];
} {
  const sql: string[] = [];
  const client = {
    query: vi.fn(async (text: string) => {
      sql.push(text);
      // markFailed RETURNs attempt_count.
      if (text.includes("attempt_count + 1")) {
        return { rows: [{ attempt_count: 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as Pick<TenantScopedClient, "query">;
  return { client, sql };
}

describe("applyPlaidTransferEvent (webhook settlement)", () => {
  it("settles the outbox row on a terminal success event", async () => {
    const { client, sql } = fakeOutboxClient();
    const outbox = new OutboxService();
    const result = await applyPlaidTransferEvent({
      outbox,
      client,
      outboxId: "exo_1",
      event: { transfer_id: "xfer_1", transfer_status: "settled" },
    });
    expect(result).toBe("settled");
    expect(sql.some((s) => s.includes("status = 'settled'"))).toBe(true);
  });

  it("fails the outbox row (bumping attempt_count) on a returned event", async () => {
    const { client, sql } = fakeOutboxClient();
    const outbox = new OutboxService();
    const result = await applyPlaidTransferEvent({
      outbox,
      client,
      outboxId: "exo_1",
      event: { transfer_id: "xfer_1", transfer_status: "returned" },
    });
    expect(result).toBe("failed");
    expect(sql.some((s) => s.includes("attempt_count + 1"))).toBe(true);
  });

  it("ignores a non-terminal event without touching the outbox", async () => {
    const { client, sql } = fakeOutboxClient();
    const outbox = new OutboxService();
    const result = await applyPlaidTransferEvent({
      outbox,
      client,
      outboxId: "exo_1",
      event: { transfer_id: "xfer_1", transfer_status: "posted" },
    });
    expect(result).toBe("ignored");
    expect(sql).toHaveLength(0);
  });
});
