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
///      try/catch so we can assert it reverted (the guard fired) while the outer
///      release still settles exactly once.
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

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return true; // allow the lock to succeed
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (!attacking) {
            attacking = true;
            try escrow.release(targetId) {
                // unreachable — the guard must revert the reentrant call
            } catch {
                reentryReverted = true;
            }
        }
        balanceOf[to] += amount;
        return true;
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
        (address p, address pe, address t, uint256 a, bytes32 h, uint64 d, IBrainEscrow.State s) =
            escrow.getEscrow(ID);
        assertEq(p, payer);
        assertEq(pe, payee);
        assertEq(t, address(token));
        assertEq(a, AMOUNT);
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

    // --- release -------------------------------------------------------------

    function test_release_byPayer_paysPayee() public {
        _lock();
        vm.expectEmit(true, true, false, true, address(escrow));
        emit IBrainEscrow.EscrowReleased(ID, payer, AMOUNT);
        vm.prank(payer);
        escrow.release(ID);

        assertEq(token.balanceOf(payee), AMOUNT);
        assertEq(token.balanceOf(address(escrow)), 0);
        (,,,,,, IBrainEscrow.State s) = escrow.getEscrow(ID);
        assertTrue(s == IBrainEscrow.State.Released);
    }

    function test_release_byArbiter_paysPayee() public {
        _lock();
        vm.prank(arbiter);
        escrow.release(ID);
        assertEq(token.balanceOf(payee), AMOUNT);
    }

    function test_release_rejectsStranger() public {
        _lock();
        vm.prank(address(0xDEAD));
        vm.expectRevert(IBrainEscrow.NotAuthorized.selector);
        escrow.release(ID);
    }

    function test_release_rejectsDoubleRelease() public {
        _lock();
        vm.prank(payer);
        escrow.release(ID);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(IBrainEscrow.EscrowNotLocked.selector, ID));
        escrow.release(ID);
    }

    function test_release_thenRefund_rejected() public {
        _lock();
        vm.prank(payer);
        escrow.release(ID);
        vm.prank(arbiter);
        vm.expectRevert(abi.encodeWithSelector(IBrainEscrow.EscrowNotLocked.selector, ID));
        escrow.refund(ID);
    }

    // --- refund --------------------------------------------------------------

    function test_refund_byPayer_beforeDeadline_reverts() public {
        _lock();
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(IBrainEscrow.DeadlineNotReached.selector, deadline));
        escrow.refund(ID);
    }

    function test_refund_byPayer_afterDeadline_refunds() public {
        _lock();
        vm.warp(uint256(deadline) + 1);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit IBrainEscrow.EscrowRefunded(ID, payer, AMOUNT);
        vm.prank(payer);
        escrow.refund(ID);
        assertEq(token.balanceOf(payer), AMOUNT);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_refund_byArbiter_anytime() public {
        _lock();
        vm.prank(arbiter);
        escrow.refund(ID);
        assertEq(token.balanceOf(payer), AMOUNT);
        (,,,,,, IBrainEscrow.State s) = escrow.getEscrow(ID);
        assertTrue(s == IBrainEscrow.State.Refunded);
    }

    function test_refund_rejectsStranger() public {
        _lock();
        vm.warp(uint256(deadline) + 1);
        vm.prank(address(0xDEAD));
        vm.expectRevert(IBrainEscrow.NotAuthorized.selector);
        escrow.refund(ID);
    }

    function test_release_unknownId_reverts() public {
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(IBrainEscrow.EscrowNotLocked.selector, ID));
        escrow.release(ID);
    }

    // --- reentrancy ----------------------------------------------------------

    function test_release_reentrancyGuardFires() public {
        ReentrantToken evil = new ReentrantToken();
        bytes32 id = keccak256("evil");
        evil.setTarget(escrow, id);
        // Lock with the malicious token (transferFrom returns true).
        vm.prank(payer);
        escrow.lock(id, payee, address(evil), AMOUNT, TERMS, deadline);

        // On release, the token's transfer() reenters release(); the guard
        // reverts the reentrant call (caught by the token's try/catch), so the
        // payee is credited exactly once and the escrow settles to Released.
        vm.prank(payer);
        escrow.release(id);

        assertTrue(evil.reentryReverted());
        assertEq(evil.balanceOf(payee), AMOUNT); // single credit, no double-spend
        (,,,,,, IBrainEscrow.State s) = escrow.getEscrow(id);
        assertTrue(s == IBrainEscrow.State.Released);
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
        escrow.release(id);
        vm.stopPrank();
        assertEq(token.balanceOf(payee) - payeeBefore, amount);
        assertEq(token.balanceOf(address(escrow)), 0);
    }
}

/// @dev Invariant: the escrow's token balance always equals the sum of
///      currently-locked amounts (funds are never created or destroyed; every
///      locked deposit is either held, released, or refunded — never lost).
contract EscrowSolvencyHandler is Test {
    BrainEscrow internal escrow;
    MockERC20 internal token;
    address internal payer = address(0xF00D);
    address internal payee = address(0xBEEF);
    uint256 public ghostLocked;
    bytes32[] internal ids;
    mapping(bytes32 => bool) internal locked;

    constructor(BrainEscrow _escrow, MockERC20 _token) {
        escrow = _escrow;
        token = _token;
    }

    function lock(uint256 amountSeed) external {
        uint256 amount = bound(amountSeed, 1, 1e24);
        bytes32 id = keccak256(abi.encode(amountSeed, ids.length, ghostLocked));
        if (locked[id]) return;
        token.mint(payer, amount);
        vm.startPrank(payer);
        token.approve(address(escrow), amount);
        escrow.lock(id, payee, address(token), amount, bytes32(0), uint64(block.timestamp + 1));
        vm.stopPrank();
        ids.push(id);
        locked[id] = true;
        ghostLocked += amount;
    }

    function release(uint256 idxSeed) external {
        if (ids.length == 0) return;
        bytes32 id = ids[bound(idxSeed, 0, ids.length - 1)];
        if (!locked[id]) return;
        (,,, uint256 amount,,,) = escrow.getEscrow(id);
        vm.prank(payer);
        escrow.release(id);
        locked[id] = false;
        ghostLocked -= amount;
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

    /// @notice Escrow token balance == sum of currently-locked amounts.
    function invariant_solvency() public view {
        assertEq(token.balanceOf(address(escrow)), handler.ghostLocked());
    }
}
