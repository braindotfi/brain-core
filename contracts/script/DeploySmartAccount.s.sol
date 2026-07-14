// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import {BrainSmartAccount} from "../src/BrainSmartAccount.sol";

/// @notice Deploy a fresh BrainSmartAccount for the demo tenant.
///
/// Usage:
///   OWNER=0x...  POLICY_REGISTRY=0x...  forge script script/DeploySmartAccount.s.sol \
///     --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $DEPLOYER_PRIVATE_KEY --broadcast
///
/// TENANT_ID defaults to keccak256("demo-tenant").
contract DeploySmartAccount is Script {
    uint256 internal constant BASE_SEPOLIA_CHAIN_ID = 84_532;

    error WrongChain(uint256 chainId);

    function run() external {
        if (block.chainid != BASE_SEPOLIA_CHAIN_ID) revert WrongChain(block.chainid);

        address owner = vm.envAddress("SMART_ACCOUNT_OWNER");
        address policyRegistry = vm.envAddress("BRAIN_POLICY_REGISTRY");
        bytes32 tenantId = vm.envOr("SMART_ACCOUNT_TENANT_ID", keccak256("demo-tenant"));

        vm.startBroadcast();
        BrainSmartAccount account = new BrainSmartAccount(owner, tenantId, policyRegistry);
        vm.stopBroadcast();

        console2.log("BrainSmartAccount deployed:");
        console2.log("  address        =", address(account));
        console2.log("  owner          =", owner);
        console2.log("  policyRegistry =", policyRegistry);
        console2.log("  tenantId       =", vm.toString(tenantId));
    }
}
