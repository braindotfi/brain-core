/**
 * On-chain policy registration helper for BrainPolicyRegistry.
 *
 * Registers a policy hash on Base Sepolia via BrainPolicyRegistry.registerPolicy.
 * Bootstraps the signer allowlist for a tenant when it has no signers yet (using
 * the initialAdmin role — in demo/testnet deployments BRAIN_SESSION_KEY EOA is
 * the initialAdmin). Writes are fire-and-don't-block-activation; the caller should
 * catch and warn on failure rather than rejecting the off-chain activation.
 *
 * Env: BRAIN_SESSION_KEY, BASE_RPC_URL, POLICY_REGISTRY_ADDRESS.
 */

import { createPublicClient, createWalletClient, http, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const REGISTRY_ABI = [
  {
    name: "isTenantSigner",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "tenantId", type: "bytes32" },
      { name: "a", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    name: "latestVersion",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tenantId", type: "bytes32" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "tenantSignerNonce",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tenantId", type: "bytes32" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "setTenantSigner",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tenantId", type: "bytes32" },
      { name: "signer", type: "address" },
      { name: "allowed", type: "bool" },
      { name: "authSigner", type: "address" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    name: "registerPolicy",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tenantId", type: "bytes32" },
      { name: "version", type: "uint256" },
      { name: "policyHash", type: "bytes32" },
      { name: "signers", type: "address[]" },
      { name: "signatures", type: "bytes[]" },
    ],
    outputs: [],
  },
] as const;

export interface PolicyRegistrarOptions {
  privateKey: `0x${string}`;
  rpcUrl: string;
  registryAddress: `0x${string}`;
}

export interface RegisterPolicyResult {
  tx_hash: string;
  chain: string;
  version: number;
}

export function buildPolicyRegistrar(opts: PolicyRegistrarOptions) {
  const account = privateKeyToAccount(opts.privateKey);
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(opts.rpcUrl),
  });
  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(opts.rpcUrl),
  });

  const domain = {
    name: "Brain Policy",
    version: "1",
    chainId: 84532,
    verifyingContract: opts.registryAddress,
  } as const;

  return {
    async registerPolicy(
      tenantIdStr: string,
      policyHashBuffer: Buffer,
    ): Promise<RegisterPolicyResult> {
      const tenantIdBytes = keccak256(toBytes(tenantIdStr)) as `0x${string}`;
      const policyHashHex = `0x${policyHashBuffer.toString("hex")}` as `0x${string}`;
      const signerAddr = account.address;

      // ── 1. Bootstrap signer if not already authorized ─────────────────────
      const isSigner = await publicClient.readContract({
        address: opts.registryAddress,
        abi: REGISTRY_ABI,
        functionName: "isTenantSigner",
        args: [tenantIdBytes, signerAddr],
      });

      // Get pending nonce once to sequence all txs correctly even before prior ones mine
      let walletNonce = await publicClient.getTransactionCount({
        address: signerAddr,
        blockTag: "pending",
      });

      if (!isSigner) {
        const nonce = await publicClient.readContract({
          address: opts.registryAddress,
          abi: REGISTRY_ABI,
          functionName: "tenantSignerNonce",
          args: [tenantIdBytes],
        });

        const bootstrapSig = await walletClient.signTypedData({
          account,
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
          message: { tenantId: tenantIdBytes, signer: signerAddr, allowed: true, nonce },
        });

        await walletClient.writeContract({
          address: opts.registryAddress,
          abi: REGISTRY_ABI,
          functionName: "setTenantSigner",
          args: [tenantIdBytes, signerAddr, true, signerAddr, bootstrapSig],
          nonce: walletNonce++,
        });
      }

      // ── 2. Determine next version ──────────────────────────────────────────
      const latest = await publicClient.readContract({
        address: opts.registryAddress,
        abi: REGISTRY_ABI,
        functionName: "latestVersion",
        args: [tenantIdBytes],
      });
      const nextVersion = (latest as bigint) + 1n;

      // ── 3. Sign PolicyRegistration struct ──────────────────────────────────
      const policySig = await walletClient.signTypedData({
        account,
        domain,
        types: {
          PolicyRegistration: [
            { name: "tenantId", type: "bytes32" },
            { name: "version", type: "uint256" },
            { name: "policyHash", type: "bytes32" },
          ],
        },
        primaryType: "PolicyRegistration",
        message: { tenantId: tenantIdBytes, version: nextVersion, policyHash: policyHashHex },
      });

      // ── 4. Register on-chain ───────────────────────────────────────────────
      const txHash = await walletClient.writeContract({
        address: opts.registryAddress,
        abi: REGISTRY_ABI,
        functionName: "registerPolicy",
        args: [tenantIdBytes, nextVersion, policyHashHex, [signerAddr], [policySig]],
        nonce: walletNonce,
      });

      return { tx_hash: txHash, chain: "base-sepolia", version: Number(nextVersion) };
    },
  };
}
