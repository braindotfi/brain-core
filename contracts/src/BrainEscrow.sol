// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {IBrainEscrow} from "./IBrainEscrow.sol";

/// @dev Minimal ERC-20 surface used by the escrow. Declared inline so the
///      contract is dependency-free (matches the other Brain contracts) and
///      compiles without external libraries. USDC on Base implements this.
interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title BrainEscrow
/// @notice x402 / M2M settlement escrow on Base (RFC 0001 §7.6). A payer locks
///         USDC for a payee against a hashed job commitment; funds release to the
///         payee or refund to the payer **incrementally** — supporting milestone
///         payments and arbiter dispute-splits (release part to the payee, refund
///         the rest to the payer). An escrow is `Settled` once
///         `released + refunded == amount`. Every settlement still flows through
///         the off-chain PaymentIntent → §6 gate → audit path — this contract is
///         the on-chain settlement venue, never an un-gated money path.
/// @dev    ⚠️ UNAUDITED — NOT FOR MAINNET. Pre-audit reference implementation
///         (RFC 0001 §9: "Audit required before mainnet"). Base Sepolia testnet
///         only until an external audit clears. Immutable — no admin, no upgrade,
///         no pause. Hash-only (RFC 0001 §3): no string / PII on the ABI; the
///         only job datum on-chain is `jobTermsHash`.
contract BrainEscrow is IBrainEscrow {
    struct Escrow {
        address payer;
        address payee;
        address token;
        uint256 amount; // total locked
        uint256 released; // cumulative transferred to the payee
        uint256 refunded; // cumulative returned to the payer
        bytes32 jobTermsHash;
        uint64 deadline;
        State state;
    }

    /// @notice Dispute arbiter (Brain's attester; a Safe multi-sig in prod).
    ///         Immutable — set once at deploy, never rotated (no admin surface).
    address public immutable arbiter;

    /// @dev escrowId → escrow. A non-None state marks the id permanently used,
    ///      so a settled id can never be reused (replay-safe).
    mapping(bytes32 => Escrow) private _escrows;

    /// @dev Non-reentrancy latch (1 = idle, 2 = entered).
    uint256 private _entered = 1;

    modifier nonReentrant() {
        if (_entered != 1) revert Reentrancy();
        _entered = 2;
        _;
        _entered = 1;
    }

    /// @param _arbiter The dispute arbiter / attester (multi-sig in prod).
    constructor(address _arbiter) {
        if (_arbiter == address(0)) revert ZeroAddress();
        arbiter = _arbiter;
    }

    /// @inheritdoc IBrainEscrow
    /// @dev Records the amount the escrow ACTUALLY received — the balanceOf
    ///      delta across the transferFrom — rather than the nominal `amount`. A
    ///      fee-on-transfer or rebasing token that delivers less than `amount`
    ///      would otherwise leave the escrow under-collateralised while it
    ///      believed it held the full sum, breaking the solvency invariant that
    ///      release/refund rely on. For standard tokens (USDC) the delta equals
    ///      `amount`. Reverts if nothing was received.
    function lock(
        bytes32 escrowId,
        address payee,
        address token,
        uint256 amount,
        bytes32 jobTermsHash,
        uint64 deadline
    ) external override nonReentrant {
        if (_escrows[escrowId].state != State.None) revert EscrowExists(escrowId);
        if (payee == address(0) || token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        // Pull funds first: the safe wrapper reverts on failure, so a failed
        // transfer rolls the whole tx back and records no escrow. nonReentrant
        // prevents a malicious token from observing an intermediate state. We
        // measure the balance delta and record THAT (fee-on-transfer guard).
        uint256 balanceBefore = IERC20Minimal(token).balanceOf(address(this));
        _safeTransferFrom(token, msg.sender, address(this), amount);
        uint256 received = IERC20Minimal(token).balanceOf(address(this)) - balanceBefore;
        if (received == 0) revert ZeroAmount();

        _escrows[escrowId] = Escrow({
            payer: msg.sender,
            payee: payee,
            token: token,
            amount: received,
            released: 0,
            refunded: 0,
            jobTermsHash: jobTermsHash,
            deadline: deadline,
            state: State.Locked
        });

        emit EscrowLocked(escrowId, msg.sender, payee, token, received, jobTermsHash, deadline);
    }

    /// @inheritdoc IBrainEscrow
    function release(bytes32 escrowId, uint256 amount) external override nonReentrant {
        Escrow storage e = _escrows[escrowId];
        if (e.state != State.Locked) revert EscrowNotLocked(escrowId);
        // Happy path: the payer confirms (a milestone of) delivery. Dispute path:
        // the arbiter attests / resolves. No one else can move the funds.
        if (msg.sender != e.payer && msg.sender != arbiter) revert NotAuthorized();
        if (amount == 0) revert ZeroAmount();

        uint256 remaining = e.amount - e.released - e.refunded;
        if (amount > remaining) revert AmountExceedsRemaining(escrowId, amount, remaining);

        // Checks-effects-interactions: account + (maybe) settle BEFORE the
        // external transfer, so a reentrant call sees the updated state.
        e.released += amount;
        bool settled = e.released + e.refunded == e.amount;
        if (settled) e.state = State.Settled;
        address payee = e.payee;
        address token = e.token;

        _safeTransfer(token, payee, amount);
        emit EscrowReleased(escrowId, msg.sender, amount, settled);
    }

    /// @inheritdoc IBrainEscrow
    function refund(bytes32 escrowId, uint256 amount) external override nonReentrant {
        Escrow storage e = _escrows[escrowId];
        if (e.state != State.Locked) revert EscrowNotLocked(escrowId);
        // Arbiter may refund any time (dispute); the payer may self-refund only
        // after the deadline (job not delivered in time).
        bool byArbiter = msg.sender == arbiter;
        bool byPayerAfterDeadline = msg.sender == e.payer && block.timestamp >= e.deadline;
        if (!byArbiter && !byPayerAfterDeadline) {
            if (msg.sender == e.payer) revert DeadlineNotReached(e.deadline);
            revert NotAuthorized();
        }
        if (amount == 0) revert ZeroAmount();

        uint256 remaining = e.amount - e.released - e.refunded;
        if (amount > remaining) revert AmountExceedsRemaining(escrowId, amount, remaining);

        e.refunded += amount;
        bool settled = e.released + e.refunded == e.amount;
        if (settled) e.state = State.Settled;
        address payer = e.payer;
        address token = e.token;

        _safeTransfer(token, payer, amount);
        emit EscrowRefunded(escrowId, msg.sender, amount, settled);
    }

    /// @inheritdoc IBrainEscrow
    function getEscrow(bytes32 escrowId)
        external
        view
        override
        returns (
            address payer,
            address payee,
            address token,
            uint256 amount,
            uint256 released,
            uint256 refunded,
            bytes32 jobTermsHash,
            uint64 deadline,
            State state
        )
    {
        Escrow storage e = _escrows[escrowId];
        return (
            e.payer,
            e.payee,
            e.token,
            e.amount,
            e.released,
            e.refunded,
            e.jobTermsHash,
            e.deadline,
            e.state
        );
    }

    /// @dev SafeERC20-style transfer: tolerates tokens that return no data
    ///      (non-standard) and those that return a bool. Reverts on a false
    ///      return or a failed call. USDC returns bool true.
    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    /// @dev SafeERC20-style transferFrom — see {_safeTransfer}.
    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, from, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
