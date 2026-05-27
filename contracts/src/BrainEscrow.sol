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
///         payee when the job is attested complete, or refund to the payer on
///         timeout / arbiter dispute. Every settlement still flows through the
///         off-chain PaymentIntent → §6 gate → audit path — this contract is the
///         on-chain settlement venue, never an un-gated money path.
/// @dev    ⚠️ UNAUDITED — NOT FOR MAINNET. Pre-audit reference implementation
///         (RFC 0001 §9: "Audit required before mainnet"). It MUST pass an
///         external security audit before ANY mainnet deployment; testnet
///         (Base Sepolia) only until then. Immutable by design — no admin, no
///         upgrade path, no pause. Hash-only (RFC 0001 §3): no string / PII on
///         the ABI; the only job datum on-chain is `jobTermsHash`.
contract BrainEscrow is IBrainEscrow {
    struct Escrow {
        address payer;
        address payee;
        address token;
        uint256 amount;
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

    /// @dev Non-reentrancy latch (1 = idle, 2 = entered). Cheaper than a bool
    ///      flip-flop's cold/warm pattern and explicit for auditors.
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
        // prevents a malicious token from observing an intermediate state.
        _safeTransferFrom(token, msg.sender, address(this), amount);

        _escrows[escrowId] = Escrow({
            payer: msg.sender,
            payee: payee,
            token: token,
            amount: amount,
            jobTermsHash: jobTermsHash,
            deadline: deadline,
            state: State.Locked
        });

        emit EscrowLocked(escrowId, msg.sender, payee, token, amount, jobTermsHash, deadline);
    }

    /// @inheritdoc IBrainEscrow
    function release(bytes32 escrowId) external override nonReentrant {
        Escrow storage e = _escrows[escrowId];
        if (e.state != State.Locked) revert EscrowNotLocked(escrowId);
        // Happy path: the payer confirms delivery. Dispute path: the arbiter
        // attests completion. No one else can move the funds.
        if (msg.sender != e.payer && msg.sender != arbiter) revert NotAuthorized();

        // Checks-effects-interactions: mark terminal BEFORE the external transfer
        // so a reentrant release/refund hits State.Released and reverts.
        e.state = State.Released;
        address payee = e.payee;
        address token = e.token;
        uint256 amount = e.amount;

        _safeTransfer(token, payee, amount);
        emit EscrowReleased(escrowId, msg.sender, amount);
    }

    /// @inheritdoc IBrainEscrow
    function refund(bytes32 escrowId) external override nonReentrant {
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

        e.state = State.Refunded;
        address payer = e.payer;
        address token = e.token;
        uint256 amount = e.amount;

        _safeTransfer(token, payer, amount);
        emit EscrowRefunded(escrowId, msg.sender, amount);
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
            bytes32 jobTermsHash,
            uint64 deadline,
            State state
        )
    {
        Escrow storage e = _escrows[escrowId];
        return (e.payer, e.payee, e.token, e.amount, e.jobTermsHash, e.deadline, e.state);
    }

    /// @dev SafeERC20-style transfer: tolerates tokens that return no data
    ///      (non-standard) and those that return a bool. Reverts on a false
    ///      return or a failed call. USDC returns bool true.
    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    /// @dev SafeERC20-style transferFrom — see {_safeTransfer}.
    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, from, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
