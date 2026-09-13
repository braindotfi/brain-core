import type { Principal } from "@brain/shared";

export const X402_PROTOCOL_VERSION = 2 as const;
export const X402_EXACT_SCHEME = "exact" as const;
export const X402_BASE_SEPOLIA_NETWORK = "eip155:84532" as const;
export const X402_BASE_MAINNET_NETWORK = "eip155:8453" as const;
export const X402_BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
export const X402_CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402" as const;

export interface X402V2ExactRequirements {
  readonly x402Version: typeof X402_PROTOCOL_VERSION;
  readonly scheme: typeof X402_EXACT_SCHEME;
  readonly network: typeof X402_BASE_SEPOLIA_NETWORK | typeof X402_BASE_MAINNET_NETWORK;
  readonly asset: string;
  readonly amount: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds: 60;
  readonly extra: Readonly<{ name: "USDC"; version: "2" }>;
}

export interface X402SellerCredentialContext {
  readonly principal?: Principal;
  readonly presentedCredential?: string;
  readonly apiKeyCredentialClass?: "commercial_included" | "x402_pay_per_call";
}

export function assertX402SellerCredentialEligible(context: X402SellerCredentialContext): void {
  if (
    context.presentedCredential?.startsWith("brain_ak_") === true ||
    context.principal?.type === "agent" ||
    context.principal?.credentialId !== undefined
  ) {
    throw new Error("brain_ak_* agent credentials are never eligible for x402 payment");
  }
  if (
    context.apiKeyCredentialClass !== undefined &&
    context.apiKeyCredentialClass !== "x402_pay_per_call" &&
    context.apiKeyCredentialClass !== "commercial_included"
  ) {
    throw new Error("unsupported x402 credential class");
  }
}

export interface CoinbaseExactFacilitator {
  verify(input: {
    readonly paymentPayload: unknown;
    readonly paymentRequirements: X402V2ExactRequirements;
  }): Promise<{
    readonly valid: boolean;
    readonly payer: string | null;
    readonly reason: string | null;
  }>;
  settle(input: {
    readonly paymentPayload: unknown;
    readonly paymentRequirements: X402V2ExactRequirements;
  }): Promise<{
    readonly success: boolean;
    readonly payer: string;
    readonly transaction: string | null;
    readonly network: string;
    readonly errorReason: string | null;
  }>;
}

export interface BaseSettlementFinality {
  requireSealed(transactionHash: string): Promise<void>;
}

export async function settleBeforeFulfillment<T>(input: {
  readonly facilitator: CoinbaseExactFacilitator;
  readonly finality: BaseSettlementFinality;
  readonly requirements: X402V2ExactRequirements;
  readonly paymentPayload: unknown;
  readonly fulfill: () => Promise<T>;
}): Promise<{ readonly result: T; readonly transactionHash: string; readonly payer: string }> {
  const verification = await input.facilitator.verify({
    paymentPayload: input.paymentPayload,
    paymentRequirements: input.requirements,
  });
  if (!verification.valid) {
    throw new Error(`x402 verification failed: ${verification.reason ?? "unknown"}`);
  }

  const settlement = await input.facilitator.settle({
    paymentPayload: input.paymentPayload,
    paymentRequirements: input.requirements,
  });
  if (!settlement.success || settlement.transaction === null) {
    throw new Error(`x402 settlement failed: ${settlement.errorReason ?? "unknown"}`);
  }
  if (
    settlement.network !== input.requirements.network &&
    !(
      input.requirements.network === X402_BASE_SEPOLIA_NETWORK &&
      settlement.network === "base-sepolia"
    )
  ) {
    throw new Error("x402 settlement network does not match the quote");
  }

  await input.finality.requireSealed(settlement.transaction);
  const result = await input.fulfill();
  return { result, transactionHash: settlement.transaction, payer: settlement.payer };
}

export const COINBASE_X402_COMPATIBILITY_WITNESS = Object.freeze({
  assessedAt: "2026-09-13T00:00:00Z",
  protocolVersion: X402_PROTOCOL_VERSION,
  scheme: X402_EXACT_SCHEME,
  network: X402_BASE_SEPOLIA_NETWORK,
  asset: X402_BASE_SEPOLIA_USDC,
  facilitatorBaseUrl: X402_CDP_FACILITATOR_URL,
  settlePath: "/settle",
  resourceServerStrategy: "low_level_settle_before_handler",
  stockAuthorizationMiddlewareAccepted: false,
  documentarySources: [
    "https://docs.cdp.coinbase.com/api-reference/v2/rest-api/x402-facilitator/settle-payment",
    "https://docs.cdp.coinbase.com/x402/support/faq",
    "https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md",
  ],
});
