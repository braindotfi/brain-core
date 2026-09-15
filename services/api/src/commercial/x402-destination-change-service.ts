import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { requireChecksummedAddress } from "./x402-treasury-policy.js";

export const X402_DESTINATION_CHANGE_CONFIRMATION =
  "APPROVE_X402_SWEEP_DESTINATION_CHANGE_NO_BYPASS" as const;
export const X402_MAINNET_DESTINATION_DELAY_MS = 24 * 60 * 60 * 1_000;

export interface X402DestinationApproval {
  readonly actor: string;
  readonly approvedAt: Date;
}

export interface X402DestinationChangeInput {
  readonly environment: "sandbox" | "live";
  readonly address: string;
  readonly approvedSha: string;
  readonly requestedAt: Date;
  readonly treasury: X402DestinationApproval;
  readonly security: X402DestinationApproval;
  readonly testTransferTxHash: string;
  readonly confirmation: typeof X402_DESTINATION_CHANGE_CONFIRMATION;
  readonly manifestDigest: string;
}

export interface X402TestTransferVerifier {
  verify(input: {
    readonly environment: "sandbox" | "live";
    readonly destination: `0x${string}`;
    readonly transactionHash: `0x${string}`;
  }): Promise<boolean>;
}

export class X402DestinationChangeService {
  constructor(
    private readonly pool: Pool,
    private readonly testTransferVerifier: X402TestTransferVerifier,
  ) {}

  async authorize(input: X402DestinationChangeInput): Promise<{
    readonly id: string;
    readonly effectiveAt: Date;
  }> {
    const destination = requireChecksummedAddress(input.address);
    if (input.treasury.actor === input.security.actor) {
      throw new Error("x402 destination change requires two different human approvers");
    }
    if (input.confirmation !== X402_DESTINATION_CHANGE_CONFIRMATION) {
      throw new Error("x402 destination change confirmation does not match");
    }
    if (!/^[0-9a-f]{40}$/.test(input.approvedSha)) {
      throw new Error("x402 destination change requires an exact lowercase commit SHA");
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(input.testTransferTxHash)) {
      throw new Error("x402 destination change requires a test-transfer transaction hash");
    }
    const expectedDigest = x402DestinationChangeManifestDigest({
      environment: input.environment,
      address: destination,
      approvedSha: input.approvedSha,
      testTransferTxHash: input.testTransferTxHash,
    });
    if (expectedDigest !== input.manifestDigest) {
      throw new Error("x402 destination change manifest digest does not match");
    }
    const transferVerified = await this.testTransferVerifier.verify({
      environment: input.environment,
      destination,
      transactionHash: input.testTransferTxHash as `0x${string}`,
    });
    if (!transferVerified) throw new Error("x402 destination test transfer is not confirmed");

    const laterApproval = Math.max(
      input.treasury.approvedAt.getTime(),
      input.security.approvedAt.getTime(),
    );
    const effectiveAt = new Date(
      laterApproval + (input.environment === "live" ? X402_MAINNET_DESTINATION_DELAY_MS : 0),
    );
    const id = `x402dest_${randomUUID()}`;
    await this.pool.query(
      `INSERT INTO x402_sweep_destination_changes (
         id, environment, checksummed_address, manifest_digest, requested_at,
         treasury_approved_by, treasury_approved_at, security_approved_by,
         security_approved_at, effective_at, test_transfer_tx_hash,
         confirmation_phrase
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        input.environment,
        destination,
        input.manifestDigest,
        input.requestedAt,
        input.treasury.actor,
        input.treasury.approvedAt,
        input.security.actor,
        input.security.approvedAt,
        effectiveAt,
        input.testTransferTxHash,
        input.confirmation,
      ],
    );
    return { id, effectiveAt };
  }
}

export function x402DestinationChangeManifestDigest(input: {
  readonly environment: "sandbox" | "live";
  readonly address: string;
  readonly approvedSha: string;
  readonly testTransferTxHash: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        environment: input.environment,
        address: requireChecksummedAddress(input.address),
        approved_sha: input.approvedSha,
        test_transfer_tx_hash: input.testTransferTxHash.toLowerCase(),
      }),
    )
    .digest("hex");
}
