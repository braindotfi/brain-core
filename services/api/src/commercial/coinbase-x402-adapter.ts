import { createHash } from "node:crypto";
import { generateJwt } from "@coinbase/cdp-sdk/auth";
import {
  X402_BASE_SEPOLIA_NETWORK,
  X402_BASE_SEPOLIA_USDC,
  X402_CDP_FACILITATOR_URL,
  X402_EXACT_SCHEME,
  X402_PROTOCOL_VERSION,
  type CoinbaseExactFacilitator,
  type X402V2ExactRequirements,
} from "./x402-seller-protocol.js";

const REQUEST_TIMEOUT_MS = 10_000;
export const X402_CDP_LOGICAL_OPERATIONS_PER_SECOND = 20;

export interface CoinbaseCdpTokenProvider {
  getAuthorizationHeader(input: {
    readonly method: "GET" | "POST";
    readonly path: string;
  }): Promise<string>;
}

export class CoinbaseCdpApiKeyTokenProvider implements CoinbaseCdpTokenProvider {
  constructor(
    private readonly credentials: {
      readonly apiKeyId: string;
      readonly apiKeySecret: string;
    },
    private readonly generate: typeof generateJwt = generateJwt,
  ) {}

  async getAuthorizationHeader(input: {
    readonly method: "GET" | "POST";
    readonly path: string;
  }): Promise<string> {
    const token = await this.generate({
      apiKeyId: this.credentials.apiKeyId,
      apiKeySecret: this.credentials.apiKeySecret,
      requestMethod: input.method,
      requestHost: new URL(X402_CDP_FACILITATOR_URL).host,
      requestPath: input.path,
      expiresIn: 120,
    });
    return `Bearer ${token}`;
  }
}

export interface X402SupportedWitness {
  readonly capturedAt: string;
  readonly responseDigestSha256: string;
  readonly protocolVersion: 2;
  readonly scheme: "exact";
  readonly network: typeof X402_BASE_SEPOLIA_NETWORK;
  readonly asset: typeof X402_BASE_SEPOLIA_USDC;
  readonly supported: true;
}

export interface CoinbaseX402AdapterOptions {
  readonly tokenProvider: CoinbaseCdpTokenProvider;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly facilitatorBaseUrl?: typeof X402_CDP_FACILITATOR_URL;
}

/**
 * A conservative logical-operation gate. Verify and settle for one operation
 * share one admission, so the configured cap is not accidentally doubled.
 */
export class CoinbaseX402OperationGate {
  private readonly starts: number[] = [];

  constructor(
    private readonly now: () => number = Date.now,
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  async enter(): Promise<void> {
    while (true) {
      const current = this.now();
      while (this.starts[0] !== undefined && this.starts[0] <= current - 1_000) {
        this.starts.shift();
      }
      if (this.starts.length < X402_CDP_LOGICAL_OPERATIONS_PER_SECOND) {
        this.starts.push(current);
        return;
      }
      await this.sleep(Math.max(1, this.starts[0]! + 1_000 - current));
    }
  }
}

export class CoinbaseX402Adapter implements CoinbaseExactFacilitator {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly now: () => number;
  private readonly gate: CoinbaseX402OperationGate;

  constructor(private readonly options: CoinbaseX402AdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.facilitatorBaseUrl ?? X402_CDP_FACILITATOR_URL;
    this.now = options.now ?? Date.now;
    this.gate = new CoinbaseX402OperationGate(this.now, options.sleep);
  }

  async captureSupportedWitness(): Promise<X402SupportedWitness> {
    const response = await this.request("GET", "/supported");
    const normalized = JSON.stringify(response);
    if (!supportsPinnedExactSepolia(response)) {
      throw new Error("Coinbase CDP does not advertise pinned Base Sepolia exact support");
    }
    return {
      capturedAt: new Date(this.now()).toISOString(),
      responseDigestSha256: createHash("sha256").update(normalized).digest("hex"),
      protocolVersion: X402_PROTOCOL_VERSION,
      scheme: X402_EXACT_SCHEME,
      network: X402_BASE_SEPOLIA_NETWORK,
      asset: X402_BASE_SEPOLIA_USDC,
      supported: true,
    };
  }

  async verify(input: {
    readonly paymentPayload: unknown;
    readonly paymentRequirements: X402V2ExactRequirements;
  }): Promise<{
    readonly valid: boolean;
    readonly payer: string | null;
    readonly reason: string | null;
  }> {
    const body = await this.request("POST", "/verify", {
      x402Version: X402_PROTOCOL_VERSION,
      paymentPayload: input.paymentPayload,
      paymentRequirements: input.paymentRequirements,
    });
    return {
      valid: getBoolean(body, "isValid", "valid"),
      payer: getNullableString(body, "payer"),
      reason: getNullableString(body, "invalidReason", "reason"),
    };
  }

  async settle(input: {
    readonly paymentPayload: unknown;
    readonly paymentRequirements: X402V2ExactRequirements;
  }): Promise<{
    readonly success: boolean;
    readonly payer: string;
    readonly transaction: string | null;
    readonly network: string;
    readonly errorReason: string | null;
  }> {
    const body = await this.request("POST", "/settle", {
      x402Version: X402_PROTOCOL_VERSION,
      paymentPayload: input.paymentPayload,
      paymentRequirements: input.paymentRequirements,
    });
    return {
      success: getBoolean(body, "success"),
      payer: getString(body, "payer"),
      transaction: getNullableString(body, "transaction", "transactionHash"),
      network: getString(body, "network"),
      errorReason: getNullableString(body, "errorReason", "reason"),
    };
  }

  async runLogicalOperation<T>(operation: () => Promise<T>): Promise<T> {
    await this.gate.enter();
    return operation();
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    const authorization = await this.options.tokenProvider.getAuthorizationHeader({
      method,
      path: url.pathname,
    });
    if (!authorization.startsWith("Bearer ")) {
      throw new Error("Coinbase CDP token provider returned an invalid authorization header");
    }
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        authorization,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Coinbase CDP ${path} failed with status ${response.status}`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`Coinbase CDP ${path} returned invalid JSON`);
    }
  }
}

function supportsPinnedExactSepolia(value: unknown): boolean {
  const kinds = asRecord(value).kinds;
  return (
    Array.isArray(kinds) &&
    kinds.some((kind) => {
      if (typeof kind !== "object" || kind === null || Array.isArray(kind)) return false;
      const record = kind as Record<string, unknown>;
      return (
        record.x402Version === X402_PROTOCOL_VERSION &&
        record.scheme === X402_EXACT_SCHEME &&
        (record.network === X402_BASE_SEPOLIA_NETWORK || record.network === "base-sepolia")
      );
    })
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Coinbase CDP response must be an object");
  }
  return value as Record<string, unknown>;
}

function getBoolean(value: unknown, ...names: string[]): boolean {
  const record = asRecord(value);
  for (const name of names) {
    if (typeof record[name] === "boolean") return record[name];
  }
  throw new Error(`Coinbase CDP response is missing boolean field ${names.join(" or ")}`);
}

function getString(value: unknown, ...names: string[]): string {
  const result = getNullableString(value, ...names);
  if (result === null) {
    throw new Error(`Coinbase CDP response is missing string field ${names.join(" or ")}`);
  }
  return result;
}

function getNullableString(value: unknown, ...names: string[]): string | null {
  const record = asRecord(value);
  for (const name of names) {
    if (record[name] === null) return null;
    if (typeof record[name] === "string") return record[name];
  }
  return null;
}
