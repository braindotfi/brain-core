// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

/// @title IBrainReputationRegistry
/// @notice Interface for the Brain ERC-8004-style agent reputation registry
///         (RFC 0001 §7.7, D-6). It records, per agent, a single **reputation
///         pointer** — a `bytes32` Merkle root committing to the agent's
///         off-chain reputation dataset (feedback / attestations / score inputs)
///         — together with a monotonically increasing `epoch`. It stores **no
///         raw reputation history and no score**; the numeric score is derived
///         off-chain from the dataset the root commits to (RFC 0001 §3: only a
///         pointer / Merkle root goes on-chain).
/// @dev    **Policy input only — never a money gate, never a §6 precondition.**
///         Brain's Policy layer reads this pointer as a *threshold* input
///         (it may make a decision STRICTER for a low-reputation counterparty);
///         it can never authorize a payment, and the deterministic §6
///         pre-execution gate never consumes a reputation value (Standards §6,
///         Principle #5: reputation/LLM judgment never replaces a deterministic
///         gate check). This contract custodies **no funds** and has **no
///         transfer / value path** of any kind.
///
///         Hash-only by construction: the ABI is `bytes32` / `address` / `uint`
///         only — no `string`, no PII (enforced by
///         scripts/check-no-onchain-pii.mjs).
interface IBrainReputationRegistry {
    /// @notice A reputation pointer was published (or re-published) for an agent.
    /// @param  agentId    keccak256 agent identifier (matches BrainMCPAgentRegistry).
    /// @param  scoreRoot  Merkle root committing to the off-chain reputation dataset.
    /// @param  epoch      Strictly-increasing version for this agent (anti-replay / ordering).
    /// @param  updatedAt  Block timestamp of this publication (unix seconds).
    event ReputationPublished(
        bytes32 indexed agentId, bytes32 scoreRoot, uint64 epoch, uint64 updatedAt
    );

    /// @notice The attestor (reputation oracle) was rotated.
    event AttestorChanged(address indexed oldAttestor, address indexed newAttestor);

    error NotAttestor();
    error ZeroAddress();
    error ZeroRoot();
    /// @dev `epoch` must strictly exceed the agent's current epoch.
    error StaleEpoch(bytes32 agentId, uint64 provided, uint64 current);

    /// @notice Publish (or update) an agent's reputation pointer.
    /// @dev    Only the attestor. `scoreRoot` must be non-zero; `epoch` must be
    ///         strictly greater than the agent's current epoch (the first publish
    ///         therefore requires `epoch >= 1`). Re-publishing a fresh root at a
    ///         higher epoch is the normal update path.
    function publishReputation(bytes32 agentId, bytes32 scoreRoot, uint64 epoch) external;

    /// @notice Rotate the attestor (reputation oracle). Only the current attestor.
    function setAttestor(address next) external;

    /// @notice Read an agent's current reputation pointer.
    /// @return scoreRoot  The latest Merkle root (zero if never published).
    /// @return epoch      The latest epoch (zero if never published).
    /// @return updatedAt  Timestamp of the latest publication (zero if never published).
    function reputationOf(bytes32 agentId)
        external
        view
        returns (bytes32 scoreRoot, uint64 epoch, uint64 updatedAt);

    /// @notice Whether any reputation pointer has ever been published for `agentId`.
    function hasReputation(bytes32 agentId) external view returns (bool);
}
