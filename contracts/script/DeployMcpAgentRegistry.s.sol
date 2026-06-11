// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import {BrainMCPAgentRegistry} from "../src/BrainMCPAgentRegistry.sol";

/// @notice Registry-only redeploy of BrainMCPAgentRegistry to Base Sepolia.
/// @dev    Deliberately does NOT reuse Deploy.s.sol, which also mints a fresh
///         BrainAuditAnchor + BrainPolicyRegistry. This script exists solely to
///         replace the stale 6-field registry (deployed before `behaviorHash`
///         was added to AgentRegistration) at 0xd1558828… with the current
///         7-field struct the API ABI expects (services/api/src/mcp/
///         viemScopeChecker.ts). The old layout makes viem overrun the tuple
///         decode and read every registered agent as null, so MCP auth fails
///         closed for every call.
///
///         Env:
///           - AGENT_REGISTRY_ADMIN : initial admin / first-signer bootstrap
///                                    (must be a key we control; it signs the
///                                    first setTenantSigner per tenant).
///         Run:
///           forge script script/DeployMcpAgentRegistry.s.sol:DeployMcpAgentRegistry \
///             --rpc-url base_sepolia --private-key $DEPLOYER_PRIVATE_KEY \
///             --broadcast --json
contract DeployMcpAgentRegistry is Script {
    function run() external returns (address registry) {
        address admin = vm.envAddress("AGENT_REGISTRY_ADMIN");

        vm.startBroadcast();
        BrainMCPAgentRegistry agentRegistry = new BrainMCPAgentRegistry(admin);
        vm.stopBroadcast();

        registry = address(agentRegistry);
        console2.log("BrainMCPAgentRegistry:", registry);
    }
}
