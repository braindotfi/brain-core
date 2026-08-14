/**
 * Shared BrainMCPAgentRegistry plumbing for the on-chain registration
 * relayers (RFC 0002 Phase C). Both `KmsCustodialRegistrationRelayer`
 * (increment 3, tier 3) and `TenantSignedRegistrationRelayer` (increment 4,
 * tier 2) broadcast against the SAME contract with the SAME two-phase
 * ceremony (bootstrap the tenant signer, then registerAgent) and the SAME
 * fee-floor / balance-guard posture. Factored out here so the phase-2
 * idempotency read, the fee floors, and the balance check cannot drift
 * between the two relayers -- exactly the class of bug a copy-paste
 * introduces silently.
 *
 * What differs between the two relayers stays in their own files: WHICH
 * address gets seated as signer in phase 1 (Brain's own vs. the tenant's),
 * and WHOSE signature phase 2 broadcasts (Brain's own vs. the tenant's,
 * already collected via POST /agents/{id}/attestation).
 */

import {
  createPublicClient,
  createWalletClient,
  hashTypedData,
  http,
  keccak256,
  parseAbi,
  parseGwei,
  toBytes,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import type { AgentRegistrationResult, AttestationPayload } from "../registration-relayer.js";

export const REGISTRY_ABI = parseAbi([
  "function signerNonce(bytes32 tenantId) view returns (uint256)",
  "function isTenantSigner(bytes32 tenantId, address a) view returns (bool)",
  "function setTenantSigner(bytes32 tenantId, address signer, bool allowed, address authSigner, bytes signature)",
  "function registerAgent(bytes32 agentId, address agentAddress, bytes32 tenantId, bytes32 scopeHash, bytes32 behaviorHash, address authSigner, bytes tenantSignature)",
]);

/**
 * `getAgent` returns a tuple, not a scalar, so it is kept as its own
 * object-form ABI rather than folded into REGISTRY_ABI's parseAbi() call --
 * same reason and same field order as viemScopeChecker.ts's
 * BRAIN_MCP_AGENT_REGISTRY_ABI (behaviorHash sits between scopeHash and
 * registeredAt; viem decodes tuples positionally).
 */
export const GET_AGENT_ABI = [
  {
    name: "getAgent",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "agentId", type: "bytes32" },
          { name: "agentAddress", type: "address" },
          { name: "tenantId", type: "bytes32" },
          { name: "scopeHash", type: "bytes32" },
          { name: "behaviorHash", type: "bytes32" },
          { name: "registeredAt", type: "uint256" },
          { name: "revokedAt", type: "uint256" },
        ],
      },
    ],
  },
] as const;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const DEFAULT_CHAIN_ID = 84532; // Base Sepolia

type RegistryAccount = ReturnType<typeof privateKeyToAccount>;
// Pinned generic instantiation (transport, chain), mirroring
// anchorBroadcaster.ts's AnchorPublicClient: a bare `ReturnType<typeof
// createPublicClient>` / `...createWalletClient>` resolves to an overly
// generic client whose writeContract requires an explicit `chain` field.
export type RegistryPublicClient = ReturnType<
  typeof createPublicClient<ReturnType<typeof http>, typeof baseSepolia>
>;
export type RegistryWalletClient = ReturnType<
  typeof createWalletClient<ReturnType<typeof http>, typeof baseSepolia, RegistryAccount>
>;

export function makeRegistryClients(opts: { privateKey: `0x${string}`; rpcUrl: string }): {
  account: RegistryAccount;
  publicClient: RegistryPublicClient;
  walletClient: RegistryWalletClient;
} {
  const account = privateKeyToAccount(opts.privateKey);
  const transport = http(opts.rpcUrl);
  const publicClient = createPublicClient({ chain: baseSepolia, transport });
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport });
  return { account, publicClient, walletClient };
}

/**
 * Distinct from a mined revert: never a terminal failure. Matches
 * anchorBroadcaster.ts's InsufficientAnchorFundsError posture -- the agent
 * stays pending_onchain, the retry worker must not consume an attestation
 * attempt for this, and it should be retried once the wallet is funded.
 */
export class InsufficientRelayerFundsError extends Error {
  public override readonly name = "InsufficientRelayerFundsError";
  public constructor(
    public readonly balanceWei: bigint,
    public readonly requiredWei: bigint,
  ) {
    super(
      "agent registration relayer wallet has " +
        balanceWei.toString() +
        " wei, below guarded cost " +
        requiredWei.toString() +
        " wei",
    );
  }
}

/**
 * Same sub-gwei-gasPrice guard as anchorBroadcaster.ts and onchainExecutor.ts
 * (both inline this identically rather than share it across a project-
 * reference boundary). Every agent-registration relayer floors on the SAME
 * env vars as the audit anchor broadcaster, so an operator tunes one pair of
 * knobs for every Base Sepolia broadcaster in the process.
 */
function gweiFloor(envName: string, defaultGwei: string): bigint {
  const raw = process.env[envName];
  const value = raw !== undefined && raw.trim() !== "" ? raw.trim() : defaultGwei;
  const n = Number(value);
  return parseGwei(Number.isFinite(n) && n > 0 ? value : defaultGwei);
}

export async function resolveFees(
  publicClient: RegistryPublicClient,
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const minPriority = gweiFloor("BRAIN_ONCHAIN_MIN_PRIORITY_FEE_GWEI", "0.05");
  const minMaxFee = gweiFloor("BRAIN_ONCHAIN_MIN_MAX_FEE_GWEI", "0.5");
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

function applySafetyFactor(costWei: bigint, safetyFactor: number): bigint {
  const factor = Number.isFinite(safetyFactor) && safetyFactor > 0 ? safetyFactor : 1;
  const basisPoints = BigInt(Math.ceil(factor * 10_000));
  return (costWei * basisPoints + 9_999n) / 10_000n;
}

/** Balance check BEFORE any writeContract, mirroring anchorBroadcaster.ts's assertAffordable. */
export async function assertAffordable(
  publicClient: RegistryPublicClient,
  account: RegistryAccount,
  gas: bigint,
  maxFeePerGas: bigint,
  gasSafetyFactor: number,
): Promise<void> {
  const balance = await publicClient.getBalance({ address: account.address });
  const guardedCost = applySafetyFactor(gas * maxFeePerGas, gasSafetyFactor);
  if (balance < guardedCost) {
    throw new InsufficientRelayerFundsError(balance, guardedCost);
  }
}

/**
 * Phase 1 -- seat `signerToSeat` as a tenant signer if it is not already.
 * `_requireQuorum` has no bootstrap branch, so this can ONLY ever succeed
 * through the registry's `initialAdmin` path: `account` (Brain's own
 * configured relayer key) is both the broadcaster AND the `authSigner` /
 * signature over the `TenantSignerChange` typed data, regardless of whether
 * `signerToSeat` is Brain's own address (custodial) or the tenant's
 * (tenant-signed). Idempotent: a no-op when the signer is already seated,
 * matching the ops script this was ported from.
 */
export async function bootstrapTenantSignerIfNeeded(params: {
  publicClient: RegistryPublicClient;
  walletClient: RegistryWalletClient;
  account: RegistryAccount;
  registryAddress: Address;
  tenantIdB32: Hex;
  signerToSeat: Address;
  chainId: number;
  gasSafetyFactor: number;
}): Promise<void> {
  const {
    publicClient,
    walletClient,
    account,
    registryAddress,
    tenantIdB32,
    signerToSeat,
    chainId,
    gasSafetyFactor,
  } = params;

  const alreadySigner = await publicClient.readContract({
    address: registryAddress,
    abi: REGISTRY_ABI,
    functionName: "isTenantSigner",
    args: [tenantIdB32, signerToSeat],
  });
  if (alreadySigner) return;

  const signerNonce = await publicClient.readContract({
    address: registryAddress,
    abi: REGISTRY_ABI,
    functionName: "signerNonce",
    args: [tenantIdB32],
  });
  const domain = {
    name: "Brain MCP Agent",
    version: "1",
    chainId,
    verifyingContract: registryAddress,
  } as const;
  const signature = await account.signTypedData({
    domain,
    types: {
      TenantSignerChange: [
        { name: "tenantId", type: "bytes32" },
        { name: "signer", type: "address" },
        { name: "allowed", type: "bool" },
        { name: "nonce", type: "uint256" },
      ],
    },
    primaryType: "TenantSignerChange",
    message: { tenantId: tenantIdB32, signer: signerToSeat, allowed: true, nonce: signerNonce },
  });
  const fees = await resolveFees(publicClient);
  const gas = await publicClient.estimateContractGas({
    account,
    address: registryAddress,
    abi: REGISTRY_ABI,
    functionName: "setTenantSigner",
    args: [tenantIdB32, signerToSeat, true, account.address, signature],
  });
  await assertAffordable(publicClient, account, gas, fees.maxFeePerGas, gasSafetyFactor);
  const tx = await walletClient.writeContract({
    address: registryAddress,
    abi: REGISTRY_ABI,
    functionName: "setTenantSigner",
    args: [tenantIdB32, signerToSeat, true, account.address, signature],
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  if (receipt.status !== "success") {
    throw new Error("setTenantSigner reverted (tx " + tx + ")");
  }
}

/**
 * Phase 2 idempotency read, BEFORE any signature/broadcast: read `getAgent`
 * and decide whether to proceed with a fresh registration or recover a
 * crashed-retry outcome.
 *   - not registered (registeredAt == 0) -> `null` (caller proceeds).
 *   - registered, not revoked, scopeHash MATCHES -> an earlier attempt's tx
 *     already mined but the DB write (or the whole process) never
 *     completed; recover as success instead of re-broadcasting into
 *     AgentAlreadyRegistered.
 *   - registered, not revoked, scopeHash DIFFERS -> real drift, not a
 *     crashed retry; throw rather than silently accept it.
 *   - revoked -> throw; a retry must never resurrect a revoked agent.
 */
export async function checkExistingRegistration(params: {
  publicClient: RegistryPublicClient;
  registryAddress: Address;
  agentIdB32: Hex;
  requestedScopeHash: Hex;
  agentId: string;
}): Promise<AgentRegistrationResult | null> {
  const { publicClient, registryAddress, agentIdB32, requestedScopeHash, agentId } = params;
  const existing = await publicClient.readContract({
    address: registryAddress,
    abi: GET_AGENT_ABI,
    functionName: "getAgent",
    args: [agentIdB32],
  });
  if (existing.registeredAt === 0n) return null;
  if (existing.revokedAt !== 0n) {
    throw new Error(
      "agent " +
        agentId +
        " is registered on-chain but revoked (revokedAt=" +
        existing.revokedAt.toString() +
        "); refusing to resurrect it via a retry",
    );
  }
  if (existing.scopeHash.toLowerCase() !== requestedScopeHash.toLowerCase()) {
    throw new Error(
      "agent " +
        agentId +
        " is already registered on-chain with scopeHash " +
        existing.scopeHash +
        ", which differs from the requested " +
        requestedScopeHash +
        "; refusing to silently accept the drift",
    );
  }
  return { txHash: null, alreadyRegistered: true };
}

/** keccak256 of the raw Brain id string -- how agentId/tenantId become the
 *  contract's bytes32 keys. Pinned identically for both relayers and the
 *  EIP-712 typed-data builder below so a signature is always computed over
 *  the exact same digest the broadcaster later submits. */
export function hashBrainId(id: string): Hex {
  return keccak256(toBytes(id));
}

const AGENT_REGISTRATION_TYPES = {
  AgentRegistration: [
    { name: "agentId", type: "bytes32" },
    { name: "agentAddress", type: "address" },
    { name: "tenantId", type: "bytes32" },
    { name: "scopeHash", type: "bytes32" },
    { name: "behaviorHash", type: "bytes32" },
  ],
} as const;

/**
 * The EIP-712 `AgentRegistration` typed data a tenant-designated signer must
 * sign (tier 2), and what `registerAgent` verifies on-chain (both tiers).
 * `scopeHash` is the hex string as stored on the agents row (no `0x` prefix).
 */
export function buildAgentRegistrationTypedData(input: {
  agentId: string;
  tenantId: string;
  onchainAddress: string;
  scopeHash: string;
  registryAddress: Address;
  chainId: number;
}): AttestationPayload {
  const domain = {
    name: "Brain MCP Agent",
    version: "1",
    chainId: input.chainId,
    verifyingContract: input.registryAddress,
  } as const;
  const message = {
    agentId: hashBrainId(input.agentId),
    agentAddress: input.onchainAddress as Address,
    tenantId: hashBrainId(input.tenantId),
    scopeHash: ("0x" + input.scopeHash) as Hex,
    behaviorHash: zeroHash,
  };
  const digest = hashTypedData({
    domain,
    types: AGENT_REGISTRATION_TYPES,
    primaryType: "AgentRegistration",
    message,
  });
  return {
    domain,
    types: AGENT_REGISTRATION_TYPES,
    primaryType: "AgentRegistration",
    message,
    digest,
  };
}
