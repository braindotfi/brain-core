/**
 * Boot fence: every configured contract address must expose the functions this
 * build calls.
 *
 * PR #393 switched the anchor publisher from `anchor()` to `anchorBatch()` and
 * shipped the matching `.sol` in the same commit. The deployed contract was
 * never redeployed, so from 2026-08-02 to 2026-08-06 every publish attempt in
 * both environments reverted at gas estimation, and it took four days of manual
 * investigation to find out. `scripts/check-contract-abi-drift.mjs` could not
 * have caught it: it compares TypeScript against `contracts/out/*.json`, the
 * compiled source in the repo, and the source was consistent. The gap is source
 * versus DEPLOYED, and no static guard closes it.
 *
 * So this is the same fail-closed posture as the sibling fences in this
 * directory (escrow-audit-gate, db-isolation): compute the 4-byte selectors the
 * code depends on, read the deployed runtime bytecode once at boot, and refuse
 * to start when one is missing. A misconfigured address becomes a
 * CrashLoopBackoff, not a silent wave of reverted transactions.
 *
 * Deliberately generic over contracts rather than anchor-specific: the failure
 * mode is not anchor-specific and one shared fence is a smaller diff than a
 * per-contract one.
 *
 * Caveat, matching the escrow bytecode fence: this makes process start depend
 * on RPC availability, so it only fences when an address is actually
 * configured, and only in staging and production.
 */

import { toFunctionSelector, type AbiFunction } from "viem";

export interface ContractSelectorExpectation {
  /** Human name used in the failure message, e.g. "BrainAuditAnchor". */
  readonly contractName: string;
  /** Configured address; undefined means "not wired", and the fence is silent. */
  readonly address: string | undefined;
  /** The ABI entries whose selectors must be present in the deployed bytecode. */
  readonly requiredFunctions: readonly AbiFunction[];
}

export interface ContractSelectorFenceInput {
  readonly nodeEnv: string;
  readonly expectations: readonly ContractSelectorExpectation[];
  /** eth_getCode seam (see composition/eth-getcode.ts). */
  readonly getCode: (address: string) => Promise<string>;
}

/**
 * Selectors a deployed runtime is missing, as lowercase 8-hex-char strings.
 *
 * Substring matching against the runtime bytecode is how a dispatcher table is
 * detected without decompiling. It can in principle match an incidental byte
 * sequence in immutables or constants, so this is a fail-CLOSED check with a
 * false-negative bias: it reliably catches "the function is not there at all",
 * which is the defect it exists for.
 */
export function missingSelectors(
  runtimeBytecode: string,
  requiredFunctions: readonly AbiFunction[],
): string[] {
  const code = runtimeBytecode.toLowerCase();
  const missing: string[] = [];
  for (const fn of requiredFunctions) {
    const selector = toFunctionSelector(fn).slice(2).toLowerCase();
    if (!code.includes(selector)) missing.push(`${fn.name}(0x${selector})`);
  }
  return missing;
}

export async function assertDeployedContractSelectors(
  input: ContractSelectorFenceInput,
): Promise<void> {
  if (input.nodeEnv !== "production" && input.nodeEnv !== "staging") return;

  for (const expectation of input.expectations) {
    if (expectation.address === undefined || expectation.address === "") continue;
    const runtime = await input.getCode(expectation.address);
    if (runtime === "0x" || runtime === "") {
      throw new Error(
        `${expectation.contractName} is configured at ${expectation.address} but that address ` +
          "holds no contract on this chain. Refusing to start.",
      );
    }
    const missing = missingSelectors(runtime, expectation.requiredFunctions);
    if (missing.length > 0) {
      throw new Error(
        `${expectation.contractName} deployed at ${expectation.address} does not expose ` +
          `${missing.join(", ")}. The deployed contract is older than this build; redeploy it ` +
          "or point the address at the current deployment. Refusing to start.",
      );
    }
  }
}
