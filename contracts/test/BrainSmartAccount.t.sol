// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {BrainSmartAccount} from "../src/BrainSmartAccount.sol";

contract Target {
    uint256 public counter;
    event Ping(uint256 n);
    function ping(uint256 n) external payable {
        counter += n;
        emit Ping(n);
    }
}

contract BrainSmartAccountTest is Test {
    BrainSmartAccount internal acct;
    Target internal target;

    address internal ownerKey = address(0xA11CE);
    address internal holder = address(0xB0B);
    bytes32 internal constant TENANT = keccak256("tnt_x");
    bytes32 internal constant POLICY_VER = keccak256("pol-v1");

    function setUp() public {
        acct = new BrainSmartAccount(ownerKey, TENANT, address(0x1234));
        target = new Target();
        vm.deal(address(acct), 100 ether);
    }

    function _grantBasicKey(address t) internal {
        address[] memory targets = new address[](1);
        targets[0] = t;
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = Target.ping.selector;
        BrainSmartAccount.SessionKey memory key = BrainSmartAccount.SessionKey({
            holder: holder,
            validAfter: 0,
            validUntil: block.timestamp + 3600,
            allowedTargets: targets,
            allowedSelectors: selectors,
            maxPerTx: 1 ether,
            maxPerPeriod: 5 ether,
            periodSeconds: 86_400,
            policyVersion: POLICY_VER
        });
        vm.prank(ownerKey);
        acct.grantSessionKey(key);
    }

    function test_grant_onlyOwner() public {
        BrainSmartAccount.SessionKey memory key;
        key.holder = holder;
        key.validUntil = block.timestamp + 1;
        key.policyVersion = POLICY_VER;

        vm.expectRevert(BrainSmartAccount.NotOwner.selector);
        acct.grantSessionKey(key);
    }

    function test_execute_happyPath() public {
        _grantBasicKey(address(target));
        bytes memory data = abi.encodeCall(Target.ping, (1));
        vm.prank(holder);
        acct.executeViaSessionKey(address(target), 0.5 ether, data);
        assertEq(target.counter(), 1);
        assertEq(acct.spentInCurrentWindow(holder), 0.5 ether);
    }

    function test_execute_rejectsNonHolder() public {
        _grantBasicKey(address(target));
        bytes memory data = abi.encodeCall(Target.ping, (1));
        vm.expectRevert(BrainSmartAccount.NotHolder.selector);
        acct.executeViaSessionKey(address(target), 0, data);
    }

    function test_execute_rejectsTargetNotAllowed() public {
        _grantBasicKey(address(target));
        vm.prank(holder);
        vm.expectRevert(
            abi.encodeWithSelector(BrainSmartAccount.TargetNotAllowed.selector, address(0xDEAD))
        );
        acct.executeViaSessionKey(address(0xDEAD), 0, abi.encodeCall(Target.ping, (1)));
    }

    function test_execute_rejectsSelectorNotAllowed() public {
        _grantBasicKey(address(target));
        vm.prank(holder);
        vm.expectRevert(
            abi.encodeWithSelector(BrainSmartAccount.SelectorNotAllowed.selector, bytes4(0xdeadbeef))
        );
        acct.executeViaSessionKey(address(target), 0, hex"deadbeef");
    }

    function test_execute_rejectsPerTxOverCap() public {
        _grantBasicKey(address(target));
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.ExceedsPerTxCap.selector);
        acct.executeViaSessionKey(address(target), 2 ether, abi.encodeCall(Target.ping, (1)));
    }

    function test_execute_rejectsPerPeriodOverCap() public {
        _grantBasicKey(address(target));
        bytes memory data = abi.encodeCall(Target.ping, (1));
        vm.startPrank(holder);
        for (uint256 i = 0; i < 5; ++i) {
            acct.executeViaSessionKey(address(target), 1 ether, data);
        }
        vm.expectRevert(BrainSmartAccount.ExceedsPerPeriodCap.selector);
        acct.executeViaSessionKey(address(target), 1 ether, data);
        vm.stopPrank();
    }

    function test_revoke_disables() public {
        _grantBasicKey(address(target));
        vm.prank(ownerKey);
        acct.revokeSessionKey(holder);
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.NotHolder.selector);
        acct.executeViaSessionKey(address(target), 0, abi.encodeCall(Target.ping, (1)));
    }

    function test_execute_rejectsZeroPolicyVersion() public {
        BrainSmartAccount.SessionKey memory key;
        key.holder = holder;
        key.validAfter = 0;
        key.validUntil = block.timestamp + 3600;
        key.maxPerTx = 1 ether;
        key.maxPerPeriod = 1 ether;
        key.policyVersion = bytes32(0);
        key.periodSeconds = 0;

        vm.prank(ownerKey);
        acct.grantSessionKey(key);
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.PolicyVersionMismatch.selector);
        acct.executeViaSessionKey(address(target), 0, abi.encodeCall(Target.ping, (1)));
    }

    // --- Invariant-ish property: revoked key never executes -------------

    function test_invariant_revokedKeyCannotExecute() public {
        _grantBasicKey(address(target));
        vm.prank(ownerKey);
        acct.revokeSessionKey(holder);

        bytes memory data = abi.encodeCall(Target.ping, (1));
        for (uint256 i = 0; i < 5; ++i) {
            vm.prank(holder);
            vm.expectRevert(BrainSmartAccount.NotHolder.selector);
            acct.executeViaSessionKey(address(target), 0, data);
        }
    }

    // --- Fuzz: per-tx cap enforced for every value > cap ---------------

    function testFuzz_perTxCap(uint128 value) public {
        _grantBasicKey(address(target));
        if (value <= 1 ether) return; // inside cap — uninteresting
        bytes memory data = abi.encodeCall(Target.ping, (1));
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.ExceedsPerTxCap.selector);
        acct.executeViaSessionKey(address(target), value, data);
    }
}
