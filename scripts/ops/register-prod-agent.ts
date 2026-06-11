/**
 * register-prod-agent — bootstrap a tenant signer and register a single agent
 * on-chain in BrainMCPAgentRegistry (Base Sepolia), so the MCP auth path stops
 * failing closed with `agent_scope_hash_mismatch`.
 *
 * Why a new script (not scripts/register-internal-agents.ts): that one is a
 * dry-run TODO wired to the OLD 6-arg registerAgent signature and is per-catalog,
 * not per-agent. This one drives the 7-arg signature against a redeployed
 * registry and targets one prod agent.
 *
 * Two phases, both EIP-712-signed by the tenant signer (= deployer key, which is
 * the registry's `initialAdmin` so it may bootstrap the first signer per tenant):
 *
 *   1. setTenantSigner  — TenantSignerChange(bytes32 tenantId,address signer,
 *                         bool allowed,uint256 nonce). First-ever signer must be
 *                         signed by initialAdmin (contract bootstrap path).
 *   2. registerAgent    — AgentRegistration(bytes32 agentId,address agentAddress,
 *                         bytes32 tenantId,bytes32 scopeHash,bytes32 behaviorHash).
 *
 * Encodings (pinned — must be identical to the on-chain consumers):
 *   - agentId  → keccak256(toBytes(AGENT_ID))   (matches viemScopeChecker.ts:50)
 *   - tenantId → keccak256(toBytes(TENANT_ID))  (no on-chain reader compares the
 *                tenantId field — auth.ts checks only scopeHash, and
 *                agent-attestation.ts checks only registeredAt/revokedAt — so the
 *                only requirement is that BOTH phases here use the same bytes32;
 *                keccak avoids the 32-byte overflow a right-padded UTF-8 ULID hits)
 *   - scopeHash → computeAgentScopeHash(PAYMENT_AGENT_SCOPES) (shared helper; the
 *                SAME value the demo seed writes into agents.scope_hash)
 *   - behaviorHash → 0x0 (auth ignores it; no canonical runtime compute exists.
 *                gate check 1.5 only bites at execute-time with pinning enabled)
 *
 * Default = DRY RUN: derives + prints every value and reads current chain state
 * (nonce, isTenantSigner, getAgent) but broadcasts nothing. Pass --broadcast to
 * send the two transactions.
 *
 * Run (from repo root; uses @brain/api's viem + @brain/shared resolution):
 *   pnpm --filter @brain/api exec tsx ../../scripts/ops/register-prod-agent.ts
 *   pnpm --filter @brain/api exec tsx ../../scripts/ops/register-prod-agent.ts --broadcast
 *
 * Required env:
 *   BASE_SEPOLIA_RPC_URL        Base Sepolia JSON-RPC endpoint
 *   MCP_AGENT_REGISTRY_ADDRESS  the NEWLY redeployed 7-field registry address
 *   TENANT_ID                   golden tenant id (string)
 *   AGENT_ID                    golden agent id (string, e.g. agent_01KTNJ...)
 *   AGENT_ADDRESS               the agent row's onchain_address (must be non-zero)
 *   TENANT_SIGNER_PRIVATE_KEY   deployer key (= registry initialAdmin) 0x...
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseAbi,
  toBytes,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { computeAgentScopeHash, PAYMENT_AGENT_SCOPES } from "@brain/shared";

const CHAIN_ID = 84532;

const REGISTRY_ABI = parseAbi([
  "function signerNonce(bytes32 tenantId) view returns (uint256)",
  "function isTenantSigner(bytes32 tenantId, address a) view returns (bool)",
  "function setTenantSigner(bytes32 tenantId, address signer, bool allowed, address authSigner, bytes signature)",
  "function registerAgent(bytes32 agentId, address agentAddress, bytes32 tenantId, bytes32 scopeHash, bytes32 behaviorHash, bytes tenantSignature)",
  "function getAgent(bytes32 agentId) view returns ((bytes32 agentId, address agentAddress, bytes32 tenantId, bytes32 scopeHash, bytes32 behaviorHash, uint256 registeredAt, uint256 revokedAt))",
]);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(`missing required env: ${name}`);
  }
  return v;
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  const broadcast = process.argv.includes("--broadcast");

  const rpcUrl = requireEnv("BASE_SEPOLIA_RPC_URL");
  const registry = requireEnv("MCP_AGENT_REGISTRY_ADDRESS") as Address;
  const tenantId = requireEnv("TENANT_ID");
  const agentId = requireEnv("AGENT_ID");
  const agentAddress = requireEnv("AGENT_ADDRESS") as Address;
  const signerKey = requireEnv("TENANT_SIGNER_PRIVATE_KEY") as Hex;

  const account = privateKeyToAccount(signerKey);
  const signerAddress = account.address;

  // --- Derived bytes32 values (pinned encodings — see header). --------------
  const tenantIdB32 = keccak256(toBytes(tenantId));
  const agentIdB32 = keccak256(toBytes(agentId));
  const scopeHash = computeAgentScopeHash(PAYMENT_AGENT_SCOPES);
  const behaviorHash = zeroHash;

  if (agentAddress.toLowerCase() === "0x0000000000000000000000000000000000000000") {
    throw new Error(
      "AGENT_ADDRESS is the zero address; registerAgent reverts with ZeroAddress. " +
        "Set the agent row's onchain_address first.",
    );
  }

  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });

  const nonce = await publicClient.readContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: "signerNonce",
    args: [tenantIdB32],
  });
  const alreadySigner = await publicClient.readContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: "isTenantSigner",
    args: [tenantIdB32, signerAddress],
  });
  const existing = await publicClient.readContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: "getAgent",
    args: [agentIdB32],
  });
  const alreadyRegistered = existing.registeredAt !== 0n;

  out(
    JSON.stringify(
      {
        mode: broadcast ? "broadcast" : "dry-run",
        registry,
        chainId: CHAIN_ID,
        tenantId,
        tenantIdB32,
        agentId,
        agentIdB32,
        agentAddress,
        signerAddress,
        scope: { scopes: [...PAYMENT_AGENT_SCOPES], scopeHash },
        behaviorHash,
        chainState: {
          signerNonce: nonce.toString(),
          isTenantSigner: alreadySigner,
          agentAlreadyRegistered: alreadyRegistered,
        },
      },
      null,
      2,
    ),
  );

  if (!broadcast) {
    out("dry-run: no transactions sent. Re-run with --broadcast to register.");
    return;
  }

  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });
  const domain = {
    name: "Brain MCP Agent",
    version: "1",
    chainId: CHAIN_ID,
    verifyingContract: registry,
  } as const;

  // --- Phase 1: bootstrap the tenant signer (idempotent). -------------------
  if (alreadySigner) {
    out("phase 1: signer already authorized for tenant — skipping setTenantSigner.");
  } else {
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
      message: { tenantId: tenantIdB32, signer: signerAddress, allowed: true, nonce },
    });
    const tx1 = await wallet.writeContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: "setTenantSigner",
      args: [tenantIdB32, signerAddress, true, signerAddress, signerChangeSig],
    });
    out(`phase 1: setTenantSigner tx=${tx1}`);
    const r1 = await publicClient.waitForTransactionReceipt({ hash: tx1 });
    out(`phase 1: status=${r1.status} block=${r1.blockNumber.toString()}`);
    if (r1.status !== "success") throw new Error("setTenantSigner reverted");
  }

  // --- Phase 2: register the agent. -----------------------------------------
  if (alreadyRegistered) {
    out("phase 2: agent already registered on-chain — skipping registerAgent.");
  } else {
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
    const tx2 = await wallet.writeContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: "registerAgent",
      args: [agentIdB32, agentAddress, tenantIdB32, scopeHash, behaviorHash, registrationSig],
    });
    out(`phase 2: registerAgent tx=${tx2}`);
    const r2 = await publicClient.waitForTransactionReceipt({ hash: tx2 });
    out(`phase 2: status=${r2.status} block=${r2.blockNumber.toString()}`);
    if (r2.status !== "success") throw new Error("registerAgent reverted");
  }

  // --- Confirm. -------------------------------------------------------------
  const confirmed = await publicClient.readContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: "getAgent",
    args: [agentIdB32],
  });
  out(
    JSON.stringify(
      {
        confirmed: {
          agentAddress: confirmed.agentAddress,
          scopeHash: confirmed.scopeHash,
          behaviorHash: confirmed.behaviorHash,
          registeredAt: confirmed.registeredAt.toString(),
          revokedAt: confirmed.revokedAt.toString(),
          scopeHashMatchesSeed: confirmed.scopeHash.toLowerCase() === scopeHash.toLowerCase(),
        },
      },
      null,
      2,
    ),
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
