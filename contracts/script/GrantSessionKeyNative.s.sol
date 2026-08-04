// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import {BrainSmartAccount} from "../src/BrainSmartAccount.sol";

/// @notice Grant a native-ETH session key to the Brain agent wallet on a
///         deployed BrainSmartAccount.
///
/// Usage:
///   forge script script/GrantSessionKeyNative.s.sol \
///     --sig "run(address,address,address)" \
///     <smart_account_address> <session_key_holder_address> <allowed_recipient> \
///     --rpc-url $BASE_SEPOLIA_RPC_URL \
///     --private-key $DEPLOYER_PRIVATE_KEY \
///     --broadcast
///
/// NATIVE cap mode:
///   - caps apply to msg.value in wei (not an ERC-20 token)
///   - allowedTargets  = [allowedRecipient]  (the ETH destination address)
///   - allowedSelectors= []                  (MUST be empty: NATIVE mode rejects
///                                            any call carrying calldata, which
///                                            is what makes the wei-denominated
///                                            cap sound)
///   - allowedRecipients = []                (ERC20-mode only)
///   - maxPerTx         = 0.001 ether
///   - maxPerPeriod     = 0.01 ether / day
///   - validAfter       = now                (windows anchor here, not at the
///                                            unix epoch)
///   - policyVersion    = bytes32(1)         (must already be registered for
///                                            this tenant in BrainPolicyRegistry;
///                                            matches BRAIN_ONCHAIN_POLICY_VERSION
///                                            = 0x000...0001 in .env)
///
/// The allowed_recipient must match the ETH alias stored on the counterparty
/// in the Ledger (seeded via BRAIN_DEMO_ONCHAIN_RECIPIENT).
///
/// See GrantSessionKey.s.sol for the ERC-20 variant.
contract GrantSessionKeyNative is Script {
    function run(address smartAccount, address holder, address allowedRecipient) external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        address[] memory targets = new address[](1);
        targets[0] = allowedRecipient;

        // NATIVE mode forbids calldata outright, so the selector allowlist must
        // be empty. It previously carried the bytes4(0) sentinel, which is no
        // longer meaningful: the contract checks data.length == 0 directly.
        bytes4[] memory selectors = new bytes4[](0);
        address[] memory recipients = new address[](0);

        BrainSmartAccount.SessionKey memory key = BrainSmartAccount.SessionKey({
            holder: holder,
            validAfter: block.timestamp,
            validUntil: block.timestamp + 30 days,
            allowedTargets: targets,
            allowedSelectors: selectors,
            capMode: BrainSmartAccount.CapMode.NATIVE,
            capToken: address(0), // NATIVE mode — caps denominated in wei
            allowedRecipients: recipients,
            capAmountOffset: 0,
            pinOffset: 0,
            pinValue: bytes32(0),
            maxPerTx: 0.001 ether,
            maxPerPeriod: 0.01 ether,
            periodSeconds: 86_400,
            policyVersion: bytes32(uint256(1))
        });

        vm.startBroadcast(deployerKey);
        BrainSmartAccount(payable(smartAccount)).grantSessionKey(key);
        vm.stopBroadcast();

        console2.log("Native ETH session key granted:");
        console2.log("  smartAccount     =", smartAccount);
        console2.log("  holder           =", holder);
        console2.log("  allowedRecipient =", allowedRecipient);
        console2.log("  maxPerTx         = 0.001 ETH");
        console2.log("  maxPerPeriod     = 0.01 ETH / day");
        console2.log("  validUntil       =", key.validUntil);
        console2.log("  policyVersion    =", vm.toString(key.policyVersion));
    }
}
