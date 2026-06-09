import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseGwei,
  toBytes,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

/**
 * Base Sepolia's reported gas price can be sub-0.01 gwei, which viem turns into
 * a maxPriorityFeePerGas too low to mine; the publisher then re-broadcasts at
 * the same price and the node rejects each with "replacement transaction
 * underpriced", so the anchor never lands. Floor the fees to a sane minimum
 * (and take the max with the network estimate). Overridable via env.
 */
function gweiFloor(envName: string, defaultGwei: string): bigint {
  const raw = process.env[envName];
  const value = raw !== undefined && raw.trim() !== "" ? raw.trim() : defaultGwei;
  const n = Number(value);
  return parseGwei(Number.isFinite(n) && n > 0 ? value : defaultGwei);
}
// Inlined from @brain/audit to avoid a circular tsc project-reference:
// services/audit references ../api, so services/api cannot import @brain/audit.
interface BroadcastInput {
  tenantId: string;
  merkleRoot: Buffer;
  eventCount: number;
  periodStart: Date;
  periodEnd: Date;
}
// confirmed        — tx mined status=1; AnchorPublished emitted.
// already_anchored — the root was already published on-chain; skip the redundant
//                    broadcast and return the original winning tx.
// reverted         — tx mined status=0, OR the call deterministically reverts at
//                    estimate time. Terminal: the caller must NOT retry.
type BroadcastStatus = "confirmed" | "already_anchored" | "reverted";
interface BroadcastResult {
  txHash: Buffer;
  blockNumber: bigint;
  status: BroadcastStatus;
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
  {
    name: "isPublished",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "tenantId", type: "bytes32" },
      { name: "root", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

export interface ViemAnchorBroadcasterOptions {
  privateKey: `0x${string}`;
  contractAddress: `0x${string}`;
  rpcUrl: string;
  /** Earliest block to scan when healing an already-anchored window. Default 0. */
  fromBlock?: bigint;
}

/**
 * The Base-Sepolia-typed public client. Naming the factory gives both the
 * broadcaster and the event reader the exact same client type, so the shared
 * findPublishedAnchorTx helper can be typed precisely (a bare
 * `ReturnType<typeof createPublicClient>` resolves to the generic mainnet client
 * whose block/tx formatters differ from Base's).
 */
function createAnchorPublicClient(transport: ReturnType<typeof http>): AnchorPublicClient {
  return createPublicClient({ chain: baseSepolia, transport });
}
type AnchorPublicClient = ReturnType<typeof createPublicClient<ReturnType<typeof http>, typeof baseSepolia>>;

/** True when an error is a deterministic on-chain revert (vs a transient RPC error). */
function isDeterministicRevert(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  if (err.walk((e) => e instanceof ContractFunctionRevertedError)) return true;
  // estimateGas reverts can surface without the typed wrapper on some RPCs.
  return /execution reverted|reverted/i.test(err.shortMessage || err.message);
}

export function createViemAnchorBroadcaster(opts: ViemAnchorBroadcasterOptions): AnchorBroadcaster {
  const account = privateKeyToAccount(opts.privateKey);
  const transport = http(opts.rpcUrl);

  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport,
  });

  const publicClient = createAnchorPublicClient(transport);

  const fromBlock = opts.fromBlock ?? 0n;

  // Resolve the already-anchored case: the root is published on-chain, so
  // broadcasting again would revert with RootAlreadyPublished (§5.3). Return the
  // original winning tx so the DB row is healed instead of re-broadcast. If the
  // event can't be located (rare), throw so the caller retries/reconciles rather
  // than persisting a bogus anchor — broadcasting is still skipped, so no spend.
  async function resolveAlreadyAnchored(
    tenantIdBytes: `0x${string}`,
    rootHexLower: string,
  ): Promise<BroadcastResult> {
    const match = await findPublishedAnchorTx(
      publicClient,
      opts.contractAddress,
      tenantIdBytes,
      rootHexLower,
      fromBlock,
    );
    if (match === null) {
      throw new Error(
        `anchor root ${rootHexLower} reported published on-chain but no AnchorPublished event found`,
      );
    }
    return { txHash: match.txHash, blockNumber: match.blockNumber, status: "already_anchored" };
  }

  return async function broadcastAnchor(input: BroadcastInput): Promise<BroadcastResult> {
    const tenantIdBytes = keccak256(toBytes(input.tenantId)) as `0x${string}`;
    const rootHex = toHex(input.merkleRoot) as `0x${string}`;
    const rootHexLower = rootHex.toLowerCase();

    // (a) Skip already-anchored windows. A published root cannot be re-published
    // (the contract reverts), so check the chain before spending a nonce.
    const alreadyPublished = await publicClient.readContract({
      address: opts.contractAddress,
      abi: BRAIN_AUDIT_ANCHOR_ABI,
      functionName: "isPublished",
      args: [tenantIdBytes, rootHex],
    });
    if (alreadyPublished) {
      return resolveAlreadyAnchored(tenantIdBytes, rootHexLower);
    }

    const minPriority = gweiFloor("BRAIN_ONCHAIN_MIN_PRIORITY_FEE_GWEI", "1.5");
    const minMaxFee = gweiFloor("BRAIN_ONCHAIN_MIN_MAX_FEE_GWEI", "3");
    let maxPriorityFeePerGas = minPriority;
    let maxFeePerGas = minMaxFee;
    try {
      const est = await publicClient.estimateFeesPerGas();
      if (est.maxPriorityFeePerGas > maxPriorityFeePerGas) {
        maxPriorityFeePerGas = est.maxPriorityFeePerGas;
      }
      if (est.maxFeePerGas > maxFeePerGas) {
        maxFeePerGas = est.maxFeePerGas;
      }
    } catch {
      // estimateFeesPerGas can fail on some RPCs; the floors are a safe fallback.
    }
    if (maxFeePerGas < maxPriorityFeePerGas) {
      maxFeePerGas = maxPriorityFeePerGas;
    }

    let txHash: `0x${string}`;
    try {
      txHash = await walletClient.writeContract({
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
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
    } catch (err) {
      // (c) A deterministic revert at estimate/send time (e.g. the root was
      // anchored in the window between our isPublished check and this send) is
      // terminal — never retry it. Re-check the chain so a genuine race heals as
      // already_anchored; anything else is a hard `reverted`. Transient RPC
      // errors are rethrown so the caller retries on the next cycle.
      if (!isDeterministicRevert(err)) throw err;
      const racedPublished = await publicClient.readContract({
        address: opts.contractAddress,
        abi: BRAIN_AUDIT_ANCHOR_ABI,
        functionName: "isPublished",
        args: [tenantIdBytes, rootHex],
      });
      if (racedPublished) return resolveAlreadyAnchored(tenantIdBytes, rootHexLower);
      return { txHash: Buffer.alloc(0), blockNumber: 0n, status: "reverted" };
    }

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
    // (b) Persist the real on-chain outcome. A mined-but-reverted tx (status 0)
    // emits no AnchorPublished and is NOT a valid anchor — surface it as
    // `reverted` so the caller records a terminal failure instead of a phantom
    // success (the previous code never inspected receipt.status).
    return {
      txHash: Buffer.from(txHash.slice(2), "hex"),
      blockNumber: receipt.blockNumber,
      status: receipt.status === "success" ? "confirmed" : "reverted",
    };
  };
}

// --- Anchor event reader (read-only; backs the orphan-recovery reconciler) ---
// Structurally matches @brain/audit's AnchorEventReader; inlined here for the
// same project-reference reason as the broadcaster above.
interface AnchorEventReader {
  findAnchorTx(query: {
    tenantId: string;
    merkleRoot: Buffer;
  }): Promise<{ txHash: Buffer; blockNumber: bigint } | null>;
}

const BRAIN_AUDIT_ANCHOR_EVENTS_ABI = [
  {
    name: "AnchorPublished",
    type: "event",
    inputs: [
      { name: "tenantId", type: "bytes32", indexed: true },
      { name: "root", type: "bytes32", indexed: false },
      { name: "eventCount", type: "uint256", indexed: false },
      { name: "periodStart", type: "uint256", indexed: false },
      { name: "periodEnd", type: "uint256", indexed: false },
    ],
  },
] as const;

/**
 * Find the AnchorPublished tx for a (tenant, root) by scanning contract events.
 * Shared by the broadcaster's already-anchored healing path and the reconciler.
 */
async function findPublishedAnchorTx(
  publicClient: AnchorPublicClient,
  contractAddress: `0x${string}`,
  tenantIdBytes: `0x${string}`,
  rootHexLower: string,
  fromBlock: bigint,
): Promise<{ txHash: Buffer; blockNumber: bigint } | null> {
  const logs = await publicClient.getContractEvents({
    address: contractAddress,
    abi: BRAIN_AUDIT_ANCHOR_EVENTS_ABI,
    eventName: "AnchorPublished",
    args: { tenantId: tenantIdBytes },
    fromBlock,
    toBlock: "latest",
  });
  for (const lg of logs) {
    const root = (lg.args.root ?? "").toString().toLowerCase();
    if (root === rootHexLower && lg.transactionHash !== null && lg.blockNumber !== null) {
      return {
        txHash: Buffer.from(lg.transactionHash.slice(2), "hex"),
        blockNumber: lg.blockNumber,
      };
    }
  }
  return null;
}

export interface ViemAnchorEventReaderOptions {
  contractAddress: `0x${string}`;
  rpcUrl: string;
  /** Earliest block to scan (the contract deploy block in prod). Default 0. */
  fromBlock?: bigint;
}

export function createViemAnchorEventReader(opts: ViemAnchorEventReaderOptions): AnchorEventReader {
  const publicClient = createAnchorPublicClient(http(opts.rpcUrl));

  return {
    async findAnchorTx({ tenantId, merkleRoot }) {
      const tenantIdBytes = keccak256(toBytes(tenantId)) as `0x${string}`;
      const rootHex = toHex(merkleRoot).toLowerCase();
      return findPublishedAnchorTx(
        publicClient,
        opts.contractAddress,
        tenantIdBytes,
        rootHex,
        opts.fromBlock ?? 0n,
      );
    },
  };
}
