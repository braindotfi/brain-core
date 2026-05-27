// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {IBrainReputationRegistry} from "./IBrainReputationRegistry.sol";

/// @title BrainReputationRegistry
/// @notice ERC-8004-style agent reputation registry on Base (RFC 0001 §7.7, D-6).
///         An attestor (Brain's reputation oracle; a Safe multi-sig in prod)
///         publishes, per agent, a single **reputation pointer** — a `bytes32`
///         Merkle root committing to the agent's off-chain reputation dataset —
///         versioned by a monotonically increasing `epoch`. The chain holds the
///         pointer **only**: no raw history, no score, no PII (RFC 0001 §3).
/// @dev    ⚠️ UNAUDITED — pre-audit reference implementation. **Non-custodial:**
///         it holds no funds and has no token / value transfer path of any kind,
///         so it is NOT a "money contract" in the RFC 0001 §9 sense. It is still
///         **batched into the external audit** (correctness of the monotonic
///         epoch, attestor authorization, hash-only ABI) and runs on Base Sepolia
///         (testnet) until that audit clears. Immutable — no upgrade, no pause;
///         the only privileged action is attestor rotation (itself attestor-only).
///
///         **Policy input only (Standards §6, Principle #5).** Brain's Policy
///         layer reads this pointer as a *threshold* input and may only TIGHTEN a
///         decision for a low-reputation counterparty. Reputation is never a §6
///         pre-execution-gate precondition and can never authorize a payment.
contract BrainReputationRegistry is IBrainReputationRegistry {
    /// @notice Reputation oracle. The only address that may publish pointers.
    ///         A Safe multi-sig in production (rotatable via {setAttestor}).
    address public attestor;

    struct Reputation {
        bytes32 scoreRoot; // Merkle root committing to the off-chain dataset (pointer).
        uint64 epoch; // Monotonic version; strictly increases on each publish.
        uint64 updatedAt; // Block timestamp of the latest publication.
    }

    /// @dev agentId → latest reputation pointer. A non-zero `epoch` marks the
    ///      agent as having a published pointer (epoch starts at >= 1).
    mapping(bytes32 => Reputation) private _repByAgent;

    modifier onlyAttestor() {
        if (msg.sender != attestor) revert NotAttestor();
        _;
    }

    /// @param _attestor The initial attestor / reputation oracle (multi-sig in prod).
    constructor(address _attestor) {
        if (_attestor == address(0)) revert ZeroAddress();
        attestor = _attestor;
        emit AttestorChanged(address(0), _attestor);
    }

    /// @inheritdoc IBrainReputationRegistry
    function publishReputation(bytes32 agentId, bytes32 scoreRoot, uint64 epoch)
        external
        override
        onlyAttestor
    {
        if (scoreRoot == bytes32(0)) revert ZeroRoot();
        Reputation storage r = _repByAgent[agentId];
        // Strictly-increasing epoch: anti-replay + total ordering. A stale or
        // equal epoch reverts, so an old pointer can never overwrite a newer one.
        if (epoch <= r.epoch) revert StaleEpoch(agentId, epoch, r.epoch);

        uint64 ts = uint64(block.timestamp);
        r.scoreRoot = scoreRoot;
        r.epoch = epoch;
        r.updatedAt = ts;

        emit ReputationPublished(agentId, scoreRoot, epoch, ts);
    }

    /// @inheritdoc IBrainReputationRegistry
    function setAttestor(address next) external override onlyAttestor {
        if (next == address(0)) revert ZeroAddress();
        address prev = attestor;
        attestor = next;
        emit AttestorChanged(prev, next);
    }

    /// @inheritdoc IBrainReputationRegistry
    function reputationOf(bytes32 agentId)
        external
        view
        override
        returns (bytes32 scoreRoot, uint64 epoch, uint64 updatedAt)
    {
        Reputation storage r = _repByAgent[agentId];
        return (r.scoreRoot, r.epoch, r.updatedAt);
    }

    /// @inheritdoc IBrainReputationRegistry
    function hasReputation(bytes32 agentId) external view override returns (bool) {
        return _repByAgent[agentId].epoch != 0;
    }
}
