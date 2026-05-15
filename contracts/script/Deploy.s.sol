// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import {BrainAuditAnchor} from "../src/BrainAuditAnchor.sol";
import {BrainPolicyRegistry} from "../src/BrainPolicyRegistry.sol";
import {BrainMCPAgentRegistry} from "../src/BrainMCPAgentRegistry.sol";

/// @notice Deployment script for Brain contracts.
/// @dev    Targets configured via env:
///           - PUBLISHER_MULTISIG    : address that will control BrainAuditAnchor
///           - AGENT_REGISTRY_ADMIN  : initial admin for BrainMCPAgentRegistry
///           - POLICY_REGISTRY_ADMIN : initial admin for BrainPolicyRegistry
///                                     (bootstraps the first signer per tenant)
///         Run with e.g. `forge script script/Deploy.s.sol --rpc-url base_sepolia
///         --broadcast`. Mainnet deploy happens only after external audit and
///         uses the 2-of-3 multi-sig as deployer per §10.4.
///
///         BrainSmartAccount is NOT deployed here — it's a per-tenant factory
///         target instantiated during customer onboarding. A factory contract
///         lands in a post-audit follow-up; for MVP, we document the
///         instantiation flow in docs/smart-accounts.md.
contract Deploy is Script {
    function run() external {
        address publisher = vm.envAddress("PUBLISHER_MULTISIG");
        address admin = vm.envAddress("AGENT_REGISTRY_ADMIN");
        address policyAdmin = vm.envAddress("POLICY_REGISTRY_ADMIN");

        vm.startBroadcast();

        BrainAuditAnchor anchor = new BrainAuditAnchor(publisher);
        BrainPolicyRegistry policyRegistry = new BrainPolicyRegistry(policyAdmin);
        BrainMCPAgentRegistry agentRegistry = new BrainMCPAgentRegistry(admin);

        vm.stopBroadcast();

        // Log addresses for the post-deploy infra PR (Key Vault, env config).
        console2.log("BrainAuditAnchor    :", address(anchor));
        console2.log("BrainPolicyRegistry :", address(policyRegistry));
        console2.log("BrainMCPAgentRegistry:", address(agentRegistry));
    }
}
