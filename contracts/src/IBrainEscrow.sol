// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

/// @title IBrainEscrow
/// @notice Interface for the Brain x402 / M2M settlement escrow (RFC 0001 §7.6).
///         An escrow holds an ERC-20 (USDC on Base, D-4) on behalf of a payer
///         until the job it funds is attested complete. Funds are released to the
///         payee or refunded to the payer **incrementally** — `release` and
///         `refund` each take an amount, supporting **milestone payments** and
///         **arbiter dispute-splits** (the arbiter resolves a dispute by
///         releasing part to the payee and refunding the rest to the payer). An
///         escrow is `Settled` once `released + refunded == amount`.
/// @dev    Hash-only by construction (RFC 0001 §3): the only job-specific datum
///         on-chain is `jobTermsHash` (a keccak256 commitment). No free-form
///         text, no PII — the ABI is bytes32 / address / uint only (enforced by
///         scripts/check-no-onchain-pii.mjs).
interface IBrainEscrow {
    /// @notice Lifecycle of an escrow. `None` distinguishes an unused id;
    ///         `Settled` is terminal (released + refunded == amount).
    enum State {
        None,
        Locked,
        Settled
    }

    /// @notice Funds locked: `payer` deposited `amount` of `token` for `payee`.
    event EscrowLocked(
        bytes32 indexed escrowId,
        address indexed payer,
        address indexed payee,
        address token,
        uint256 amount,
        bytes32 jobTermsHash,
        uint64 deadline
    );

    /// @notice A (partial) release to the payee.
    /// @param  escrowId      The escrow.
    /// @param  releasedBy    The actor that authorized this release (payer or arbiter).
    /// @param  amount        Amount transferred to the payee in this call.
    /// @param  fullySettled  True iff this release brought `released + refunded` to `amount`.
    event EscrowReleased(
        bytes32 indexed escrowId, address indexed releasedBy, uint256 amount, bool fullySettled
    );

    /// @notice A (partial) refund to the payer.
    /// @param  escrowId      The escrow.
    /// @param  refundedBy    The actor that authorized this refund (payer-after-deadline or arbiter).
    /// @param  amount        Amount returned to the payer in this call.
    /// @param  fullySettled  True iff this refund brought `released + refunded` to `amount`.
    event EscrowRefunded(
        bytes32 indexed escrowId, address indexed refundedBy, uint256 amount, bool fullySettled
    );

    error EscrowExists(bytes32 escrowId);
    error EscrowNotLocked(bytes32 escrowId);
    error ZeroAddress();
    error ZeroAmount();
    error AmountExceedsRemaining(bytes32 escrowId, uint256 requested, uint256 remaining);
    error NotAuthorized();
    error DeadlineNotReached(uint64 deadline);
    error Reentrancy();
    error TransferFailed();

    /// @notice Lock `amount` of `token` from `msg.sender` (the payer) for `payee`.
    /// @dev    Requires a prior ERC-20 approval of this contract for `amount`.
    ///         Reverts if `escrowId` is already used (no re-lock / overwrite).
    function lock(
        bytes32 escrowId,
        address payee,
        address token,
        uint256 amount,
        bytes32 jobTermsHash,
        uint64 deadline
    ) external;

    /// @notice Release `amount` (≤ remaining) of a Locked escrow to its payee.
    ///         Callable multiple times (milestones). Authorized: the payer
    ///         (confirming delivery) or the arbiter (attesting / dispute).
    function release(bytes32 escrowId, uint256 amount) external;

    /// @notice Refund `amount` (≤ remaining) of a Locked escrow to its payer.
    ///         Callable multiple times. Authorized: the arbiter (dispute) any
    ///         time, or the payer once `deadline` has passed.
    function refund(bytes32 escrowId, uint256 amount) external;

    /// @notice Read an escrow's settlement-relevant fields (for the §6
    ///         escrow-state-binding gate check). `remaining = amount - released
    ///         - refunded`.
    function getEscrow(bytes32 escrowId)
        external
        view
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
        );
}
