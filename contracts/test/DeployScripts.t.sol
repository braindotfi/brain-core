// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {DeployEscrow} from "../script/DeployEscrow.s.sol";
import {DeploySmartAccount} from "../script/DeploySmartAccount.s.sol";

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
}
