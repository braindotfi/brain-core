// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import {BrainSmartAccount} from "../src/BrainSmartAccount.sol";

/// @notice Grant a scoped session key to the Brain agent wallet on a deployed
///         BrainSmartAccount.
///
/// Usage:
///   forge script script/GrantSessionKey.s.sol \
///     --sig "run(address,address,address,address)" \
///     <smart_account_address> <session_key_holder_address> <allowed_token> \
///     <allowed_recipient> \
///     --rpc-url $BASE_SEPOLIA_RPC_URL \
///     --private-key $DEPLOYER_PRIVATE_KEY \
///     --broadcast
///
/// ERC20 cap mode. Empty allowlists are rejected at grant time (the old
/// "any target / any selector" key was a footgun). This script grants a key
/// scoped to:
///   - capMode          = ERC20
///   - allowedTargets   = [allowedToken]                 (e.g. USDC on Base)
///   - allowedSelectors = [transfer, transferFrom]
///   - allowedRecipients= [allowedRecipient]             (the counterparty)
///   - maxPerTx         = 1_000e6   (1,000 USDC; 6-decimal token)
///   - maxPerPeriod     = 10_000e6  (10,000 USDC / day)
///   - periodSeconds    = 86_400    (daily cumulative window)
///   - validAfter       = now       (windows anchor here, not at the epoch)
///   - validUntil       = now + 30 days (rotate before mainnet)
///   - policyVersion    = bytes32(1) (must already be registered for this
///                                    tenant in BrainPolicyRegistry)
///
/// `allowedRecipient` is required, not optional: in ERC20 mode the only allowed
/// TARGET is the token contract itself, so the payee lives in calldata. Without
/// a recipient allowlist the key could transfer its full cap to any address.
///
/// `approve` is deliberately not grantable in this mode: an allowance outlives
/// the accounting window and would let a holder accumulate claimable value past
/// the cumulative cap.
///
/// Tune the caps/target for the specific deployment before broadcasting.
contract GrantSessionKey is Script {
    function paymentSelectors() public pure returns (bytes4[] memory selectors) {
        selectors = new bytes4[](2);
        selectors[0] = 0xa9059cbb; // transfer(address,uint256)
        selectors[1] = 0x23b872dd; // transferFrom(address,address,uint256)
    }

    function run(address smartAccount, address holder, address allowedToken, address allowedRecipient) external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        address[] memory targets = new address[](1);
        targets[0] = allowedToken;

        address[] memory recipients = new address[](1);
        recipients[0] = allowedRecipient;

        bytes4[] memory selectors = paymentSelectors();

        BrainSmartAccount.SessionKey memory key = BrainSmartAccount.SessionKey({
            holder: holder,
            validAfter: block.timestamp,
            validUntil: block.timestamp + 30 days,
            allowedTargets: targets,
            allowedSelectors: selectors,
            capMode: BrainSmartAccount.CapMode.ERC20,
            capToken: allowedToken,
            allowedRecipients: recipients,
            capAmountOffset: 0,
            maxPerTx: 1000e6,
            maxPerPeriod: 10_000e6,
            periodSeconds: 86_400,
            policyVersion: bytes32(uint256(1))
        });

        vm.startBroadcast(deployerKey);
        BrainSmartAccount(payable(smartAccount)).grantSessionKey(key);
        vm.stopBroadcast();

        console2.log("Session key granted:");
        console2.log("  smartAccount =", smartAccount);
        console2.log("  holder       =", holder);
        console2.log("  allowedToken =", allowedToken);
        console2.log("  recipient    =", allowedRecipient);
        console2.log("  capToken     =", key.capToken);
        console2.log("  maxPerTx     =", key.maxPerTx);
        console2.log("  maxPerPeriod =", key.maxPerPeriod);
        console2.log("  validUntil   =", key.validUntil);
        console2.log("  policyVersion=", vm.toString(key.policyVersion));
    }
}
