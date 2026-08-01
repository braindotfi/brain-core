import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  keccak256,
  parseGwei,
  toBytes,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import type { MetricsEmitter } from "@brain/shared";

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
type AnchorBatchBroadcaster = (inputs: BroadcastInput[]) => Promise<BroadcastBatchResult[]>;
interface BroadcastBatchResult {
  input: BroadcastInput;
  result: BroadcastResult;
}
type ViemAnchorBroadcaster = AnchorBroadcaster & {
  broadcastAnchorBatch: AnchorBatchBroadcaster;
};
interface AnchorLog {
  warn(message: string): void;
}

export const MAX_ANCHOR_BATCH_SIZE = 50;

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
    name: "anchorBatch",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tenantIds", type: "bytes32[]" },
      { name: "roots", type: "bytes32[]" },
      { name: "eventCounts", type: "uint256[]" },
      { name: "periodStarts", type: "uint256[]" },
      { name: "periodEnds", type: "uint256[]" },
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
  /** Earliest block to scan when healing an already-anchored window. */
  fromBlock?: bigint | undefined;
  /** Maximum inclusive block span per AnchorPublished event query. */
  maxEventScanBlockSpan?: number;
  /** Fallback event-scan lookback when fromBlock is not configured. */
  fromBlockLookbackBlocks?: bigint;
  /** Safety multiplier applied to gas * maxFeePerGas before checking balance. */
  gasSafetyFactor?: number;
  /** Alert threshold for the publisher wallet balance. Defaults to 0. */
  walletBalanceAlertWei?: bigint;
  /** Hard upper bound for one anchorBatch call. Must not exceed the contract MAX_BATCH. */
  maxBatchSize?: number;
  metrics?: MetricsEmitter;
  log?: AnchorLog;
  nodeEnv?: string;
}

export class InsufficientAnchorFundsError extends Error {
  public override readonly name = "InsufficientAnchorFundsError";
  public constructor(
    public readonly balanceWei: bigint,
    public readonly requiredWei: bigint,
  ) {
    super(
      `audit anchor publisher wallet has ${balanceWei.toString()} wei, below guarded cost ${requiredWei.toString()} wei`,
    );
  }
}

const DEFAULT_EVENT_SCAN_MAX_BLOCKS = 2_000;
const DEFAULT_FROM_BLOCK_LOOKBACK_BLOCKS = 100_000n;
const DEFAULT_GAS_SAFETY_FACTOR = 2;

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
type AnchorPublicClient = ReturnType<
  typeof createPublicClient<ReturnType<typeof http>, typeof baseSepolia>
>;

/** True when an error is a deterministic on-chain revert (vs a transient RPC error). */
function isDeterministicRevert(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  if (err.walk((e) => e instanceof ContractFunctionRevertedError)) return true;
  // estimateGas reverts can surface without the typed wrapper on some RPCs.
  return /execution reverted|reverted/i.test(err.shortMessage || err.message);
}

export function createViemAnchorBroadcaster(
  opts: ViemAnchorBroadcasterOptions,
): ViemAnchorBroadcaster {
  const account = privateKeyToAccount(opts.privateKey);
  const transport = http(opts.rpcUrl);

  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport,
  });

  const publicClient = createAnchorPublicClient(transport);

  const maxEventScanBlockSpan = opts.maxEventScanBlockSpan ?? DEFAULT_EVENT_SCAN_MAX_BLOCKS;
  const fromBlockLookbackBlocks =
    opts.fromBlockLookbackBlocks ?? DEFAULT_FROM_BLOCK_LOOKBACK_BLOCKS;
  const gasSafetyFactor = opts.gasSafetyFactor ?? DEFAULT_GAS_SAFETY_FACTOR;
  const walletBalanceAlertWei = opts.walletBalanceAlertWei ?? 0n;
  const nodeEnv = opts.nodeEnv ?? process.env.NODE_ENV ?? "development";
  const maxBatchSize = Math.min(
    MAX_ANCHOR_BATCH_SIZE,
    Math.max(1, Math.floor(opts.maxBatchSize ?? MAX_ANCHOR_BATCH_SIZE)),
  );

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
      {
        configuredFromBlock: opts.fromBlock,
        lookbackBlocks: fromBlockLookbackBlocks,
        maxBlockSpan: maxEventScanBlockSpan,
        nodeEnv,
        log: opts.log ?? console,
      },
    );
    if (match === null) {
      throw new Error(
        `anchor root ${rootHexLower} reported published on-chain but no AnchorPublished event found`,
      );
    }
    return { txHash: match.txHash, blockNumber: match.blockNumber, status: "already_anchored" };
  }

  async function resolveFees(): Promise<{
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  }> {
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
    return { maxFeePerGas, maxPriorityFeePerGas };
  }

  async function waitForReceipt(txHash: `0x${string}`): Promise<{
    blockNumber: bigint;
    status: "confirmed" | "reverted";
    logs: ReadonlyArray<{
      address: `0x${string}`;
      topics: readonly `0x${string}`[];
      data: `0x${string}`;
    }>;
  }> {
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
      blockNumber: receipt.blockNumber,
      status: receipt.status === "success" ? "confirmed" : "reverted",
      logs: receipt.logs ?? [],
    };
  }

  async function assertAffordable(gas: bigint, maxFeePerGas: bigint): Promise<void> {
    const balance = await publicClient.getBalance({ address: account.address });
    emitWalletBalanceMetrics(opts.metrics, balance, walletBalanceAlertWei);
    const guardedCost = applySafetyFactor(gas * maxFeePerGas, gasSafetyFactor);
    if (balance < guardedCost) {
      opts.metrics?.increment("brain.audit.anchor.publisher_wallet_insufficient_funds.count", {
        severity: "critical",
      });
      throw new InsufficientAnchorFundsError(balance, guardedCost);
    }
  }

  const broadcastAnchor: AnchorBroadcaster = async function broadcastAnchor(
    input: BroadcastInput,
  ): Promise<BroadcastResult> {
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

    const { maxFeePerGas, maxPriorityFeePerGas } = await resolveFees();

    const anchorArgs = [
      tenantIdBytes,
      rootHex,
      BigInt(input.eventCount),
      BigInt(Math.floor(input.periodStart.getTime() / 1000)),
      BigInt(Math.floor(input.periodEnd.getTime() / 1000)),
    ] as const;
    let gas: bigint;
    try {
      gas = await publicClient.estimateContractGas({
        account,
        address: opts.contractAddress,
        abi: BRAIN_AUDIT_ANCHOR_ABI,
        functionName: "anchor",
        args: anchorArgs,
      });
    } catch (err) {
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
    await assertAffordable(gas, maxFeePerGas);

    let txHash: `0x${string}`;
    try {
      txHash = await walletClient.writeContract({
        address: opts.contractAddress,
        abi: BRAIN_AUDIT_ANCHOR_ABI,
        functionName: "anchor",
        args: anchorArgs,
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

    const receipt = await waitForReceipt(txHash);
    // (b) Persist the real on-chain outcome. A mined-but-reverted tx (status 0)
    // emits no AnchorPublished and is NOT a valid anchor — surface it as
    // `reverted` so the caller records a terminal failure instead of a phantom
    // success (the previous code never inspected receipt.status).
    return {
      txHash: Buffer.from(txHash.slice(2), "hex"),
      blockNumber: receipt.blockNumber,
      status: receipt.status,
    };
  };

  const broadcastAnchorBatch: AnchorBatchBroadcaster = async function broadcastAnchorBatch(
    inputs: BroadcastInput[],
  ): Promise<BroadcastBatchResult[]> {
    if (inputs.length === 0) return [];
    if (inputs.length > maxBatchSize) {
      throw new Error(
        `anchor batch size ${inputs.length} exceeds configured maximum ${maxBatchSize}`,
      );
    }

    const results = new Array<BroadcastBatchResult | undefined>(inputs.length);
    const unpublished: Array<{
      index: number;
      input: BroadcastInput;
      tenantIdBytes: `0x${string}`;
      rootHex: `0x${string}`;
      rootHexLower: string;
    }> = [];

    for (let index = 0; index < inputs.length; ++index) {
      const input = inputs[index];
      if (input === undefined) throw new Error("anchor batch input disappeared during iteration");
      const tenantIdBytes = keccak256(toBytes(input.tenantId)) as `0x${string}`;
      const rootHex = toHex(input.merkleRoot) as `0x${string}`;
      const rootHexLower = rootHex.toLowerCase();
      const alreadyPublished = await publicClient.readContract({
        address: opts.contractAddress,
        abi: BRAIN_AUDIT_ANCHOR_ABI,
        functionName: "isPublished",
        args: [tenantIdBytes, rootHex],
      });
      if (alreadyPublished) {
        results[index] = {
          input,
          result: await resolveAlreadyAnchored(tenantIdBytes, rootHexLower),
        };
      } else {
        unpublished.push({ index, input, tenantIdBytes, rootHex, rootHexLower });
      }
    }

    if (unpublished.length === 0) return results as BroadcastBatchResult[];

    const { maxFeePerGas, maxPriorityFeePerGas } = await resolveFees();
    const batchArgs = [
      unpublished.map((entry) => entry.tenantIdBytes),
      unpublished.map((entry) => entry.rootHex),
      unpublished.map((entry) => BigInt(entry.input.eventCount)),
      unpublished.map((entry) => BigInt(Math.floor(entry.input.periodStart.getTime() / 1000))),
      unpublished.map((entry) => BigInt(Math.floor(entry.input.periodEnd.getTime() / 1000))),
    ] as const;

    let gas: bigint;
    try {
      gas = await publicClient.estimateContractGas({
        account,
        address: opts.contractAddress,
        abi: BRAIN_AUDIT_ANCHOR_ABI,
        functionName: "anchorBatch",
        args: batchArgs,
      });
    } catch (err) {
      if (!isDeterministicRevert(err)) throw err;
      await markBatchRevertOrRace(unpublished, results);
      return results as BroadcastBatchResult[];
    }
    await assertAffordable(gas, maxFeePerGas);

    let txHash: `0x${string}`;
    try {
      txHash = await walletClient.writeContract({
        address: opts.contractAddress,
        abi: BRAIN_AUDIT_ANCHOR_ABI,
        functionName: "anchorBatch",
        args: batchArgs,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
    } catch (err) {
      if (!isDeterministicRevert(err)) throw err;
      await markBatchRevertOrRace(unpublished, results);
      return results as BroadcastBatchResult[];
    }

    const receipt = await waitForReceipt(txHash);
    const batchTx = Buffer.from(txHash.slice(2), "hex");
    const emitted = anchorPairsEmittedByReceiptLogs(receipt.logs, opts.contractAddress);
    for (const entry of unpublished) {
      const emittedInBatch = emitted.has(anchorPairKey(entry.tenantIdBytes, entry.rootHex));
      results[entry.index] = {
        input: entry.input,
        result:
          receipt.status === "reverted"
            ? { txHash: Buffer.alloc(0), blockNumber: receipt.blockNumber, status: "reverted" }
            : emittedInBatch
              ? { txHash: batchTx, blockNumber: receipt.blockNumber, status: "confirmed" }
              : await resolveAlreadyAnchored(entry.tenantIdBytes, entry.rootHexLower),
      };
    }
    return results as BroadcastBatchResult[];
  };

  async function markBatchRevertOrRace(
    unpublished: Array<{
      index: number;
      input: BroadcastInput;
      tenantIdBytes: `0x${string}`;
      rootHex: `0x${string}`;
      rootHexLower: string;
    }>,
    results: Array<BroadcastBatchResult | undefined>,
  ): Promise<void> {
    for (const entry of unpublished) {
      const racedPublished = await publicClient.readContract({
        address: opts.contractAddress,
        abi: BRAIN_AUDIT_ANCHOR_ABI,
        functionName: "isPublished",
        args: [entry.tenantIdBytes, entry.rootHex],
      });
      results[entry.index] = {
        input: entry.input,
        result: racedPublished
          ? await resolveAlreadyAnchored(entry.tenantIdBytes, entry.rootHexLower)
          : { txHash: Buffer.alloc(0), blockNumber: 0n, status: "reverted" },
      };
    }
  }

  return Object.assign(broadcastAnchor, { broadcastAnchorBatch });
}

function anchorPairKey(tenantIdBytes: `0x${string}`, rootHex: `0x${string}`): string {
  return `${tenantIdBytes.toLowerCase()}:${rootHex.toLowerCase()}`;
}

function anchorPairsEmittedByReceiptLogs(
  logs: ReadonlyArray<{
    address: `0x${string}`;
    topics: readonly `0x${string}`[];
    data: `0x${string}`;
  }>,
  contractAddress: `0x${string}`,
): Set<string> {
  const out = new Set<string>();
  for (const log of logs) {
    if (log.address.toLowerCase() !== contractAddress.toLowerCase()) continue;
    try {
      const signature = log.topics[0];
      if (signature === undefined) continue;
      const topics: [signature: `0x${string}`, ...args: `0x${string}`[]] = [
        signature,
        ...log.topics.slice(1),
      ];
      const decoded = decodeEventLog({
        abi: BRAIN_AUDIT_ANCHOR_EVENTS_ABI,
        data: log.data,
        topics,
      });
      if (decoded.eventName !== "AnchorPublished") continue;
      const tenantId = decoded.args.tenantId;
      const root = decoded.args.root;
      if (tenantId !== undefined && root !== undefined) out.add(anchorPairKey(tenantId, root));
    } catch {
      // Ignore unrelated logs from the same transaction.
    }
  }
  return out;
}

function applySafetyFactor(costWei: bigint, safetyFactor: number): bigint {
  const factor = Number.isFinite(safetyFactor) && safetyFactor > 0 ? safetyFactor : 1;
  const basisPoints = BigInt(Math.ceil(factor * 10_000));
  return (costWei * basisPoints + 9_999n) / 10_000n;
}

function emitWalletBalanceMetrics(
  metrics: MetricsEmitter | undefined,
  balanceWei: bigint,
  alertThresholdWei: bigint,
): void {
  if (metrics === undefined) return;
  metrics.gauge("brain.audit.anchor.publisher_wallet_balance_wei", Number(balanceWei));
  metrics.gauge(
    "brain.audit.anchor.publisher_wallet_balance_below_alert",
    balanceWei < alertThresholdWei ? 1 : 0,
  );
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
  opts: {
    configuredFromBlock: bigint | undefined;
    lookbackBlocks: bigint;
    maxBlockSpan: number;
    nodeEnv: string;
    log: AnchorLog | undefined;
  },
): Promise<{ txHash: Buffer; blockNumber: bigint } | null> {
  const latestBlock = await publicClient.getBlockNumber();
  const fromBlock = resolveAnchorScanFromBlock({
    configuredFromBlock: opts.configuredFromBlock,
    latestBlock,
    lookbackBlocks: opts.lookbackBlocks,
    nodeEnv: opts.nodeEnv,
    log: opts.log,
  });
  if (fromBlock > latestBlock) return null;
  const span = BigInt(Math.max(1, Math.floor(opts.maxBlockSpan)));
  for (let start = fromBlock; start <= latestBlock; start += span) {
    const end = start + span - 1n > latestBlock ? latestBlock : start + span - 1n;
    const logs = await publicClient.getContractEvents({
      address: contractAddress,
      abi: BRAIN_AUDIT_ANCHOR_EVENTS_ABI,
      eventName: "AnchorPublished",
      args: { tenantId: tenantIdBytes },
      fromBlock: start,
      toBlock: end,
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
  }
  return null;
}

export function resolveAnchorScanFromBlock(opts: {
  configuredFromBlock?: bigint | undefined;
  latestBlock: bigint;
  lookbackBlocks: bigint;
  nodeEnv: string;
  log?: AnchorLog | undefined;
}): bigint {
  if (opts.configuredFromBlock !== undefined) return opts.configuredFromBlock;
  opts.log?.warn(
    "AUDIT_ANCHOR_FROM_BLOCK is not set; using a bounded lookback window for audit anchor event scans",
  );
  const windowed =
    opts.latestBlock > opts.lookbackBlocks ? opts.latestBlock - opts.lookbackBlocks : 0n;
  if (opts.nodeEnv === "production" && windowed === 0n && opts.latestBlock > 0n) return 1n;
  return windowed;
}

export async function findPublishedAnchorTxForTests(input: {
  publicClient: Pick<AnchorPublicClient, "getBlockNumber" | "getContractEvents">;
  contractAddress: `0x${string}`;
  tenantIdBytes: `0x${string}`;
  rootHexLower: string;
  fromBlock: bigint;
  maxBlockSpan: number;
}): Promise<{ txHash: Buffer; blockNumber: bigint } | null> {
  return findPublishedAnchorTx(
    input.publicClient as AnchorPublicClient,
    input.contractAddress,
    input.tenantIdBytes,
    input.rootHexLower,
    {
      configuredFromBlock: input.fromBlock,
      lookbackBlocks: DEFAULT_FROM_BLOCK_LOOKBACK_BLOCKS,
      maxBlockSpan: input.maxBlockSpan,
      nodeEnv: "test",
      log: undefined,
    },
  );
}

export interface ViemAnchorEventReaderOptions {
  contractAddress: `0x${string}`;
  rpcUrl: string;
  /** Earliest block to scan (the contract deploy block in prod). */
  fromBlock?: bigint | undefined;
  /** Maximum inclusive block span per AnchorPublished event query. */
  maxEventScanBlockSpan?: number;
  /** Fallback event-scan lookback when fromBlock is not configured. */
  fromBlockLookbackBlocks?: bigint;
  log?: AnchorLog;
  nodeEnv?: string;
}

export function createViemAnchorEventReader(opts: ViemAnchorEventReaderOptions): AnchorEventReader {
  const publicClient = createAnchorPublicClient(http(opts.rpcUrl));

  return {
    async findAnchorTx({ tenantId, merkleRoot }) {
      const tenantIdBytes = keccak256(toBytes(tenantId)) as `0x${string}`;
      const rootHex = toHex(merkleRoot).toLowerCase();
      return findPublishedAnchorTx(publicClient, opts.contractAddress, tenantIdBytes, rootHex, {
        configuredFromBlock: opts.fromBlock,
        lookbackBlocks: opts.fromBlockLookbackBlocks ?? DEFAULT_FROM_BLOCK_LOOKBACK_BLOCKS,
        maxBlockSpan: opts.maxEventScanBlockSpan ?? DEFAULT_EVENT_SCAN_MAX_BLOCKS,
        nodeEnv: opts.nodeEnv ?? process.env.NODE_ENV ?? "development",
        log: opts.log ?? console,
      });
    },
  };
}
