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
 * The two-phase ceremony itself (bootstrap seat + phase-2 idempotency read +
 * fee floors + balance guard) lives in ./registry-shared.js, shared with
 * TenantSignedRegistrationRelayer (increment 4) so neither can drift.
 *
 * FAIL CLOSED: `configured` is true only when the signer key, RPC URL, and
 * registry address are ALL present. An unconfigured instance's
 * submitRegistration rejects, matching UnconfiguredRegistrationRelayer, so
 * an agent is never auto-activated without a real relayer wired in.
 */

import { zeroHash, type Address, type Hex } from "viem";
import type { AuditEmitter } from "@brain/shared";
import type {
  AgentRegistrationRelayer,
  AgentRegistrationRequest,
  AgentRegistrationResult,
  AttestationRelayerMode,
} from "../registration-relayer.js";
import {
  REGISTRY_ABI,
  ZERO_ADDRESS,
  DEFAULT_CHAIN_ID,
  assertAffordable,
  bootstrapTenantSignerIfNeeded,
  checkExistingRegistration,
  hashBrainId,
  makeRegistryClients,
  resolveFees,
  type RegistryPublicClient,
  type RegistryWalletClient,
} from "./registry-shared.js";

export { InsufficientRelayerFundsError } from "./registry-shared.js";

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

/**
 * The custodial relayer for attestation_mode="onchain_custodial" only.
 * Rejects "tenant_signed" (increment 4's relayer handles that mode).
 */
export class KmsCustodialRegistrationRelayer implements AgentRegistrationRelayer {
  public readonly configured: boolean;
  public readonly supportedModes: readonly AttestationRelayerMode[] = ["onchain_custodial"];
  private readonly clients: ReturnType<typeof makeRegistryClients> | undefined;
  private readonly registryAddress: Address | undefined;
  private readonly chainId: number;
  private readonly gasSafetyFactor: number;
  private readonly audit: AuditEmitter | undefined;

  public constructor(opts: KmsCustodialRegistrationRelayerOptions) {
    this.configured =
      opts.privateKey !== undefined &&
      opts.rpcUrl !== undefined &&
      opts.registryAddress !== undefined;
    this.chainId = opts.chainId ?? DEFAULT_CHAIN_ID;
    this.gasSafetyFactor = opts.gasSafetyFactor ?? 2;
    this.audit = opts.audit;
    if (this.configured) {
      this.clients = makeRegistryClients({
        privateKey: opts.privateKey as `0x${string}`,
        rpcUrl: opts.rpcUrl as string,
      });
      this.registryAddress = opts.registryAddress;
    }
  }

  public async submitRegistration(req: AgentRegistrationRequest): Promise<AgentRegistrationResult> {
    if (!this.configured || this.clients === undefined || this.registryAddress === undefined) {
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

    const { account, publicClient, walletClient } = this.clients;
    const registryAddress = this.registryAddress;

    const tenantIdB32 = hashBrainId(req.tenantId);
    const agentIdB32 = hashBrainId(req.agentId);
    const scopeHash = ("0x" + req.scopeHash) as Hex;
    const behaviorHash = zeroHash;
    const agentAddress = req.onchainAddress as Address;
    const signerAddress = account.address;

    // Phase 1 -- bootstrap/seat Brain's own key as the tenant's signer.
    await bootstrapTenantSignerIfNeeded({
      publicClient,
      walletClient,
      account,
      registryAddress,
      tenantIdB32,
      signerToSeat: signerAddress,
      chainId: this.chainId,
      gasSafetyFactor: this.gasSafetyFactor,
    });

    // Phase 2 -- register the agent. Idempotent against a crashed retry, like
    // phase 1's isTenantSigner check: read getAgent BEFORE signing/broadcasting.
    const recovered = await checkExistingRegistration({
      publicClient,
      registryAddress,
      agentIdB32,
      requestedScopeHash: scopeHash,
      agentId: req.agentId,
    });
    if (recovered !== null) return recovered;

    const domain = {
      name: "Brain MCP Agent",
      version: "1",
      chainId: this.chainId,
      verifyingContract: registryAddress,
    } as const;
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
    const fees2 = await resolveFees(publicClient);
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
    await assertAffordable(publicClient, account, gas2, fees2.maxFeePerGas, this.gasSafetyFactor);
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
}

// Re-exported so callers that only need the client typings (e.g. tests) do
// not have to reach into registry-shared.js directly.
export type { RegistryPublicClient, RegistryWalletClient };
