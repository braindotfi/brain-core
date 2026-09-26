// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import {BrainSmartAccount} from "../src/BrainSmartAccount.sol";

/// @notice Activate a pending BrainSmartAccount session-key grant after delay.
contract ActivateSessionKeyGrant is Script {
    function run(address smartAccount, address holder) external {
        uint256 ownerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(ownerKey);
        BrainSmartAccount(payable(smartAccount)).activatePendingSessionKeyGrant(holder);
        vm.stopBroadcast();

        console2.log("Pending session key activated:");
        console2.log("  smartAccount =", smartAccount);
        console2.log("  holder       =", holder);
    }
}
