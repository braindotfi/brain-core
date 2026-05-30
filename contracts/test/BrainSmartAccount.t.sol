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

/// @dev USDC stub: 6-decimal token to prove R-06 caps enforce in native units.
contract MockUSDC {
    mapping(address => uint256) public balanceOf;

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    /// @dev Non-standard selector used to prove R-07 rejects non-decodable
    ///      selectors at grant time when capToken is set.
    function donateToCharity(uint256 amount) external {
        balanceOf[address(0xDEAD)] += amount;
        balanceOf[msg.sender] -= amount;
    }
}

/// @dev H-03 re-entrancy probe. Acts as both holder AND target: when the account
///      calls back into `reenter()`, this contract tries to re-enter
///      executeViaSessionKey as itself (msg.sender == holder), which must be
///      blocked by the per-holder _locked guard (ReentrantCall).
contract ReentrantHolder {
    BrainSmartAccount public acct;
    bool public didReenter;
    bytes4 public caughtSelector;

    function setAcct(BrainSmartAccount a) external {
        acct = a;
    }

    function reenter() external payable {
        // The account is mid-execution for this holder, so _locked[this] is set.
        // Re-entering as ourselves must revert with ReentrantCall.
        try acct.executeViaSessionKey(0, address(this), 0, abi.encodeWithSelector(this.reenter.selector)) {
            didReenter = true;
        } catch (bytes memory err) {
            if (err.length >= 4) {
                caughtSelector = bytes4(err);
            }
        }
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
            capToken: address(0),
            maxPerTx: 1 ether,
            maxPerPeriod: 5 ether,
            periodSeconds: 86_400,
            policyVersion: POLICY_VER
        });
        vm.prank(ownerKey);
        acct.grantSessionKey(key);
    }

    // --- grant authorization + validation (H-03) -------------------------

    function test_grant_onlyOwner() public {
        address[] memory targets = new address[](1);
        targets[0] = address(target);
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = Target.ping.selector;
        BrainSmartAccount.SessionKey memory key = BrainSmartAccount.SessionKey({
            holder: holder,
            validAfter: 0,
            validUntil: block.timestamp + 1,
            allowedTargets: targets,
            allowedSelectors: selectors,
            capToken: address(0),
            maxPerTx: 1 ether,
            maxPerPeriod: 1 ether,
            periodSeconds: 0,
            policyVersion: POLICY_VER
        });

        vm.expectRevert(BrainSmartAccount.NotOwner.selector);
        acct.grantSessionKey(key);
    }

    /// H-03: an empty target allowlist was a "permit anything" footgun.
    function test_grant_rejectsEmptyTargets() public {
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = Target.ping.selector;
        BrainSmartAccount.SessionKey memory key;
        key.holder = holder;
        key.validUntil = block.timestamp + 3600;
        key.allowedSelectors = selectors;
        key.policyVersion = POLICY_VER;

        vm.prank(ownerKey);
        vm.expectRevert(BrainSmartAccount.TargetsRequired.selector);
        acct.grantSessionKey(key);
    }

    /// H-03: an empty selector allowlist was a "permit anything" footgun.
    function test_grant_rejectsEmptySelectors() public {
        address[] memory targets = new address[](1);
        targets[0] = address(target);
        BrainSmartAccount.SessionKey memory key;
        key.holder = holder;
        key.validUntil = block.timestamp + 3600;
        key.allowedTargets = targets;
        key.policyVersion = POLICY_VER;

        vm.prank(ownerKey);
        vm.expectRevert(BrainSmartAccount.SelectorsRequired.selector);
        acct.grantSessionKey(key);
    }

    /// H-03: zero policyVersion is now rejected at GRANT (moved out of execute).
    function test_grant_rejectsZeroPolicyVersion() public {
        address[] memory targets = new address[](1);
        targets[0] = address(target);
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = Target.ping.selector;
        BrainSmartAccount.SessionKey memory key = BrainSmartAccount.SessionKey({
            holder: holder,
            validAfter: 0,
            validUntil: block.timestamp + 3600,
            allowedTargets: targets,
            allowedSelectors: selectors,
            capToken: address(0),
            maxPerTx: 1 ether,
            maxPerPeriod: 1 ether,
            periodSeconds: 0,
            policyVersion: bytes32(0)
        });

        vm.prank(ownerKey);
        vm.expectRevert(BrainSmartAccount.PolicyVersionMismatch.selector);
        acct.grantSessionKey(key);
    }

    // --- execute happy path + scope enforcement --------------------------

    function test_execute_happyPath() public {
        _grantBasicKey(address(target));
        bytes memory data = abi.encodeCall(Target.ping, (1));
        vm.prank(holder);
        acct.executeViaSessionKey(0, address(target), 0.5 ether, data);
        assertEq(target.counter(), 1);
        assertEq(acct.spentInCurrentWindow(holder), 0.5 ether);
    }

    function test_execute_rejectsNonHolder() public {
        _grantBasicKey(address(target));
        bytes memory data = abi.encodeCall(Target.ping, (1));
        vm.expectRevert(BrainSmartAccount.NotHolder.selector);
        acct.executeViaSessionKey(0, address(target), 0, data);
    }

    function test_execute_rejectsTargetNotAllowed() public {
        _grantBasicKey(address(target));
        vm.prank(holder);
        vm.expectRevert(
            abi.encodeWithSelector(BrainSmartAccount.TargetNotAllowed.selector, address(0xDEAD))
        );
        acct.executeViaSessionKey(0, address(0xDEAD), 0, abi.encodeCall(Target.ping, (1)));
    }

    function test_execute_rejectsSelectorNotAllowed() public {
        _grantBasicKey(address(target));
        vm.prank(holder);
        vm.expectRevert(
            abi.encodeWithSelector(BrainSmartAccount.SelectorNotAllowed.selector, bytes4(0xdeadbeef))
        );
        acct.executeViaSessionKey(0, address(target), 0, hex"deadbeef");
    }

    function test_execute_rejectsPerTxOverCap() public {
        _grantBasicKey(address(target));
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.ExceedsPerTxCap.selector);
        acct.executeViaSessionKey(0, address(target), 2 ether, abi.encodeCall(Target.ping, (1)));
    }

    function test_execute_rejectsPerPeriodOverCap() public {
        _grantBasicKey(address(target));
        bytes memory data = abi.encodeCall(Target.ping, (1));
        vm.startPrank(holder);
        for (uint256 i = 0; i < 5; ++i) {
            acct.executeViaSessionKey(i, address(target), 1 ether, data);
        }
        vm.expectRevert(BrainSmartAccount.ExceedsPerPeriodCap.selector);
        acct.executeViaSessionKey(5, address(target), 1 ether, data);
        vm.stopPrank();
    }

    function test_revoke_disables() public {
        _grantBasicKey(address(target));
        vm.prank(ownerKey);
        acct.revokeSessionKey(holder);
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.NotHolder.selector);
        acct.executeViaSessionKey(0, address(target), 0, abi.encodeCall(Target.ping, (1)));
    }

    // --- H-03 replay nonce -----------------------------------------------

    function test_nonce_startsAtZero() public {
        _grantBasicKey(address(target));
        assertEq(acct.nonce(holder), 0);
    }

    function test_nonce_incrementsOnAcceptedExecute() public {
        _grantBasicKey(address(target));
        bytes memory data = abi.encodeCall(Target.ping, (1));
        vm.prank(holder);
        acct.executeViaSessionKey(0, address(target), 0.5 ether, data);
        assertEq(acct.nonce(holder), 1);
        vm.prank(holder);
        acct.executeViaSessionKey(1, address(target), 0.5 ether, data);
        assertEq(acct.nonce(holder), 2);
    }

    /// Replaying an already-consumed nonce must revert (anti-replay).
    function test_execute_replayRevertsWithStaleNonce() public {
        _grantBasicKey(address(target));
        bytes memory data = abi.encodeCall(Target.ping, (1));
        vm.prank(holder);
        acct.executeViaSessionKey(0, address(target), 0.5 ether, data);
        // Nonce is now 1; replaying 0 must fail.
        vm.prank(holder);
        vm.expectRevert(abi.encodeWithSelector(BrainSmartAccount.BadNonce.selector, uint256(1), uint256(0)));
        acct.executeViaSessionKey(0, address(target), 0.5 ether, data);
    }

    /// A future / skipped nonce must also revert — only the exact current value.
    function test_execute_rejectsFutureNonce() public {
        _grantBasicKey(address(target));
        vm.prank(holder);
        vm.expectRevert(abi.encodeWithSelector(BrainSmartAccount.BadNonce.selector, uint256(0), uint256(7)));
        acct.executeViaSessionKey(7, address(target), 0.5 ether, abi.encodeCall(Target.ping, (1)));
    }

    /// A reverted execute must NOT consume the nonce (state is rolled back).
    function test_execute_revertDoesNotConsumeNonce() public {
        _grantBasicKey(address(target));
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.ExceedsPerTxCap.selector);
        acct.executeViaSessionKey(0, address(target), 2 ether, abi.encodeCall(Target.ping, (1)));
        // Nonce unchanged; the same nonce now works for a valid call.
        assertEq(acct.nonce(holder), 0);
        vm.prank(holder);
        acct.executeViaSessionKey(0, address(target), 0.5 ether, abi.encodeCall(Target.ping, (1)));
        assertEq(acct.nonce(holder), 1);
    }

    // --- H-03 re-entrancy guard ------------------------------------------

    function test_execute_blocksReentrancy() public {
        ReentrantHolder rh = new ReentrantHolder();
        rh.setAcct(acct);
        address rhAddr = address(rh);
        vm.deal(address(acct), 100 ether);

        address[] memory targets = new address[](1);
        targets[0] = rhAddr;
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = ReentrantHolder.reenter.selector;
        BrainSmartAccount.SessionKey memory key = BrainSmartAccount.SessionKey({
            holder: rhAddr,
            validAfter: 0,
            validUntil: block.timestamp + 3600,
            allowedTargets: targets,
            allowedSelectors: selectors,
            capToken: address(0),
            maxPerTx: 1 ether,
            maxPerPeriod: 5 ether,
            periodSeconds: 86_400,
            policyVersion: POLICY_VER
        });
        vm.prank(ownerKey);
        acct.grantSessionKey(key);

        // Outer call succeeds; the inner re-entry is caught and rejected.
        vm.prank(rhAddr);
        acct.executeViaSessionKey(0, rhAddr, 0, abi.encodeWithSelector(ReentrantHolder.reenter.selector));

        assertFalse(rh.didReenter());
        assertEq(rh.caughtSelector(), BrainSmartAccount.ReentrantCall.selector);
        // Outer call still consumed exactly one nonce.
        assertEq(acct.nonce(rhAddr), 1);
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
            acct.executeViaSessionKey(0, address(target), 0, data);
        }
    }

    // --- Fuzz: per-tx cap enforced for every value > cap ---------------

    function testFuzz_perTxCap(uint128 value) public {
        _grantBasicKey(address(target));
        if (value <= 1 ether) return; // inside cap — uninteresting
        bytes memory data = abi.encodeCall(Target.ping, (1));
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.ExceedsPerTxCap.selector);
        acct.executeViaSessionKey(0, address(target), value, data);
    }

    // --- Fuzz: nonce is monotonic and gap-free across accepted executes ---

    function testFuzz_nonceMonotonic(uint8 raw) public {
        _grantBasicKey(address(target));
        uint256 calls = uint256(raw) % 6; // ≤5 × 0.5 ether stays within the 5-ether period cap
        bytes memory data = abi.encodeCall(Target.ping, (1));
        vm.startPrank(holder);
        for (uint256 i = 0; i < calls; ++i) {
            assertEq(acct.nonce(holder), i);
            acct.executeViaSessionKey(i, address(target), 0.5 ether, data);
            assertEq(acct.nonce(holder), i + 1);
        }
        vm.stopPrank();
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
            // R-06: ERC20 mode binds caps to this token's raw units (here 18dp).
            capToken: tokenTarget,
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
        acct.executeViaSessionKey(0, address(token), 0, data);

        // amount one unit over cap — must revert.
        data = abi.encodeCall(MockERC20.transfer, (address(0xBEEF), 100e18 + 1));
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.ExceedsPerTxCap.selector);
        acct.executeViaSessionKey(1, address(token), 0, data);
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
        acct.executeViaSessionKey(0, address(token), 0, data);
    }

    function test_erc20_approve_respectsPerTxCap() public {
        MockERC20 token = new MockERC20();
        _grantERC20Key(address(token));

        bytes memory data = abi.encodeCall(MockERC20.approve, (address(0xBEEF), 1e30));
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.ExceedsPerTxCap.selector);
        acct.executeViaSessionKey(0, address(token), 0, data);
    }

    function test_erc20_transfer_respectsPerPeriodCap() public {
        MockERC20 token = new MockERC20();
        token.mint(address(acct), 1_000e18);
        _grantERC20Key(address(token));

        // 5 × 100e18 = 500e18 exactly at period cap.
        bytes memory data = abi.encodeCall(MockERC20.transfer, (address(0xBEEF), 100e18));
        vm.startPrank(holder);
        for (uint256 i = 0; i < 5; ++i) {
            acct.executeViaSessionKey(i, address(token), 0, data);
        }
        // 6th call breaches period cap.
        vm.expectRevert(BrainSmartAccount.ExceedsPerPeriodCap.selector);
        acct.executeViaSessionKey(5, address(token), 0, data);
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
        acct.executeViaSessionKey(0, address(token), 0, data);
    }

    // --- Kill-switch: pauseSessionKey vs revokeSessionKey (1b.3) ---------------

    function test_pause_onlyOwner() public {
        _grantBasicKey(address(target));
        vm.expectRevert(BrainSmartAccount.NotOwner.selector);
        acct.pauseSessionKey(holder);
    }

    function test_pause_blocksExecution() public {
        _grantBasicKey(address(target));
        vm.prank(ownerKey);
        acct.pauseSessionKey(holder);
        assertTrue(acct.isSessionKeyPaused(holder));

        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.KeyPaused.selector);
        acct.executeViaSessionKey(0, address(target), 0.5 ether, abi.encodeCall(Target.ping, (1)));
    }

    function test_pause_preservesKeyRecordLimitsAndWindowSpend() public {
        _grantBasicKey(address(target));
        // Spend 0.5 ether, then pause.
        vm.prank(holder);
        acct.executeViaSessionKey(0, address(target), 0.5 ether, abi.encodeCall(Target.ping, (1)));
        assertEq(acct.spentInCurrentWindow(holder), 0.5 ether);

        vm.prank(ownerKey);
        acct.pauseSessionKey(holder);

        // The key record, its limits, and the accumulated window spend survive.
        BrainSmartAccount.SessionKey memory key = acct.sessionKey(holder);
        assertEq(key.holder, holder);
        assertEq(key.maxPerTx, 1 ether);
        assertEq(acct.spentInCurrentWindow(holder), 0.5 ether);

        // Resume → execution works again, spend keeps accumulating (no reset).
        vm.prank(ownerKey);
        acct.unpauseSessionKey(holder);
        assertFalse(acct.isSessionKeyPaused(holder));

        // Nonce also survived the pause/resume (it is part of the key record's lifecycle).
        vm.prank(holder);
        acct.executeViaSessionKey(1, address(target), 0.5 ether, abi.encodeCall(Target.ping, (2)));
        assertEq(target.counter(), 3);
        assertEq(acct.spentInCurrentWindow(holder), 1 ether);
    }

    function test_revoke_isPermanentRemoval() public {
        _grantBasicKey(address(target));
        vm.prank(ownerKey);
        acct.revokeSessionKey(holder);
        // Record deleted entirely (distinct from pause).
        assertEq(acct.sessionKey(holder).holder, address(0));
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.NotHolder.selector);
        acct.executeViaSessionKey(0, address(target), 0.5 ether, abi.encodeCall(Target.ping, (1)));
    }

    // --- Per-task minimum-privilege session key (3.3) -------------------------

    function _grantPerTaskKey(address t, uint256 amount) internal {
        // exact target, exact selector, exact amount (per-tx == per-period), ~10m window.
        address[] memory targets = new address[](1);
        targets[0] = t;
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = Target.ping.selector;
        BrainSmartAccount.SessionKey memory key = BrainSmartAccount.SessionKey({
            holder: holder,
            validAfter: 0,
            validUntil: block.timestamp + 600,
            allowedTargets: targets,
            allowedSelectors: selectors,
            capToken: address(0),
            maxPerTx: amount,
            maxPerPeriod: amount,
            periodSeconds: 600,
            policyVersion: POLICY_VER
        });
        vm.prank(ownerKey);
        acct.grantSessionKey(key);
    }

    function test_perTaskKey_allowsExactlyOneTransferThenExhausts() public {
        _grantPerTaskKey(address(target), 1 ether);
        bytes memory data = abi.encodeCall(Target.ping, (1));

        // First transfer of the exact amount succeeds.
        vm.prank(holder);
        acct.executeViaSessionKey(0, address(target), 1 ether, data);

        // A second transfer exhausts the one-time per-period budget.
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.ExceedsPerPeriodCap.selector);
        acct.executeViaSessionKey(1, address(target), 1 ether, data);
    }

    function test_perTaskKey_rejectsOverAmountAndExpiry() public {
        _grantPerTaskKey(address(target), 1 ether);
        bytes memory data = abi.encodeCall(Target.ping, (1));

        // Over the exact amount → per-tx cap.
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.ExceedsPerTxCap.selector);
        acct.executeViaSessionKey(0, address(target), 2 ether, data);

        // After the ~10m window → not active.
        vm.warp(block.timestamp + 601);
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.KeyNotActive.selector);
        acct.executeViaSessionKey(0, address(target), 1 ether, data);
    }

    // --- Two-step ownership (item 8 / Ownable2Step) --------------------------

    function _grantKeyFor(address h, address t) internal {
        address[] memory targets = new address[](1);
        targets[0] = t;
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = Target.ping.selector;
        BrainSmartAccount.SessionKey memory key = BrainSmartAccount.SessionKey({
            holder: h,
            validAfter: 0,
            validUntil: block.timestamp + 3600,
            allowedTargets: targets,
            allowedSelectors: selectors,
            capToken: address(0),
            maxPerTx: 1 ether,
            maxPerPeriod: 5 ether,
            periodSeconds: 86_400,
            policyVersion: POLICY_VER
        });
        vm.prank(ownerKey);
        acct.grantSessionKey(key);
    }

    function test_transferOwnership_isTwoStep() public {
        address newOwner = address(0xC0FFEE);
        vm.prank(ownerKey);
        acct.transferOwnership(newOwner);
        // Ownership does NOT move until the pending owner accepts.
        assertEq(acct.owner(), ownerKey);
        assertEq(acct.pendingOwner(), newOwner);

        vm.prank(newOwner);
        acct.acceptOwnership();
        assertEq(acct.owner(), newOwner);
        assertEq(acct.pendingOwner(), address(0));
    }

    function test_transferOwnership_onlyOwner() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert(BrainSmartAccount.NotOwner.selector);
        acct.transferOwnership(address(0xC0FFEE));
    }

    function test_acceptOwnership_onlyPendingOwner() public {
        address newOwner = address(0xC0FFEE);
        vm.prank(ownerKey);
        acct.transferOwnership(newOwner);
        // A non-pending address cannot accept.
        vm.prank(address(0xDEAD));
        vm.expectRevert(BrainSmartAccount.NotPendingOwner.selector);
        acct.acceptOwnership();
        assertEq(acct.owner(), ownerKey);
    }

    function test_transferOwnership_cancel() public {
        address newOwner = address(0xC0FFEE);
        vm.prank(ownerKey);
        acct.transferOwnership(newOwner);
        // Cancel by proposing the zero address.
        vm.prank(ownerKey);
        acct.transferOwnership(address(0));
        assertEq(acct.pendingOwner(), address(0));
        // The previously-pending owner can no longer accept.
        vm.prank(newOwner);
        vm.expectRevert(BrainSmartAccount.NotPendingOwner.selector);
        acct.acceptOwnership();
        assertEq(acct.owner(), ownerKey);
    }

    function test_acceptOwnership_transfersOwnerPowers() public {
        address newOwner = address(0xC0FFEE);
        vm.prank(ownerKey);
        acct.transferOwnership(newOwner);
        vm.prank(newOwner);
        acct.acceptOwnership();

        // Old owner is locked out of owner-only functions; new owner is in.
        vm.prank(ownerKey);
        vm.expectRevert(BrainSmartAccount.NotOwner.selector);
        acct.pauseSessionKey(holder);

        vm.prank(newOwner);
        acct.pauseSessionKey(holder);
        assertTrue(acct.isSessionKeyPaused(holder));
    }

    // --- Account-wide kill-switch (item 10) ----------------------------------

    function test_pauseAll_onlyOwner() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert(BrainSmartAccount.NotOwner.selector);
        acct.pauseAll();
    }

    function test_pauseAll_blocksAllHoldersRegardlessOfPerHolderState() public {
        address holder2 = address(0xB0B2);
        _grantBasicKey(address(target)); // holder
        _grantKeyFor(holder2, address(target));
        assertFalse(acct.isAccountPaused());

        vm.prank(ownerKey);
        acct.pauseAll();
        assertTrue(acct.isAccountPaused());

        // Neither holder is individually paused, yet both are blocked.
        assertFalse(acct.isSessionKeyPaused(holder));
        assertFalse(acct.isSessionKeyPaused(holder2));
        bytes memory data = abi.encodeCall(Target.ping, (1));
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.AccountIsPaused.selector);
        acct.executeViaSessionKey(0, address(target), 0.5 ether, data);
        vm.prank(holder2);
        vm.expectRevert(BrainSmartAccount.AccountIsPaused.selector);
        acct.executeViaSessionKey(0, address(target), 0.5 ether, data);
    }

    function test_unpauseAll_restoresPriorPerHolderState() public {
        address holder2 = address(0xB0B2);
        _grantBasicKey(address(target)); // holder
        _grantKeyFor(holder2, address(target));

        // Individually pause holder (not holder2), then engage the account-wide pause.
        vm.prank(ownerKey);
        acct.pauseSessionKey(holder);
        vm.prank(ownerKey);
        acct.pauseAll();

        // Lift the account-wide pause.
        vm.prank(ownerKey);
        acct.unpauseAll();
        assertFalse(acct.isAccountPaused());

        bytes memory data = abi.encodeCall(Target.ping, (1));
        // holder was individually paused → still blocked with KeyPaused.
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.KeyPaused.selector);
        acct.executeViaSessionKey(0, address(target), 0.5 ether, data);
        // holder2 was never individually paused → executes again.
        vm.prank(holder2);
        acct.executeViaSessionKey(0, address(target), 0.5 ether, data);
        assertEq(target.counter(), 1);
    }

    // --- R-06 / R-07 (F-3 + F-4 from Opus 4.8): per-token caps + lockdown -----

    /// @dev Helper: grant an ERC20-mode key bound to `token`, single-selector.
    function _grantErc20ModeKey(address token, bytes4 sel, uint256 cap) internal {
        address[] memory targets = new address[](1);
        targets[0] = token;
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = sel;
        BrainSmartAccount.SessionKey memory key = BrainSmartAccount.SessionKey({
            holder: holder,
            validAfter: 0,
            validUntil: block.timestamp + 3600,
            allowedTargets: targets,
            allowedSelectors: selectors,
            capToken: token,
            maxPerTx: cap,
            maxPerPeriod: cap * 10,
            periodSeconds: 86_400,
            policyVersion: POLICY_VER
        });
        vm.prank(ownerKey);
        acct.grantSessionKey(key);
    }

    /// @dev R-06: caps denominated in USDC (6dp) enforce in USDC raw units.
    ///      A cap of 100 USDC (= 100_000_000 raw) admits a 100 USDC transfer
    ///      and rejects a 101 USDC transfer.
    function test_R06_usdc6dp_capEnforcesInTokenUnits() public {
        MockUSDC usdc = new MockUSDC();
        usdc.mint(address(acct), 1_000 * 1e6); // 1000 USDC
        _grantErc20ModeKey(address(usdc), 0xa9059cbb, 100 * 1e6); // 100 USDC

        // Exact-at-cap transfer succeeds.
        bytes memory ok = abi.encodeCall(MockUSDC.transfer, (address(0xBEEF), 100 * 1e6));
        vm.prank(holder);
        acct.executeViaSessionKey(0, address(usdc), 0, ok);
        assertEq(usdc.balanceOf(address(0xBEEF)), 100 * 1e6);

        // One USDC unit over cap reverts.
        bytes memory over = abi.encodeCall(MockUSDC.transfer, (address(0xBEEF), 100 * 1e6 + 1));
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.ExceedsPerTxCap.selector);
        acct.executeViaSessionKey(1, address(usdc), 0, over);
    }

    /// @dev R-06: caps denominated in an 18-decimal ERC20 enforce in those
    ///      units. Same test shape as USDC but with the existing MockERC20.
    function test_R06_dai18dp_capEnforcesInTokenUnits() public {
        MockERC20 dai = new MockERC20();
        dai.mint(address(acct), 1_000 ether);
        _grantErc20ModeKey(address(dai), 0xa9059cbb, 100 ether);

        bytes memory ok = abi.encodeCall(MockERC20.transfer, (address(0xBEEF), 100 ether));
        vm.prank(holder);
        acct.executeViaSessionKey(0, address(dai), 0, ok);

        bytes memory over = abi.encodeCall(MockERC20.transfer, (address(0xBEEF), 100 ether + 1));
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.ExceedsPerTxCap.selector);
        acct.executeViaSessionKey(1, address(dai), 0, over);
    }

    /// @dev R-07: grantSessionKey rejects a non-decodable selector when
    ///      capToken is set (ERC20 mode). The MockUSDC.donateToCharity
    ///      function is not one of {transfer, approve, transferFrom}.
    function test_R07_grant_rejectsNonDecodableSelectorInErc20Mode() public {
        MockUSDC usdc = new MockUSDC();
        address[] memory targets = new address[](1);
        targets[0] = address(usdc);
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = MockUSDC.donateToCharity.selector;
        BrainSmartAccount.SessionKey memory key = BrainSmartAccount.SessionKey({
            holder: holder,
            validAfter: 0,
            validUntil: block.timestamp + 3600,
            allowedTargets: targets,
            allowedSelectors: selectors,
            capToken: address(usdc),
            maxPerTx: 100 * 1e6,
            maxPerPeriod: 1_000 * 1e6,
            periodSeconds: 86_400,
            policyVersion: POLICY_VER
        });
        vm.prank(ownerKey);
        vm.expectRevert(
            abi.encodeWithSelector(
                BrainSmartAccount.NonDecodableSelectorInErc20Mode.selector,
                MockUSDC.donateToCharity.selector
            )
        );
        acct.grantSessionKey(key);
    }

    /// @dev R-07: grantSessionKey rejects allowedTargets that don't include
    ///      exactly the capToken in ERC20 mode. Prevents "session can call
    ///      USDC AND something else; caps only meter USDC" footgun.
    function test_R07_grant_rejectsTargetMismatchInErc20Mode() public {
        MockUSDC usdc = new MockUSDC();
        // allowedTargets includes USDC + some other contract.
        address[] memory targets = new address[](2);
        targets[0] = address(usdc);
        targets[1] = address(target);
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = 0xa9059cbb;
        BrainSmartAccount.SessionKey memory key = BrainSmartAccount.SessionKey({
            holder: holder,
            validAfter: 0,
            validUntil: block.timestamp + 3600,
            allowedTargets: targets,
            allowedSelectors: selectors,
            capToken: address(usdc),
            maxPerTx: 100 * 1e6,
            maxPerPeriod: 1_000 * 1e6,
            periodSeconds: 86_400,
            policyVersion: POLICY_VER
        });
        vm.prank(ownerKey);
        vm.expectRevert(BrainSmartAccount.CapTokenAllowlistMismatch.selector);
        acct.grantSessionKey(key);
    }

    /// @dev R-06: executeViaSessionKey rejects value > 0 in ERC20 mode.
    ///      An agent can't sneak ETH alongside a token call.
    function test_R06_execute_rejectsValueInErc20Mode() public {
        MockERC20 dai = new MockERC20();
        dai.mint(address(acct), 1_000 ether);
        _grantErc20ModeKey(address(dai), 0xa9059cbb, 100 ether);

        bytes memory data = abi.encodeCall(MockERC20.transfer, (address(0xBEEF), 10 ether));
        vm.deal(address(acct), 1 ether);
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.ValueNotAllowedInErc20Mode.selector);
        acct.executeViaSessionKey(0, address(dai), 1 wei, data);
    }

    /// @dev R-06: executeViaSessionKey rejects target != capToken in ERC20
    ///      mode. Belt-and-braces against the target allowlist being widened
    ///      through some future bug.
    function test_R06_execute_rejectsWrongTargetInErc20Mode() public {
        MockERC20 dai = new MockERC20();
        MockERC20 other = new MockERC20();
        dai.mint(address(acct), 1_000 ether);
        _grantErc20ModeKey(address(dai), 0xa9059cbb, 100 ether);

        // grantSessionKey would already reject if allowedTargets included
        // `other`, so this scenario is reachable only via storage mutation
        // (which is impossible from the holder). The defense is here in
        // executeViaSessionKey anyway as a belt to the brace. We exercise
        // it by calling the right selector but at the wrong target — the
        // target allowlist rejects first, but the test documents the order.
        bytes memory data = abi.encodeCall(MockERC20.transfer, (address(0xBEEF), 10 ether));
        vm.prank(holder);
        vm.expectRevert(abi.encodeWithSelector(BrainSmartAccount.TargetNotAllowed.selector, address(other)));
        acct.executeViaSessionKey(0, address(other), 0, data);
    }

    /// @dev R-06 / R-07 closure proof: in native mode (capToken=0) the
    ///      existing target/selector allowlist plus per-tx ETH cap apply.
    ///      A value-bearing call respects the cap as before; a value=0
    ///      call to a non-token target passes un-metered, by design (
    ///      documented in the NatSpec).
    function test_nativeMode_capAppliesToValue() public {
        _grantBasicKey(address(target));
        // Within cap.
        vm.prank(holder);
        acct.executeViaSessionKey(0, address(target), 1 ether, abi.encodeCall(Target.ping, (1)));
        // Over cap.
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.ExceedsPerTxCap.selector);
        acct.executeViaSessionKey(1, address(target), 1.1 ether, abi.encodeCall(Target.ping, (1)));
    }
}
