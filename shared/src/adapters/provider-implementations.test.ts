import { describe, expect, it, vi } from "vitest";
import {
  ComplyAdvantageOfacScreener,
  ComplyAdvantagePepScreener,
  OpenSanctionsOfacScreener,
  SumsubKycStore,
} from "./aml.js";
import {
  ChargeflowDisputeService,
  InMemoryCardIssuer,
  LiveStripeIssuingCardIssuer,
  PostmarkNotificationService,
  RailPaymentReversalService,
} from "./decision-execution.js";
import { GoogleWorkspaceDirectoryProvider, HttpSaaSVendorApi } from "./subscription.js";

const okFetch = vi.fn(async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    id: "prov_1",
    status: "submitted",
    content: { data: { hits: [] } },
    users: [{ status: "ACTIVE", profile: { email: "a@example.com", login: "A" } }],
    updatedAt: "2026-01-01T00:00:00Z",
    MessageID: "msg_1",
    ErrorCode: 0,
  }),
})) as unknown as typeof fetch;

describe("provider adapter implementations", () => {
  it("implements AML screening providers without live network", async () => {
    const now = new Date("2026-01-02T00:00:00Z");
    const subject = { tenant_id: "tnt_1", beneficiary_id: "ben_1", beneficiary_name: "Alice" };
    await expect(
      new ComplyAdvantageOfacScreener({
        apiKey: "key",
        endpoint: "https://example.test",
        fetchImpl: okFetch,
      }).screen(subject, now),
    ).resolves.toMatchObject({ status: "clear" });
    await expect(
      new ComplyAdvantagePepScreener({
        apiKey: "key",
        endpoint: "https://example.test",
        fetchImpl: okFetch,
      }).screen(subject, now),
    ).resolves.toMatchObject({ status: "clear" });
    await expect(
      new OpenSanctionsOfacScreener({
        endpoint: "https://example.test",
        fetchImpl: okFetch,
      }).screen(subject, now),
    ).resolves.toHaveProperty("lists_checked");
  });

  it("falls back when a provider call fails", async () => {
    const badFetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const card = new LiveStripeIssuingCardIssuer({ apiKey: "key", fetchImpl: badFetch });
    await expect(card.freeze("card_1")).resolves.toEqual(
      await new InMemoryCardIssuer().freeze("card_1"),
    );
  });

  it("implements KYC and execution providers behind existing interfaces", async () => {
    await expect(
      new SumsubKycStore({ appToken: "app", secret: "secret", fetchImpl: okFetch }).getFreshness(
        "tnt_1",
        "ben_1",
        new Date("2026-01-02T00:00:00Z"),
      ),
    ).resolves.toMatchObject({ status: "fresh" });
    await expect(
      new ChargeflowDisputeService({
        apiKey: "key",
        endpoint: "https://example.test",
        fetchImpl: okFetch,
      }).file("txn_1", "fraud"),
    ).resolves.toMatchObject({ status: "submitted" });
    await expect(
      new RailPaymentReversalService({ stripeApiKey: "key", fetchImpl: okFetch }).refund(
        "ch_1",
        "100",
        "requested_by_customer",
      ),
    ).resolves.toMatchObject({ status: "submitted" });
    await expect(
      new PostmarkNotificationService({
        apiKey: "key",
        fromEmail: "noreply@example.com",
        fetchImpl: okFetch,
      }).email("a@example.com", "Hello", "Body"),
    ).resolves.toMatchObject({ status: "sent" });
  });

  it("implements directory and SaaS vendor adapters", async () => {
    const directory = new GoogleWorkspaceDirectoryProvider({
      serviceAccountKey: JSON.stringify({ access_token: "token" }),
      fetchImpl: okFetch,
    });
    await expect(directory.listSubscriptionUsage("tnt_1", new Date())).resolves.toHaveLength(1);
    await expect(
      new HttpSaaSVendorApi({ provider: "slack_admin" }).requestSeatDowngrade({
        tenant_id: "tnt_1",
        subscription_id: "sub_1",
        seats: 2,
      }),
    ).resolves.toMatchObject({ status: "unsupported" });
  });
});
