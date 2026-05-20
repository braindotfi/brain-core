import { createPublicClient, createWalletClient, http, keccak256, toBytes, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
// Inlined from @brain/audit to avoid a circular tsc project-reference:
// services/audit references ../api, so services/api cannot import @brain/audit.
interface BroadcastInput {
  tenantId: string;
  merkleRoot: Buffer;
  eventCount: number;
  periodStart: Date;
  periodEnd: Date;
}
interface BroadcastResult {
  txHash: Buffer;
  blockNumber: bigint;
}
type AnchorBroadcaster = (input: BroadcastInput) => Promise<BroadcastResult>;

const BRAIN_AUDIT_ANCHOR_ABI = [
  {
    name: "anchor",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tenantId", type: "bytes32" },
      { name: "root", type: "bytes32" },
      { name: "eventCount", type: "uint256" },
      { name: "periodStart", type: "uint256" },
      { name: "periodEnd", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

export interface ViemAnchorBroadcasterOptions {
  privateKey: `0x${string}`;
  contractAddress: `0x${string}`;
  rpcUrl: string;
}

export function createViemAnchorBroadcaster(opts: ViemAnchorBroadcasterOptions): AnchorBroadcaster {
  const account = privateKeyToAccount(opts.privateKey);
  const transport = http(opts.rpcUrl);

  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport,
  });

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport,
  });

  return async function broadcastAnchor(input: BroadcastInput): Promise<BroadcastResult> {
    const tenantIdBytes = keccak256(toBytes(input.tenantId)) as `0x${string}`;
    const rootHex = toHex(input.merkleRoot) as `0x${string}`;

    const txHash = await walletClient.writeContract({
      address: opts.contractAddress,
      abi: BRAIN_AUDIT_ANCHOR_ABI,
      functionName: "anchor",
      args: [
        tenantIdBytes,
        rootHex,
        BigInt(input.eventCount),
        BigInt(Math.floor(input.periodStart.getTime() / 1000)),
        BigInt(Math.floor(input.periodEnd.getTime() / 1000)),
      ],
    });

    const RECEIPT_TIMEOUT_MS = 5 * 60 * 1000;
    const receipt = await Promise.race([
      publicClient.waitForTransactionReceipt({ hash: txHash }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(`waitForTransactionReceipt timed out after ${RECEIPT_TIMEOUT_MS / 1000}s`),
            ),
          RECEIPT_TIMEOUT_MS,
        ),
      ),
    ]);
    return {
      txHash: Buffer.from(txHash.slice(2), "hex"),
      blockNumber: receipt.blockNumber,
    };
  };
}
