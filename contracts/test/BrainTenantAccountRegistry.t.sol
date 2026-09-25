// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {BrainSmartAccount} from "../src/BrainSmartAccount.sol";
import {BrainTenantAccountRegistry} from "../src/BrainTenantAccountRegistry.sol";
import {StubPolicyRegistry} from "./BrainSmartAccount.t.sol";

contract BrainTenantAccountRegistryTest is Test {
    BrainTenantAccountRegistry internal registry;
    StubPolicyRegistry internal policy;

    address internal owner = address(0xA11CE);
    address internal other = address(0xB0B);
    bytes32 internal constant TENANT = keccak256("tenant-a");
    bytes32 internal constant OTHER_TENANT = keccak256("tenant-b");
    bytes32 internal constant POLICY = keccak256("policy");

    function setUp() public {
        registry = new BrainTenantAccountRegistry(owner);
        policy = new StubPolicyRegistry();
        policy.setRegistered(TENANT, POLICY, true);
        policy.setRegistered(OTHER_TENANT, POLICY, true);
    }

    function _emptyInitialKeys() private pure returns (BrainSmartAccount.SessionKey[] memory keys) {
        keys = new BrainSmartAccount.SessionKey[](0);
    }

    function _account(bytes32 tenant) private returns (BrainSmartAccount) {
        return new BrainSmartAccount(owner, tenant, address(policy), _emptyInitialKeys());
    }

    function test_firstAssignmentIsInstant() public {
        BrainSmartAccount account = _account(TENANT);

        vm.prank(owner);
        registry.assignAccount(TENANT, address(account));

        assertEq(registry.accountOf(TENANT), address(account));
        (,, bool exists) = registry.pendingAccountChange(TENANT);
        assertFalse(exists);
    }

    function test_replacementWaitsAndActivatesAfterDelay() public {
        BrainSmartAccount accountA = _account(TENANT);
        BrainSmartAccount accountB = _account(TENANT);
        vm.startPrank(owner);
        registry.assignAccount(TENANT, address(accountA));
        registry.assignAccount(TENANT, address(accountB));
        vm.stopPrank();

        assertEq(registry.accountOf(TENANT), address(accountA));
        (address pending, uint256 executableAt, bool exists) = registry.pendingAccountChange(TENANT);
        assertTrue(exists);
        assertEq(pending, address(accountB));

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                BrainTenantAccountRegistry.PendingAccountChangeNotReady.selector, TENANT, executableAt
            )
        );
        registry.activatePendingAccountChange(TENANT);

        vm.warp(executableAt);
        vm.prank(owner);
        registry.activatePendingAccountChange(TENANT);
        assertEq(registry.accountOf(TENANT), address(accountB));

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(BrainTenantAccountRegistry.NoPendingAccountChange.selector, TENANT));
        registry.activatePendingAccountChange(TENANT);
    }

    function test_ownerCannotSkipReplacementDelay() public {
        BrainSmartAccount accountA = _account(TENANT);
        BrainSmartAccount accountB = _account(TENANT);
        vm.startPrank(owner);
        registry.assignAccount(TENANT, address(accountA));
        registry.assignAccount(TENANT, address(accountB));
        vm.expectRevert();
        registry.activatePendingAccountChange(TENANT);
        vm.stopPrank();

        assertEq(registry.accountOf(TENANT), address(accountA));
    }

    function test_cancelPendingReplacement() public {
        BrainSmartAccount accountA = _account(TENANT);
        BrainSmartAccount accountB = _account(TENANT);
        vm.startPrank(owner);
        registry.assignAccount(TENANT, address(accountA));
        registry.assignAccount(TENANT, address(accountB));
        registry.cancelPendingAccountChange(TENANT);
        vm.stopPrank();

        assertEq(registry.accountOf(TENANT), address(accountA));
        (,, bool exists) = registry.pendingAccountChange(TENANT);
        assertFalse(exists);
    }

    function test_rejectsAccountTenantMismatch() public {
        BrainSmartAccount account = _account(OTHER_TENANT);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(BrainTenantAccountRegistry.AccountTenantMismatch.selector, TENANT, OTHER_TENANT)
        );
        registry.assignAccount(TENANT, address(account));
    }

    function test_onlyOwnerCanAssignCancelAndActivate() public {
        BrainSmartAccount accountA = _account(TENANT);
        BrainSmartAccount accountB = _account(TENANT);

        vm.prank(other);
        vm.expectRevert(BrainTenantAccountRegistry.NotOwner.selector);
        registry.assignAccount(TENANT, address(accountA));

        vm.startPrank(owner);
        registry.assignAccount(TENANT, address(accountA));
        registry.assignAccount(TENANT, address(accountB));
        vm.stopPrank();

        vm.prank(other);
        vm.expectRevert(BrainTenantAccountRegistry.NotOwner.selector);
        registry.cancelPendingAccountChange(TENANT);

        vm.warp(block.timestamp + registry.ACCOUNT_CHANGE_DELAY());
        vm.prank(other);
        vm.expectRevert(BrainTenantAccountRegistry.NotOwner.selector);
        registry.activatePendingAccountChange(TENANT);
    }
}
