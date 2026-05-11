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

/// @dev Minimal ERC20 stub — only the three transfer-family selectors matter.
contract MockERC20 {
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public balanceOf;

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
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

    // --- ERC20 cap-bypass fix tests --------------------------------------

    function _grantERC20Key(address tokenTarget) internal {
        address[] memory targets = new address[](1);
        targets[0] = tokenTarget;
        // Allow transfer + transferFrom + approve selectors.
        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = 0xa9059cbb; // transfer(address,uint256)
        selectors[1] = 0x23b872dd; // transferFrom(address,address,uint256)
        selectors[2] = 0x095ea7b3; // approve(address,uint256)
        BrainSmartAccount.SessionKey memory key = BrainSmartAccount.SessionKey({
            holder: holder,
            validAfter: 0,
            validUntil: block.timestamp + 3600,
            allowedTargets: targets,
            allowedSelectors: selectors,
            maxPerTx: 100e18,
            maxPerPeriod: 500e18,
            periodSeconds: 86_400,
            policyVersion: POLICY_VER
        });
        vm.prank(ownerKey);
        acct.grantSessionKey(key);
    }

    function test_erc20_transfer_respectsPerTxCap() public {
        MockERC20 token = new MockERC20();
        token.mint(address(acct), 1_000e18);
        _grantERC20Key(address(token));

        // amount exactly at cap — should succeed.
        bytes memory data = abi.encodeCall(MockERC20.transfer, (address(0xBEEF), 100e18));
        vm.prank(holder);
        acct.executeViaSessionKey(address(token), 0, data);

        // amount one unit over cap — must revert.
        data = abi.encodeCall(MockERC20.transfer, (address(0xBEEF), 100e18 + 1));
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.ExceedsPerTxCap.selector);
        acct.executeViaSessionKey(address(token), 0, data);
    }

    function test_erc20_transferFrom_respectsPerTxCap() public {
        address alice = address(0xA11CE2);
        MockERC20 token = new MockERC20();
        token.mint(alice, 1_000e18);
        vm.prank(alice);
        token.approve(address(acct), type(uint256).max);
        _grantERC20Key(address(token));

        // amount over cap with value=0 — pre-fix this would have passed.
        bytes memory data = abi.encodeCall(MockERC20.transferFrom, (alice, address(0xBEEF), 101e18));
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.ExceedsPerTxCap.selector);
        acct.executeViaSessionKey(address(token), 0, data);
    }

    function test_erc20_approve_respectsPerTxCap() public {
        MockERC20 token = new MockERC20();
        _grantERC20Key(address(token));

        bytes memory data = abi.encodeCall(MockERC20.approve, (address(0xBEEF), 1e30));
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.ExceedsPerTxCap.selector);
        acct.executeViaSessionKey(address(token), 0, data);
    }

    function test_erc20_transfer_respectsPerPeriodCap() public {
        MockERC20 token = new MockERC20();
        token.mint(address(acct), 1_000e18);
        _grantERC20Key(address(token));

        // 5 × 100e18 = 500e18 exactly at period cap.
        bytes memory data = abi.encodeCall(MockERC20.transfer, (address(0xBEEF), 100e18));
        vm.startPrank(holder);
        for (uint256 i = 0; i < 5; ++i) {
            acct.executeViaSessionKey(address(token), 0, data);
        }
        // 6th call breaches period cap.
        vm.expectRevert(BrainSmartAccount.ExceedsPerPeriodCap.selector);
        acct.executeViaSessionKey(address(token), 0, data);
        vm.stopPrank();
    }

    function testFuzz_erc20CapBypass(uint128 tokenAmt) public {
        if (tokenAmt <= 100e18) return;
        MockERC20 token = new MockERC20();
        token.mint(address(acct), type(uint256).max);
        _grantERC20Key(address(token));

        bytes memory data = abi.encodeCall(MockERC20.transfer, (address(0xBEEF), tokenAmt));
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.ExceedsPerTxCap.selector);
        acct.executeViaSessionKey(address(token), 0, data);
    }
}
