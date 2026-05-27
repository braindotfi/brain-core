// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import {BrainReputationRegistry} from "../src/BrainReputationRegistry.sol";

/// @notice Deployment script for `BrainReputationRegistry` (RFC 0001 §7.7, D-6).
/// @dev    ⚠️ UNAUDITED — Base Sepolia (testnet) ONLY until the external audit
///         clears. Kept separate from `Deploy.s.sol` (the audited core) to flag
///         that status. The registry is **non-custodial** (no funds, no value
///         path), so an unaudited deploy risks no money — but it is still batched
///         into the external audit and stays testnet-only until then.
///
///         Target via env:
///           - BRAIN_REPUTATION_ATTESTOR : the reputation oracle. In production
///             this MUST be a Safe multi-sig. It can only publish reputation
///             pointers (Merkle roots) — it has no fund-moving power, and Policy
///             treats reputation as a TIGHTEN-only threshold input, never a §6
///             precondition.
///
///         Run: `forge script script/DeployReputationRegistry.s.sol
///         --rpc-url base_sepolia --broadcast`.
contract DeployReputationRegistry is Script {
    function run() external returns (BrainReputationRegistry registry) {
        address attestor = vm.envAddress("BRAIN_REPUTATION_ATTESTOR");

        vm.startBroadcast();
        registry = new BrainReputationRegistry(attestor);
        vm.stopBroadcast();

        console2.log("BrainReputationRegistry (UNAUDITED / testnet-only):", address(registry));
        console2.log("attestor:", attestor);
    }
}
