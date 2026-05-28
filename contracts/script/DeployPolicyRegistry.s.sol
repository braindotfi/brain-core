// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import {BrainPolicyRegistry} from "../src/BrainPolicyRegistry.sol";

contract DeployPolicyRegistry is Script {
    function run() external {
        address admin = vm.envAddress("POLICY_REGISTRY_ADMIN");
        vm.startBroadcast();
        BrainPolicyRegistry registry = new BrainPolicyRegistry(admin);
        vm.stopBroadcast();
        console2.log("BrainPolicyRegistry:", address(registry));
    }
}
