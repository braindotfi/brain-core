/**
 * TenantSignedRegistrationRelayer -- RFC 0002 Phase C, increment 4 (tier 2).
 *
 * `BrainMCPAgentRegistry._requireQuorum` has no bootstrap branch, so a
 * tenant address can only ever become a tenant signer through the
 * registry's `initialAdmin` bootstrap branch in `setTenantSigner`. Tier 2 is
 * therefore honestly described as: Brain sends exactly ONE custodial
 * transaction (phase 1, `bootstrapTenantSignerIfNeeded`) to seat the
 * CUSTOMER's designated address as that tenant's first signer, and after
 * that every `registerAgent` (phase 2) is signed by the CUSTOMER, not
 * Brain -- Brain only broadcasts and pays gas. See
 * docs/contracts/production-agents.md for the full tier comparison.
 *
 * The customer's phase-2 signature is collected out of band, over the exact
 * digest `buildAttestationPayload` (via registry-shared.js) computes, at
 * POST /agents/{agent_id}/attestation -- verified there against
 * tenants.onchain_signer_address BEFORE it is ever stored, and only reaches
 * this relayer already-verified via AgentService.confirmRegistration.
 *
 * FAIL CLOSED, same posture as KmsCustodialRegistrationRelayer: `configured`
 * is true only when the signer key, RPC URL, and registry address are ALL
 * present.
 */

import { zeroHash, type Address, type Hex } from "viem";
import type { AuditEmitter } from "@brain/shared";
import type {
  AgentRegistrationRelayer,
  AgentRegistrationRequest,
  AgentRegistrationResult,
  AttestationPayload,
  AttestationRelayerMode,
} from "../registration-relayer.js";
import {
  REGISTRY_ABI,
  ZERO_ADDRESS,
  DEFAULT_CHAIN_ID,
  assertAffordable,
  bootstrapTenantSignerIfNeeded,
  buildAgentRegistrationTypedData,
  checkExistingRegistration,
  hashBrainId,
  makeRegistryClients,
  resolveFees,
} from "./registry-shared.js";

export interface TenantSignedRegistrationRelayerOptions {
  /** Brain's OWN initialAdmin signer key -- pays gas + performs the one bootstrap tx. Never the tenant's key. */
  privateKey: `0x${string}` | undefined;
  rpcUrl: string | undefined;
  registryAddress: `0x${string}` | undefined;
  chainId?: number;
  audit?: AuditEmitter;
  gasSafetyFactor?: number;
}

/** Thrown when a request would place Brain's own initialAdmin address in authSigners. Must never happen. */
export class BrainSelfAttestationForbiddenError extends Error {
  public override readonly name = "BrainSelfAttestationForbiddenError";
  public constructor(address: string) {
    super(
      "TenantSignedRegistrationRelayer refuses to register with Brain's own initialAdmin " +
        "address (" +
        address +
        ") as the tenant signer -- tier 2 requires a customer-controlled key, use " +
        "onchain_custodial if Brain should hold the signer",
    );
  }
}

/**
 * The tenant-signed relayer for attestation_mode="tenant_signed" only.
 * Rejects "onchain_custodial" (KmsCustodialRegistrationRelayer handles that).
 */
export class TenantSignedRegistrationRelayer implements AgentRegistrationRelayer {
  public readonly configured: boolean;
  public readonly supportedModes: readonly AttestationRelayerMode[] = ["tenant_signed"];
  private readonly clients: ReturnType<typeof makeRegistryClients> | undefined;
  private readonly registryAddress: Address | undefined;
  private readonly chainId: number;
  private readonly gasSafetyFactor: number;
  private readonly audit: AuditEmitter | undefined;

  public constructor(opts: TenantSignedRegistrationRelayerOptions) {
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

  public buildAttestationPayload(input: {
    agentId: string;
    tenantId: string;
    onchainAddress: string;
    scopeHash: string;
  }): AttestationPayload {
    if (this.registryAddress === undefined) {
      throw new Error(
        "TenantSignedRegistrationRelayer is not configured; cannot build an attestation payload",
      );
    }
    return buildAgentRegistrationTypedData({
      ...input,
      registryAddress: this.registryAddress,
      chainId: this.chainId,
    });
  }

  public async submitRegistration(req: AgentRegistrationRequest): Promise<AgentRegistrationResult> {
    if (!this.configured || this.clients === undefined || this.registryAddress === undefined) {
      throw new Error(
        "TenantSignedRegistrationRelayer is not configured (missing signer key, RPC URL, or " +
          "registry address); agent stays pending_onchain",
      );
    }
    if (req.mode !== "tenant_signed") {
      throw new Error(
        "TenantSignedRegistrationRelayer only handles attestation_mode=tenant_signed, got " +
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
    if (req.tenantSignerAddress === undefined || req.tenantSignerAddress.length === 0) {
      throw new Error(
        "agent " +
          req.agentId +
          " has no tenantSignerAddress; POST /agents/" +
          req.agentId +
          "/attestation must be called before confirmation can proceed",
      );
    }
    if (req.tenantSignature === undefined || req.tenantSignature.length === 0) {
      throw new Error(
        "agent " +
          req.agentId +
          " has no tenantSignature; POST /agents/" +
          req.agentId +
          "/attestation must be called before confirmation can proceed",
      );
    }

    const { account, publicClient, walletClient } = this.clients;
    const registryAddress = this.registryAddress;
    const tenantSignerAddress = req.tenantSignerAddress as Address;

    // HARD ASSERT: Brain's own initialAdmin address must never be the tenant
    // signer this relayer registers on behalf of. If it were, "tier 2" would
    // silently degrade into tier 3 (Brain custody) while still claiming to be
    // customer-signed.
    if (tenantSignerAddress.toLowerCase() === account.address.toLowerCase()) {
      throw new BrainSelfAttestationForbiddenError(account.address);
    }

    const tenantIdB32 = hashBrainId(req.tenantId);
    const agentIdB32 = hashBrainId(req.agentId);
    const scopeHash = ("0x" + req.scopeHash) as Hex;
    const behaviorHash = zeroHash;
    const agentAddress = req.onchainAddress as Address;

    // Phase 1 -- bootstrap/seat the CUSTOMER's address as the tenant signer.
    // Brain (this.clients.account) is still the broadcaster + authSigner for
    // THIS ONE transaction only -- the registry has no other bootstrap path.
    await bootstrapTenantSignerIfNeeded({
      publicClient,
      walletClient,
      account,
      registryAddress,
      tenantIdB32,
      signerToSeat: tenantSignerAddress,
      chainId: this.chainId,
      gasSafetyFactor: this.gasSafetyFactor,
    });

    // Phase 2 -- register the agent. Idempotent against a crashed retry.
    const recovered = await checkExistingRegistration({
      publicClient,
      registryAddress,
      agentIdB32,
      requestedScopeHash: scopeHash,
      agentId: req.agentId,
    });
    if (recovered !== null) return recovered;

    // Brain broadcasts and pays gas, but the signature is the CUSTOMER's own
    // -- already verified against tenantSignerAddress at
    // POST /agents/{id}/attestation, BEFORE it was ever stored.
    const fees = await resolveFees(publicClient);
    const gas = await publicClient.estimateContractGas({
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
        tenantSignerAddress,
        req.tenantSignature as Hex,
      ],
    });
    await assertAffordable(publicClient, account, gas, fees.maxFeePerGas, this.gasSafetyFactor);
    const tx = await walletClient.writeContract({
      address: registryAddress,
      abi: REGISTRY_ABI,
      functionName: "registerAgent",
      args: [
        agentIdB32,
        agentAddress,
        tenantIdB32,
        scopeHash,
        behaviorHash,
        tenantSignerAddress,
        req.tenantSignature as Hex,
      ],
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
    if (receipt.status !== "success") {
      throw new Error("registerAgent reverted (tx " + tx + ")");
    }

    await this.audit?.emit({
      tenantId: req.tenantId,
      layer: "agent",
      actor: "system:tenant-signed-relayer",
      action: "agent.tenant_signed_registered",
      inputs: { agent_id: req.agentId },
      outputs: { custodial: false, signer_address: tenantSignerAddress, tx_hash: tx },
    });

    return { txHash: tx };
  }
}
