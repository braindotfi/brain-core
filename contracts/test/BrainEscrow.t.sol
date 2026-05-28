// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {BrainEscrow} from "../src/BrainEscrow.sol";
import {IBrainEscrow} from "../src/IBrainEscrow.sol";

/// @dev Minimal standard ERC-20 (returns bool true) for exercising the escrow.
contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

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
}

/// @dev Malicious token that reenters escrow.release() during a transfer, to
///      prove the nonReentrant guard holds. The reentrant call is wrapped in
///      try/catch so we can assert it reverted while the outer release settles.
contract ReentrantToken {
    BrainEscrow public escrow;
    bytes32 public targetId;
    bool public reentryReverted;
    bool internal attacking;
    mapping(address => uint256) public balanceOf;

    function setTarget(BrainEscrow _escrow, bytes32 _id) external {
        escrow = _escrow;
        targetId = _id;
    }

    function transferFrom(address, address to, uint256 amount) external returns (bool) {
        // Credit the escrow so the lock()'s balance-delta guard sees real funds.
        balanceOf[to] += amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (!attacking) {
            attacking = true;
            try escrow.release(targetId, 1) {
                // unreachable — the guard must revert the reentrant call
            } catch {
                reentryReverted = true;
            }
        }
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev ERC-20 that skims a 1% fee on every transfer/transferFrom (the skimmed
///      amount is burned). Models a fee-on-transfer token to prove the escrow
///      records what it actually RECEIVED, not the nominal amount requested.
contract FeeOnTransferToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public constant FEE_BPS = 100; // 1%

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        uint256 fee = (amount * FEE_BPS) / 10_000;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee; // fee disappears (skim)
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        return true;
    }
}

/// @dev Malicious token whose transferFrom reports success but moves nothing —
///      proves the escrow rejects a lock that received zero.
contract NoOpToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return true;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return true; // claims success, transfers nothing
    }
}

contract BrainEscrowTest is Test {
    BrainEscrow internal escrow;
    MockERC20 internal token;

    address internal arbiter = address(0xA12B17E2);
    address internal payer = address(0xF00D);
    address internal payee = address(0xBEEF);

    bytes32 internal constant ID = keccak256("escrow-1");
    bytes32 internal constant TERMS = keccak256("job-terms");
    uint256 internal constant AMOUNT = 1_000e6; // 1000 USDC (6 decimals)
    uint64 internal deadline;

    function setUp() public {
        escrow = new BrainEscrow(arbiter);
        token = new MockERC20();
        deadline = uint64(block.timestamp + 1 days);

        token.mint(payer, AMOUNT);
        vm.prank(payer);
        token.approve(address(escrow), AMOUNT);
    }

    function _lock() internal {
        vm.prank(payer);
        escrow.lock(ID, payee, address(token), AMOUNT, TERMS, deadline);
    }

    function _remaining(bytes32 id) internal view returns (uint256) {
        (,,, uint256 amount, uint256 released, uint256 refunded,,,) = escrow.getEscrow(id);
        return amount - released - refunded;
    }

    function _state(bytes32 id) internal view returns (IBrainEscrow.State s) {
        (,,,,,,,, s) = escrow.getEscrow(id);
    }

    // --- constructor ---------------------------------------------------------

    function test_constructor_setsArbiter() public view {
        assertEq(escrow.arbiter(), arbiter);
    }

    function test_constructor_rejectsZeroArbiter() public {
        vm.expectRevert(IBrainEscrow.ZeroAddress.selector);
        new BrainEscrow(address(0));
    }

    // --- lock ----------------------------------------------------------------

    function test_lock_movesFundsAndRecordsState() public {
        vm.expectEmit(true, true, true, true, address(escrow));
        emit IBrainEscrow.EscrowLocked(ID, payer, payee, address(token), AMOUNT, TERMS, deadline);
        _lock();

        assertEq(token.balanceOf(address(escrow)), AMOUNT);
        assertEq(token.balanceOf(payer), 0);
        (address p, address pe, address t, uint256 a, uint256 rel, uint256 ref, bytes32 h, uint64 d, IBrainEscrow.State s)
        = escrow.getEscrow(ID);
        assertEq(p, payer);
        assertEq(pe, payee);
        assertEq(t, address(token));
        assertEq(a, AMOUNT);
        assertEq(rel, 0);
        assertEq(ref, 0);
        assertEq(h, TERMS);
        assertEq(d, deadline);
        assertTrue(s == IBrainEscrow.State.Locked);
    }

    function test_lock_rejectsDuplicateId() public {
        _lock();
        token.mint(payer, AMOUNT);
        vm.startPrank(payer);
        token.approve(address(escrow), AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(IBrainEscrow.EscrowExists.selector, ID));
        escrow.lock(ID, payee, address(token), AMOUNT, TERMS, deadline);
        vm.stopPrank();
    }

    function test_lock_rejectsZeroPayee() public {
        vm.prank(payer);
        vm.expectRevert(IBrainEscrow.ZeroAddress.selector);
        escrow.lock(ID, address(0), address(token), AMOUNT, TERMS, deadline);
    }

    function test_lock_rejectsZeroAmount() public {
        vm.prank(payer);
        vm.expectRevert(IBrainEscrow.ZeroAmount.selector);
        escrow.lock(ID, payee, address(token), 0, TERMS, deadline);
    }

    // --- fee-on-transfer guard (item 9) --------------------------------------

    function test_lock_feeOnTransfer_recordsReceivedNotNominal() public {
        FeeOnTransferToken fee = new FeeOnTransferToken();
        bytes32 id = keccak256("fee");
        uint256 nominal = 1_000e6;
        uint256 net = nominal - (nominal * 100) / 10_000; // 1% skim → 990e6

        fee.mint(payer, nominal);
        vm.startPrank(payer);
        fee.approve(address(escrow), nominal);
        // The event must report the NET amount received, not the nominal request.
        vm.expectEmit(true, true, true, true, address(escrow));
        emit IBrainEscrow.EscrowLocked(id, payer, payee, address(fee), net, TERMS, deadline);
        escrow.lock(id, payee, address(fee), nominal, TERMS, deadline);
        vm.stopPrank();

        // Stored amount == actual received; escrow holds exactly that, never less.
        (,,, uint256 amount,,,,,) = escrow.getEscrow(id);
        assertEq(amount, net);
        assertEq(fee.balanceOf(address(escrow)), net);

        // Releasing the full recorded amount settles and drains the escrow.
        vm.prank(payer);
        escrow.release(id, net);
        assertEq(fee.balanceOf(address(escrow)), 0);
        assertTrue(_state(id) == IBrainEscrow.State.Settled);
    }

    function test_lock_rejectsZeroReceived() public {
        NoOpToken noop = new NoOpToken();
        noop.mint(payer, AMOUNT);
        vm.startPrank(payer);
        noop.approve(address(escrow), AMOUNT);
        vm.expectRevert(IBrainEscrow.ZeroAmount.selector);
        escrow.lock(keccak256("noop"), payee, address(noop), AMOUNT, TERMS, deadline);
        vm.stopPrank();
    }

    // --- release (full + partial / milestones) -------------------------------

    function test_release_full_byPayer_settles() public {
        _lock();
        vm.expectEmit(true, true, false, true, address(escrow));
        emit IBrainEscrow.EscrowReleased(ID, payer, AMOUNT, true);
        vm.prank(payer);
        escrow.release(ID, AMOUNT);

        assertEq(token.balanceOf(payee), AMOUNT);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertTrue(_state(ID) == IBrainEscrow.State.Settled);
    }

    function test_release_partial_milestones() public {
        _lock();
        // milestone 1: 40%
        vm.prank(payer);
        escrow.release(ID, 400e6);
        assertEq(token.balanceOf(payee), 400e6);
        assertEq(_remaining(ID), 600e6);
        assertTrue(_state(ID) == IBrainEscrow.State.Locked); // not yet settled

        // milestone 2: the remaining 60% → settles
        vm.prank(payer);
        escrow.release(ID, 600e6);
        assertEq(token.balanceOf(payee), AMOUNT);
        assertEq(_remaining(ID), 0);
        assertTrue(_state(ID) == IBrainEscrow.State.Settled);
    }

    function test_release_byArbiter() public {
        _lock();
        vm.prank(arbiter);
        escrow.release(ID, AMOUNT);
        assertEq(token.balanceOf(payee), AMOUNT);
    }

    function test_release_rejectsStranger() public {
        _lock();
        vm.prank(address(0xDEAD));
        vm.expectRevert(IBrainEscrow.NotAuthorized.selector);
        escrow.release(ID, AMOUNT);
    }

    function test_release_rejectsZeroAmount() public {
        _lock();
        vm.prank(payer);
        vm.expectRevert(IBrainEscrow.ZeroAmount.selector);
        escrow.release(ID, 0);
    }

    function test_release_rejectsOverRemaining() public {
        _lock();
        vm.prank(payer);
        escrow.release(ID, 600e6);
        // remaining is 400e6; releasing 500e6 must revert.
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(IBrainEscrow.AmountExceedsRemaining.selector, ID, 500e6, 400e6)
        );
        escrow.release(ID, 500e6);
    }

    function test_release_afterSettled_reverts() public {
        _lock();
        vm.prank(payer);
        escrow.release(ID, AMOUNT);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(IBrainEscrow.EscrowNotLocked.selector, ID));
        escrow.release(ID, 1);
    }

    function test_release_unknownId_reverts() public {
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(IBrainEscrow.EscrowNotLocked.selector, ID));
        escrow.release(ID, 1);
    }

    // --- refund --------------------------------------------------------------

    function test_refund_byPayer_beforeDeadline_reverts() public {
        _lock();
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(IBrainEscrow.DeadlineNotReached.selector, deadline));
        escrow.refund(ID, AMOUNT);
    }

    function test_refund_byPayer_afterDeadline() public {
        _lock();
        vm.warp(uint256(deadline) + 1);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit IBrainEscrow.EscrowRefunded(ID, payer, AMOUNT, true);
        vm.prank(payer);
        escrow.refund(ID, AMOUNT);
        assertEq(token.balanceOf(payer), AMOUNT);
        assertTrue(_state(ID) == IBrainEscrow.State.Settled);
    }

    function test_refund_byArbiter_partial_thenSettlesWithRelease() public {
        _lock();
        // arbiter refunds 30% to payer...
        vm.prank(arbiter);
        escrow.refund(ID, 300e6);
        assertEq(token.balanceOf(payer), 300e6);
        assertTrue(_state(ID) == IBrainEscrow.State.Locked);
        assertEq(_remaining(ID), 700e6);
        // ...then releases the remaining 70% to the payee → settles.
        vm.prank(arbiter);
        escrow.release(ID, 700e6);
        assertEq(token.balanceOf(payee), 700e6);
        assertTrue(_state(ID) == IBrainEscrow.State.Settled);
    }

    function test_refund_rejectsStranger() public {
        _lock();
        vm.warp(uint256(deadline) + 1);
        vm.prank(address(0xDEAD));
        vm.expectRevert(IBrainEscrow.NotAuthorized.selector);
        escrow.refund(ID, AMOUNT);
    }

    // --- dispute split (arbiter: release part to payee, refund rest to payer) -

    function test_disputeSplit_byArbiter() public {
        _lock();
        vm.startPrank(arbiter);
        escrow.release(ID, 700e6); // 70% to payee
        escrow.refund(ID, 300e6); // 30% to payer → settles
        vm.stopPrank();
        assertEq(token.balanceOf(payee), 700e6);
        assertEq(token.balanceOf(payer), 300e6);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertTrue(_state(ID) == IBrainEscrow.State.Settled);
    }

    // --- reentrancy ----------------------------------------------------------

    function test_release_reentrancyGuardFires() public {
        ReentrantToken evil = new ReentrantToken();
        bytes32 id = keccak256("evil");
        evil.setTarget(escrow, id);
        vm.prank(payer);
        escrow.lock(id, payee, address(evil), AMOUNT, TERMS, deadline);

        vm.prank(payer);
        escrow.release(id, AMOUNT);

        assertTrue(evil.reentryReverted());
        assertEq(evil.balanceOf(payee), AMOUNT); // single credit, no double-spend
        assertTrue(_state(id) == IBrainEscrow.State.Settled);
    }

    // --- fuzz ----------------------------------------------------------------

    function testFuzz_lockReleaseConservesFunds(uint256 amount) public {
        amount = bound(amount, 1, 1e30);
        bytes32 id = keccak256(abi.encode("fuzz", amount));
        token.mint(payer, amount);
        vm.startPrank(payer);
        token.approve(address(escrow), amount);
        escrow.lock(id, payee, address(token), amount, TERMS, deadline);
        uint256 payeeBefore = token.balanceOf(payee);
        escrow.release(id, amount);
        vm.stopPrank();
        assertEq(token.balanceOf(payee) - payeeBefore, amount);
        assertEq(_remaining(id), 0);
    }
}

/// @dev Invariant: the escrow's token balance always equals the sum of
///      currently-outstanding (un-released, un-refunded) amounts across all
///      escrows — funds are never created or destroyed under any interleaving of
///      lock + partial release.
contract EscrowSolvencyHandler is Test {
    BrainEscrow internal escrow;
    MockERC20 internal token;
    address internal payer = address(0xF00D);
    address internal payee = address(0xBEEF);
    uint256 public ghostOutstanding;
    bytes32[] internal ids;
    mapping(bytes32 => bool) internal active;

    constructor(BrainEscrow _escrow, MockERC20 _token) {
        escrow = _escrow;
        token = _token;
    }

    function lock(uint256 amountSeed) external {
        uint256 amount = bound(amountSeed, 1, 1e24);
        bytes32 id = keccak256(abi.encode(amountSeed, ids.length, ghostOutstanding));
        if (active[id]) return;
        token.mint(payer, amount);
        vm.startPrank(payer);
        token.approve(address(escrow), amount);
        escrow.lock(id, payee, address(token), amount, bytes32(0), uint64(block.timestamp + 1));
        vm.stopPrank();
        ids.push(id);
        active[id] = true;
        ghostOutstanding += amount;
    }

    function release(uint256 idxSeed, uint256 amtSeed) external {
        if (ids.length == 0) return;
        bytes32 id = ids[bound(idxSeed, 0, ids.length - 1)];
        if (!active[id]) return;
        (,,, uint256 amount, uint256 released, uint256 refunded,,,) = escrow.getEscrow(id);
        uint256 remaining = amount - released - refunded;
        if (remaining == 0) return;
        uint256 amt = bound(amtSeed, 1, remaining);
        vm.prank(payer);
        escrow.release(id, amt);
        ghostOutstanding -= amt;
        if (amt == remaining) active[id] = false;
    }
}

contract BrainEscrowInvariantTest is Test {
    BrainEscrow internal escrow;
    MockERC20 internal token;
    EscrowSolvencyHandler internal handler;

    function setUp() public {
        escrow = new BrainEscrow(address(0xA12B17E2));
        token = new MockERC20();
        handler = new EscrowSolvencyHandler(escrow, token);
        targetContract(address(handler));
    }

    /// @notice Escrow token balance == sum of outstanding (un-settled) amounts.
    function invariant_solvency() public view {
        assertEq(token.balanceOf(address(escrow)), handler.ghostOutstanding());
    }
}
