// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import {BrainEscrow} from "../src/BrainEscrow.sol";

/// @notice Deployment script for `BrainEscrow` (RFC 0001 §7.6).
/// @dev    ⚠️ UNAUDITED — Base Sepolia (testnet) ONLY until the external audit
///         clears (RFC 0001 §9). Kept separate from `Deploy.s.sol` to flag that
///         status and so escrow is never deployed alongside the audited core by
///         accident.
///
///         Target via env:
///           - BRAIN_ESCROW_ARBITER : the dispute arbiter / attester. In
///             production this MUST be a Safe multi-sig (it can release to the
///             designated payee / refund the designated payer, but — by the
///             contract's authorization invariant — can never redirect funds).
///
///         Run: `forge script script/DeployEscrow.s.sol --rpc-url base_sepolia
///         --broadcast`. A mainnet run happens ONLY after the audit clears, using
///         the multi-sig as deployer (§10.4); the arbiter is the production Safe.
contract DeployEscrow is Script {
    uint256 internal constant BASE_SEPOLIA_CHAIN_ID = 84_532;

    error WrongChain(uint256 chainId);

    function run() external returns (BrainEscrow escrow) {
        if (block.chainid != BASE_SEPOLIA_CHAIN_ID) revert WrongChain(block.chainid);

        address arbiter = vm.envAddress("BRAIN_ESCROW_ARBITER");

        vm.startBroadcast();
        escrow = new BrainEscrow(arbiter);
        vm.stopBroadcast();

        console2.log("BrainEscrow (UNAUDITED / testnet-only):", address(escrow));
        console2.log("arbiter:", arbiter);
    }
}
