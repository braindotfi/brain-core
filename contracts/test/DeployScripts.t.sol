// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {DeployEscrow} from "../script/DeployEscrow.s.sol";
import {DeploySmartAccount} from "../script/DeploySmartAccount.s.sol";
import {GrantSessionKey} from "../script/GrantSessionKey.s.sol";

contract DeployScriptsTest is Test {
    function test_deployEscrow_rejectsMainnetChain() public {
        vm.chainId(8453);
        DeployEscrow script = new DeployEscrow();

        vm.expectRevert(abi.encodeWithSelector(DeployEscrow.WrongChain.selector, uint256(8453)));
        script.run();
    }

    function test_deploySmartAccount_rejectsMainnetChain() public {
        vm.chainId(8453);
        DeploySmartAccount script = new DeploySmartAccount();

        vm.expectRevert(abi.encodeWithSelector(DeploySmartAccount.WrongChain.selector, uint256(8453)));
        script.run();
    }

    function test_grantSessionKeyPaymentSelectorsExcludeApprove() public {
        GrantSessionKey script = new GrantSessionKey();
        bytes4[] memory selectors = script.paymentSelectors();

        assertEq(selectors.length, 2);
        assertEq(selectors[0], bytes4(0xa9059cbb));
        assertEq(selectors[1], bytes4(0x23b872dd));
        for (uint256 i = 0; i < selectors.length; i++) {
            assertTrue(selectors[i] != bytes4(0x095ea7b3));
        }
    }
}
