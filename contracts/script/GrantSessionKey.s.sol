// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import {BrainSmartAccount} from "../src/BrainSmartAccount.sol";

/// @notice Grant a session key to the Brain agent wallet on a deployed BrainSmartAccount.
///
/// Usage:
///   forge script script/GrantSessionKey.s.sol \
///     --sig "run(address,address)" \
///     <smart_account_address> <session_key_holder_address> \
///     --rpc-url $BASE_SEPOLIA_RPC_URL \
///     --private-key $DEPLOYER_PRIVATE_KEY \
///     --broadcast
///
/// The session key is granted with:
///   - No target allowlist (any target allowed)
///   - No selector allowlist (any selector allowed)
///   - maxPerTx = type(uint256).max (no per-tx cap for PoC)
///   - periodSeconds = 0 (cumulative period accounting disabled)
///   - validUntil = 9999999999 (far future — rotate before mainnet)
///   - policyVersion = bytes32(1) (non-zero placeholder; off-chain gate validates real version)
contract GrantSessionKey is Script {
    function run(address smartAccount, address holder) external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        BrainSmartAccount.SessionKey memory key = BrainSmartAccount.SessionKey({
            holder: holder,
            validAfter: 0,
            validUntil: 9_999_999_999,
            allowedTargets: new address[](0),
            allowedSelectors: new bytes4[](0),
            maxPerTx: type(uint256).max,
            maxPerPeriod: type(uint256).max,
            periodSeconds: 0,
            policyVersion: bytes32(uint256(1))
        });

        vm.startBroadcast(deployerKey);
        BrainSmartAccount(payable(smartAccount)).grantSessionKey(key);
        vm.stopBroadcast();

        console2.log("Session key granted:");
        console2.log("  smartAccount =", smartAccount);
        console2.log("  holder       =", holder);
        console2.log("  validUntil   =", key.validUntil);
        console2.log("  policyVersion=", vm.toString(key.policyVersion));
    }
}
