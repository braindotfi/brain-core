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
  if (context.apiKeyCredentialClass !== "x402_pay_per_call") {
    throw new Error("x402 payment authorization requires an x402 pay-per-call credential");
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
  requireRpcConfirmation(transactionHash: string): Promise<void>;
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

  await input.finality.requireRpcConfirmation(settlement.transaction);
  await input.finality.requireSealed(settlement.transaction);
  const result = await input.fulfill();
  return { result, transactionHash: settlement.transaction, payer: settlement.payer };
}

export async function executeX402UpfrontSettlement<T>(input: {
  readonly authenticate: () => Promise<void>;
  readonly reserveAllowance: () => Promise<void>;
  readonly createQuote: () => Promise<X402V2ExactRequirements>;
  readonly captureFacilitatorSupport: () => Promise<void>;
  readonly facilitator: CoinbaseExactFacilitator;
  readonly finality: BaseSettlementFinality;
  readonly paymentPayload: unknown;
  readonly persistSettlement: (input: {
    readonly transactionHash: string;
    readonly payer: string;
  }) => Promise<void>;
  readonly executeHandler: () => Promise<T>;
  readonly persistFulfillment: (result: T) => Promise<void>;
  readonly queueMatchingRefund: (input: {
    readonly transactionHash: string;
    readonly payer: string;
    readonly reason: string;
  }) => Promise<void>;
}): Promise<T> {
  await input.authenticate();
  await input.reserveAllowance();
  const requirements = await input.createQuote();
  await input.captureFacilitatorSupport();
  const verification = await input.facilitator.verify({
    paymentPayload: input.paymentPayload,
    paymentRequirements: requirements,
  });
  if (!verification.valid) {
    throw new Error(`x402 verification failed: ${verification.reason ?? "unknown"}`);
  }
  const providerSettlement = await input.facilitator.settle({
    paymentPayload: input.paymentPayload,
    paymentRequirements: requirements,
  });
  if (!providerSettlement.success || providerSettlement.transaction === null) {
    throw new Error(`x402 settlement failed: ${providerSettlement.errorReason ?? "unknown"}`);
  }
  if (
    providerSettlement.network !== requirements.network &&
    !(
      requirements.network === X402_BASE_SEPOLIA_NETWORK &&
      providerSettlement.network === "base-sepolia"
    )
  ) {
    throw new Error("x402 settlement network does not match the quote");
  }
  await input.finality.requireRpcConfirmation(providerSettlement.transaction);
  await input.finality.requireSealed(providerSettlement.transaction);
  const settled = {
    transactionHash: providerSettlement.transaction,
    payer: providerSettlement.payer,
  };
  await input.persistSettlement(settled);
  try {
    const result = await input.executeHandler();
    await input.persistFulfillment(result);
    return result;
  } catch (error) {
    await input.queueMatchingRefund({
      ...settled,
      reason: error instanceof Error ? error.message : "handler_failed",
    });
    throw error;
  }
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
