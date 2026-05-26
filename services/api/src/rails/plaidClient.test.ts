/**
 * Unit tests for buildPlaidTransferClient (fix/main-green). The Plaid SDK is
 * mocked so no network is touched; we assert the adapter maps `res.data`.
 */

import { describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  transferAuthorizationCreate: vi.fn(),
  transferCreate: vi.fn(),
}));

vi.mock("plaid", () => ({
  PlaidApi: vi.fn(() => ({
    transferAuthorizationCreate: m.transferAuthorizationCreate,
    transferCreate: m.transferCreate,
  })),
  Configuration: vi.fn(),
  PlaidEnvironments: {
    sandbox: "https://sandbox.plaid.com",
    development: "https://development.plaid.com",
    production: "https://production.plaid.com",
  },
}));

import { buildPlaidTransferClient } from "./plaidClient.js";

describe("buildPlaidTransferClient", () => {
  it("maps transferAuthorizationCreate res.data", async () => {
    m.transferAuthorizationCreate.mockResolvedValue({
      data: { authorization: { id: "auth_1", decision: "approved" } },
    });
    const client = buildPlaidTransferClient({ clientId: "c", secret: "s", env: "sandbox" });
    const out = await client.transferAuthorizationCreate({
      access_token: "tok",
      account_id: "acct",
      type: "debit",
      network: "ach",
      amount: "10.00",
      ach_class: "ppd",
      user: { legal_name: "Jane" },
    } as never);
    expect(out).toEqual({ authorization: { id: "auth_1", decision: "approved" } });
  });

  it("maps transferCreate res.data", async () => {
    m.transferCreate.mockResolvedValue({ data: { transfer: { id: "tr_1", status: "pending" } } });
    const client = buildPlaidTransferClient({ clientId: "c", secret: "s", env: "production" });
    const out = await client.transferCreate({
      access_token: "tok",
      account_id: "acct",
      authorization_id: "auth_1",
      amount: "10.00",
      description: "rent",
    } as never);
    expect(out).toEqual({ transfer: { id: "tr_1", status: "pending" } });
  });
});
