// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import {BrainSmartAccount} from "../src/BrainSmartAccount.sol";

/// @notice Deploy a BrainSmartAccount for the demo tenant, grant the Brain
///         agent session key, and fund the account with ETH for testnet runs.
///
/// Usage (from repo root):
///   DEPLOYER_PRIVATE_KEY=0x<64-hex-key> \
///   BRAIN_TENANT_ID=tnt_00000000010000000000000000 \
///   ONCHAIN_RECIPIENT=0x<40-hex-address> \
///   forge script contracts/script/DeployOnchainDemo.s.sol \
///     --rpc-url https://sepolia.base.org --broadcast
///
/// Simplest topology: set DEPLOYER_PRIVATE_KEY == BRAIN_SESSION_KEY and
/// ONCHAIN_RECIPIENT == the EOA address for that key. The smart account
/// will send ETH to itself, which is fine on testnet and avoids losing funds.
///
/// After broadcast, copy the logged BRAIN_ONCHAIN_SMART_ACCOUNT address into
/// brain-core/.env, then restart the API server.
contract DeployOnchainDemo is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        bytes32 tenantIdHash = keccak256(bytes(vm.envString("BRAIN_TENANT_ID")));
        address recipient = vm.envAddress("ONCHAIN_RECIPIENT");

        address[] memory targets = new address[](1);
        targets[0] = recipient;

        // bytes4(0) matches empty calldata (native ETH transfer, data = "0x").
        // resolveOnchainParams in main.ts hardcodes data:"0x", so the selector
        // the contract derives is bytes4(0) per the executeViaSessionKey logic:
        //   data.length >= 4 ? bytes4(data[:4]) : bytes4(0)
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = bytes4(0);

        BrainSmartAccount.SessionKey memory key = BrainSmartAccount.SessionKey({
            holder: deployer,
            validAfter: 0,
            validUntil: block.timestamp + 30 days,
            allowedTargets: targets,
            allowedSelectors: selectors,
            capToken: address(0),
            maxPerTx: 0.05 ether,
            maxPerPeriod: 0.5 ether,
            periodSeconds: 86_400,
            // bytes32(uint256(1)) matches BRAIN_ONCHAIN_POLICY_VERSION=0x000...001
            policyVersion: bytes32(uint256(1))
        });

        vm.startBroadcast(deployerKey);

        // policyRegistry=address(0): executeViaSessionKey does not re-query the
        // registry at call time (it trusts the policyVersion stored at grant).
        BrainSmartAccount account = new BrainSmartAccount(deployer, tenantIdHash, address(0));
        account.grantSessionKey(key);
        // Fund the smart account so it can forward value to the target.
        payable(address(account)).transfer(0.1 ether);

        vm.stopBroadcast();

        console2.log("=== DeployOnchainDemo results ===");
        console2.log("BrainSmartAccount    :", address(account));
        console2.log("Owner / SessionHolder:", deployer);
        console2.log("AllowedTarget        :", recipient);
        console2.log("Funded with ETH      : 0.1");
        console2.log("");
        console2.log("Add to brain-core/.env:");
        console2.log("  BRAIN_ONCHAIN_SMART_ACCOUNT=", vm.toString(address(account)));
        console2.log("  BRAIN_ONCHAIN_POLICY_VERSION=0x0000000000000000000000000000000000000000000000000000000000000001");
    }
}
