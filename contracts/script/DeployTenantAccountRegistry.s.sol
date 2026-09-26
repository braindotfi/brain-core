// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import {BrainTenantAccountRegistry} from "../src/BrainTenantAccountRegistry.sol";

/// @notice Deploy the tenant to BrainSmartAccount registry on Base Sepolia.
contract DeployTenantAccountRegistry is Script {
    uint256 internal constant BASE_SEPOLIA_CHAIN_ID = 84_532;

    error WrongChain(uint256 chainId);
    error RegistryOwnerMustBeContract(address owner);

    function run() external {
        if (block.chainid != BASE_SEPOLIA_CHAIN_ID) revert WrongChain(block.chainid);

        address owner = vm.envAddress("TENANT_ACCOUNT_REGISTRY_OWNER");
        if (owner.code.length == 0) revert RegistryOwnerMustBeContract(owner);

        vm.startBroadcast();
        BrainTenantAccountRegistry registry = new BrainTenantAccountRegistry(owner);
        vm.stopBroadcast();

        console2.log("BrainTenantAccountRegistry deployed:");
        console2.log("  address =", address(registry));
        console2.log("  owner   =", owner);
    }
}
