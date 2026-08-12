/**
 * KmsCustodialRegistrationRelayer -- RFC 0002 Phase C, increment 3.
 *
 * Ported from scripts/ops/register-prod-agent.ts's two-phase ceremony
 * (setTenantSigner bootstrap, then registerAgent), now driven automatically
 * by AgentService.confirmRegistration for attestation_mode="onchain_custodial"
 * instead of run by hand. Brain's own configured key is seated as the
 * tenant's on-chain signer and signs both phases -- see
 * docs/contracts/production-agents.md for the custodial disclosure this
 * implies for a tenant registered this way.
 *
 * Encodings are pinned identically to the ops script (agentId/tenantId
 * keccak256, scopeHash from the stored agents row, behaviorHash 0x0) and to
 * the on-chain consumer (services/api/src/mcp/viemScopeChecker.ts).
 *
 * FAIL CLOSED: `configured` is true only when the signer key, RPC URL, and
 * registry address are ALL present. An unconfigured instance's
 * submitRegistration rejects, matching UnconfiguredRegistrationRelayer, so
 * an agent is never auto-activated without a real relayer wired in.
 */

import {
  createPublicClient,
  createWalletClient,
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
import type { AuditEmitter } from "@brain/shared";
import type {
  AgentRegistrationRelayer,
  AgentRegistrationRequest,
  AgentRegistrationResult,
} from "../registration-relayer.js";

const CHAIN_ID = 84532;

const REGISTRY_ABI = parseAbi([
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
const GET_AGENT_ABI = [
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

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

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
 * reference boundary -- see anchorBroadcaster.ts's own comment on that). The
 * agent-registration relayer floors on the SAME env vars as the audit
 * anchor broadcaster, so an operator tunes one pair of knobs for every Base
 * Sepolia broadcaster in the process rather than a third, independent pair.
 */
function gweiFloor(envName: string, defaultGwei: string): bigint {
  const raw = process.env[envName];
  const value = raw !== undefined && raw.trim() !== "" ? raw.trim() : defaultGwei;
  const n = Number(value);
  return parseGwei(Number.isFinite(n) && n > 0 ? value : defaultGwei);
}

export interface KmsCustodialRegistrationRelayerOptions {
  /** 0x-prefixed 32-byte signer private key. Undefined ⇒ relayer stays unconfigured. */
  privateKey: `0x${string}` | undefined;
  rpcUrl: string | undefined;
  registryAddress: `0x${string}` | undefined;
  chainId?: number;
  /** Optional: the relayer emits its own custodial-disclosure audit event when set. */
  audit?: AuditEmitter;
  /** Safety multiplier applied to gas * maxFeePerGas before checking balance. */
  gasSafetyFactor?: number;
}

type RegistryAccount = ReturnType<typeof privateKeyToAccount>;
// Pinned generic instantiation (transport, chain), mirroring
// anchorBroadcaster.ts's AnchorPublicClient: a bare `ReturnType<typeof
// createPublicClient>` / `...createWalletClient>` resolves to an overly
// generic client whose writeContract requires an explicit `chain` field.
type RegistryPublicClient = ReturnType<
  typeof createPublicClient<ReturnType<typeof http>, typeof baseSepolia>
>;
type RegistryWalletClient = ReturnType<
  typeof createWalletClient<ReturnType<typeof http>, typeof baseSepolia, RegistryAccount>
>;

/**
 * The custodial relayer for attestation_mode="onchain_custodial" only.
 * Rejects "tenant_signed" (increment 4's relayer handles that mode).
 */
export class KmsCustodialRegistrationRelayer implements AgentRegistrationRelayer {
  public readonly configured: boolean;
  private readonly account: RegistryAccount | undefined;
  private readonly publicClient: RegistryPublicClient | undefined;
  private readonly walletClient: RegistryWalletClient | undefined;
  private readonly registryAddress: Address | undefined;
  private readonly chainId: number;
  private readonly gasSafetyFactor: number;
  private readonly audit: AuditEmitter | undefined;

  public constructor(opts: KmsCustodialRegistrationRelayerOptions) {
    this.configured =
      opts.privateKey !== undefined &&
      opts.rpcUrl !== undefined &&
      opts.registryAddress !== undefined;
    this.chainId = opts.chainId ?? CHAIN_ID;
    this.gasSafetyFactor = opts.gasSafetyFactor ?? 2;
    this.audit = opts.audit;
    if (this.configured) {
      this.account = privateKeyToAccount(opts.privateKey as `0x${string}`);
      const transport = http(opts.rpcUrl as string);
      this.publicClient = createPublicClient({ chain: baseSepolia, transport });
      this.walletClient = createWalletClient({
        account: this.account,
        chain: baseSepolia,
        transport,
      });
      this.registryAddress = opts.registryAddress;
    }
  }

  public async submitRegistration(req: AgentRegistrationRequest): Promise<AgentRegistrationResult> {
    if (
      !this.configured ||
      this.account === undefined ||
      this.publicClient === undefined ||
      this.walletClient === undefined ||
      this.registryAddress === undefined
    ) {
      throw new Error(
        "KmsCustodialRegistrationRelayer is not configured (missing signer key, RPC URL, or " +
          "registry address); agent stays pending_onchain",
      );
    }
    if (req.mode !== "onchain_custodial") {
      throw new Error(
        "KmsCustodialRegistrationRelayer only handles attestation_mode=onchain_custodial, got " +
          req.mode,
      );
    }
    if (req.onchainAddress.length === 0 || req.onchainAddress.toLowerCase() === ZERO_ADDRESS) {
      throw new Error(
        "agent " +
          req.agentId +
          " has no onchain_address; registerAgent would revert with ZeroAddress",
      );
    }

    const account = this.account;
    const publicClient = this.publicClient;
    const walletClient = this.walletClient;
    const registryAddress = this.registryAddress;

    const tenantIdB32 = keccak256(toBytes(req.tenantId));
    const agentIdB32 = keccak256(toBytes(req.agentId));
    const scopeHash = ("0x" + req.scopeHash) as Hex;
    const behaviorHash = zeroHash;
    const agentAddress = req.onchainAddress as Address;
    const signerAddress = account.address;

    const domain = {
      name: "Brain MCP Agent",
      version: "1",
      chainId: this.chainId,
      verifyingContract: registryAddress,
    } as const;

    // Phase 1 -- bootstrap/seat the signer. Idempotent: skipped when the
    // signer is already seated for this tenant, matching the ops script.
    const alreadySigner = await publicClient.readContract({
      address: registryAddress,
      abi: REGISTRY_ABI,
      functionName: "isTenantSigner",
      args: [tenantIdB32, signerAddress],
    });
    if (!alreadySigner) {
      const signerNonce = await publicClient.readContract({
        address: registryAddress,
        abi: REGISTRY_ABI,
        functionName: "signerNonce",
        args: [tenantIdB32],
      });
      const signerChangeSig = await account.signTypedData({
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
        message: {
          tenantId: tenantIdB32,
          signer: signerAddress,
          allowed: true,
          nonce: signerNonce,
        },
      });
      const fees1 = await this.resolveFees();
      const gas1 = await publicClient.estimateContractGas({
        account,
        address: registryAddress,
        abi: REGISTRY_ABI,
        functionName: "setTenantSigner",
        args: [tenantIdB32, signerAddress, true, signerAddress, signerChangeSig],
      });
      await this.assertAffordable(gas1, fees1.maxFeePerGas);
      const tx1 = await walletClient.writeContract({
        address: registryAddress,
        abi: REGISTRY_ABI,
        functionName: "setTenantSigner",
        args: [tenantIdB32, signerAddress, true, signerAddress, signerChangeSig],
        maxFeePerGas: fees1.maxFeePerGas,
        maxPriorityFeePerGas: fees1.maxPriorityFeePerGas,
      });
      const receipt1 = await publicClient.waitForTransactionReceipt({ hash: tx1 });
      if (receipt1.status !== "success") {
        throw new Error("setTenantSigner reverted (tx " + tx1 + ")");
      }
    }

    // Phase 2 -- register the agent. Idempotent against a crashed retry, like
    // phase 1's isTenantSigner check: read getAgent BEFORE signing/broadcasting.
    //   - not registered (registeredAt == 0) -> proceed below, unchanged.
    //   - registered, not revoked, scopeHash MATCHES -> an earlier attempt's
    //     tx already mined but the DB write (or the whole process) never
    //     completed; recover as success instead of re-broadcasting into
    //     AgentAlreadyRegistered.
    //   - registered, not revoked, scopeHash DIFFERS -> real drift, not a
    //     crashed retry; throw rather than silently accept it.
    //   - revoked -> throw; a retry must never resurrect a revoked agent.
    // Remaining limitation: a recovered registration has no txHash recorded
    // here, because recovering one needs an event scan, same as
    // anchorBroadcaster.ts's resolveAlreadyAnchored.
    const existingRegistration = await publicClient.readContract({
      address: registryAddress,
      abi: GET_AGENT_ABI,
      functionName: "getAgent",
      args: [agentIdB32],
    });
    if (existingRegistration.registeredAt !== 0n) {
      if (existingRegistration.revokedAt !== 0n) {
        throw new Error(
          "agent " +
            req.agentId +
            " is registered on-chain but revoked (revokedAt=" +
            existingRegistration.revokedAt.toString() +
            "); refusing to resurrect it via a retry",
        );
      }
      if (existingRegistration.scopeHash.toLowerCase() !== scopeHash.toLowerCase()) {
        throw new Error(
          "agent " +
            req.agentId +
            " is already registered on-chain with scopeHash " +
            existingRegistration.scopeHash +
            ", which differs from the requested " +
            scopeHash +
            "; refusing to silently accept the drift",
        );
      }
      return { txHash: null, alreadyRegistered: true };
    }

    const registrationSig = await account.signTypedData({
      domain,
      types: {
        AgentRegistration: [
          { name: "agentId", type: "bytes32" },
          { name: "agentAddress", type: "address" },
          { name: "tenantId", type: "bytes32" },
          { name: "scopeHash", type: "bytes32" },
          { name: "behaviorHash", type: "bytes32" },
        ],
      },
      primaryType: "AgentRegistration",
      message: {
        agentId: agentIdB32,
        agentAddress,
        tenantId: tenantIdB32,
        scopeHash,
        behaviorHash,
      },
    });
    const fees2 = await this.resolveFees();
    const gas2 = await publicClient.estimateContractGas({
      account,
      address: registryAddress,
      abi: REGISTRY_ABI,
      functionName: "registerAgent",
      args: [
        agentIdB32,
        agentAddress,
        tenantIdB32,
        scopeHash,
        behaviorHash,
        signerAddress,
        registrationSig,
      ],
    });
    await this.assertAffordable(gas2, fees2.maxFeePerGas);
    const tx2 = await walletClient.writeContract({
      address: registryAddress,
      abi: REGISTRY_ABI,
      functionName: "registerAgent",
      args: [
        agentIdB32,
        agentAddress,
        tenantIdB32,
        scopeHash,
        behaviorHash,
        signerAddress,
        registrationSig,
      ],
      maxFeePerGas: fees2.maxFeePerGas,
      maxPriorityFeePerGas: fees2.maxPriorityFeePerGas,
    });
    const receipt2 = await publicClient.waitForTransactionReceipt({ hash: tx2 });
    if (receipt2.status !== "success") {
      throw new Error("registerAgent reverted (tx " + tx2 + ")");
    }

    await this.audit?.emit({
      tenantId: req.tenantId,
      layer: "agent",
      actor: "system:kms-custodial-relayer",
      action: "agent.onchain_custodial_registered",
      inputs: { agent_id: req.agentId },
      outputs: { custodial: true, signer_address: signerAddress, tx_hash: tx2 },
    });

    return { txHash: tx2 };
  }

  private async resolveFees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const publicClient = this.publicClient as RegistryPublicClient;
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

  /** Balance check BEFORE any writeContract, mirroring anchorBroadcaster.ts's assertAffordable. */
  private async assertAffordable(gas: bigint, maxFeePerGas: bigint): Promise<void> {
    const publicClient = this.publicClient as RegistryPublicClient;
    const account = this.account as RegistryAccount;
    const balance = await publicClient.getBalance({ address: account.address });
    const guardedCost = applySafetyFactor(gas * maxFeePerGas, this.gasSafetyFactor);
    if (balance < guardedCost) {
      throw new InsufficientRelayerFundsError(balance, guardedCost);
    }
  }
}

function applySafetyFactor(costWei: bigint, safetyFactor: number): bigint {
  const factor = Number.isFinite(safetyFactor) && safetyFactor > 0 ? safetyFactor : 1;
  const basisPoints = BigInt(Math.ceil(factor * 10_000));
  return (costWei * basisPoints + 9_999n) / 10_000n;
}
