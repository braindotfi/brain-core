// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

/// @title IBrainEscrow
/// @notice Interface for the Brain x402 / M2M settlement escrow (RFC 0001 §7.6).
///         An escrow holds an ERC-20 (USDC on Base, D-4) on behalf of a payer
///         until the job it funds is attested complete (release to payee) or is
///         refunded (back to payer). Lock → Released | Refunded; terminal states
///         are final (no double-settlement).
/// @dev    Hash-only by construction (RFC 0001 §3): the only job-specific datum
///         on-chain is `jobTermsHash` (a keccak256 commitment of the off-chain
///         terms). No free-form text, no PII, ever — the ABI is bytes32 / address
///         / uint only (enforced by scripts/check-no-onchain-pii.mjs).
interface IBrainEscrow {
    /// @notice Lifecycle of a single escrow. `None` distinguishes an unused id.
    enum State {
        None,
        Locked,
        Released,
        Refunded
    }

    /// @notice Funds locked: `payer` deposited `amount` of `token` for `payee`.
    /// @param  escrowId     Caller-chosen unique id (bytes32; e.g. keccak of the x402 request).
    /// @param  payer        Funder (buyer/agent).
    /// @param  payee        Beneficiary on release (seller/agent).
    /// @param  token        ERC-20 settled (USDC on Base).
    /// @param  amount       Locked amount (token base units).
    /// @param  jobTermsHash keccak256 commitment of the off-chain job terms (hash-only).
    /// @param  deadline     Unix seconds after which the payer may self-refund.
    event EscrowLocked(
        bytes32 indexed escrowId,
        address indexed payer,
        address indexed payee,
        address token,
        uint256 amount,
        bytes32 jobTermsHash,
        uint64 deadline
    );

    /// @notice Funds released to the payee (job attested complete).
    /// @param  escrowId The escrow settled.
    /// @param  releasedBy The actor that authorized release (payer or arbiter).
    /// @param  amount   Amount transferred to the payee.
    event EscrowReleased(bytes32 indexed escrowId, address indexed releasedBy, uint256 amount);

    /// @notice Funds refunded to the payer (timeout or arbiter dispute).
    /// @param  escrowId   The escrow refunded.
    /// @param  refundedBy The actor that authorized the refund (payer-after-deadline or arbiter).
    /// @param  amount     Amount returned to the payer.
    event EscrowRefunded(bytes32 indexed escrowId, address indexed refundedBy, uint256 amount);

    error EscrowExists(bytes32 escrowId);
    error EscrowNotLocked(bytes32 escrowId);
    error ZeroAddress();
    error ZeroAmount();
    error NotAuthorized();
    error DeadlineNotReached(uint64 deadline);
    error Reentrancy();
    error TransferFailed();

    /// @notice Lock `amount` of `token` from `msg.sender` (the payer) for `payee`.
    /// @dev    Requires a prior ERC-20 approval of this contract for `amount`.
    ///         Reverts if `escrowId` is already used (no re-lock / no overwrite).
    function lock(
        bytes32 escrowId,
        address payee,
        address token,
        uint256 amount,
        bytes32 jobTermsHash,
        uint64 deadline
    ) external;

    /// @notice Release a locked escrow to its payee. Authorized: the payer
    ///         (confirming delivery) or the arbiter (attesting completion).
    function release(bytes32 escrowId) external;

    /// @notice Refund a locked escrow to its payer. Authorized: the arbiter
    ///         (dispute) at any time, or the payer once `deadline` has passed.
    function refund(bytes32 escrowId) external;

    /// @notice Read an escrow's settlement-relevant fields (for the §6
    ///         escrow-state-binding gate check).
    function getEscrow(bytes32 escrowId)
        external
        view
        returns (
            address payer,
            address payee,
            address token,
            uint256 amount,
            bytes32 jobTermsHash,
            uint64 deadline,
            State state
        );
}
