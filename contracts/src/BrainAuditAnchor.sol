// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

/// @title BrainAuditAnchor
/// @notice Publishes per-tenant Merkle roots to Base. Anyone can verify that
///         an audit record was included in a root published at a given block
///         height, without trusting Brain. §4 of Brain_MVP_Architecture.md.
/// @dev    Publisher role is multi-sig (2-of-3) set at deploy time. Contract
///         is immutable after audit — no upgrade path, no admin.
contract BrainAuditAnchor {
    /// @notice Emitted once per tenant per anchor publication.
    event AnchorPublished(
        bytes32 indexed tenantId, bytes32 root, uint256 eventCount, uint256 periodStart, uint256 periodEnd
    );

    /// @notice Emitted when the publisher is rotated (multi-sig change).
    event PublisherChanged(address indexed oldPublisher, address indexed newPublisher);

    /// @notice Emitted when a two-step publisher rotation is proposed; the
    ///         rotation completes only when `pendingPublisher` calls acceptPublisher.
    event PublisherTransferStarted(address indexed currentPublisher, address indexed pendingPublisher);

    /// @dev The single publisher address. In production this is a Safe
    ///      multi-sig (2-of-3) so a single-key compromise cannot publish.
    address public publisher;

    /// @dev Two-step rotation: the proposed next publisher, who must call
    ///      acceptPublisher() to take the role. Zero when none is pending.
    address public pendingPublisher;

    /// @dev Tracks the most recent anchor per tenant for the view helper.
    struct Latest {
        bytes32 root;
        uint256 blockNumber;
        uint256 eventCount;
        uint256 periodEnd;
    }

    mapping(bytes32 => Latest) private _latestByTenant;

    /// @dev §5.3: idempotent by (tenantId, root). Re-publishing the same
    ///      root for the same tenant reverts.
    mapping(bytes32 => mapping(bytes32 => bool)) private _published;

    /// @notice Hard cap for anchorBatch. Keeps worst-case gas bounded under the
    ///         Base Sepolia block gas limit while letting the publisher collapse
    ///         the normal hourly cycle to one transaction.
    uint256 public constant MAX_BATCH = 50;

    error NotPublisher();
    error NotPendingPublisher();
    error RootAlreadyPublished(bytes32 tenantId, bytes32 root);
    error ZeroAddress();
    error InvalidPeriod();
    error EmptyAnchor();
    error BatchLengthMismatch();
    error BatchTooLarge(uint256 length);

    /// @dev Domain tag of the synthetic count leaf. Mirrored byte-for-byte by
    ///      services/audit/src/merkle.ts.
    bytes32 private constant _COUNT_LEAF_DOMAIN = keccak256("brain.audit.leaf-count.v1");

    modifier onlyPublisher() {
        if (msg.sender != publisher) revert NotPublisher();
        _;
    }

    /// @param _publisher The initial publisher address (multi-sig in prod).
    constructor(address _publisher) {
        if (_publisher == address(0)) revert ZeroAddress();
        publisher = _publisher;
        emit PublisherChanged(address(0), _publisher);
    }

    /// @notice Publish a Merkle root for a tenant's audit window.
    /// @param tenantId    keccak256 of the Brain tenant id (tnt_<ulid>).
    /// @param root        Merkle root over the event hashes in the window.
    /// @param eventCount  Number of leaves in the tree. Must be non-zero: an
    ///                    empty window has nothing to prove and its root is a
    ///                    constant, which would consume the (tenantId, root)
    ///                    slot for every future empty window.
    /// @param periodStart Window start (unix seconds).
    /// @param periodEnd   Window end (unix seconds, inclusive of last event).
    function anchor(bytes32 tenantId, bytes32 root, uint256 eventCount, uint256 periodStart, uint256 periodEnd)
        external
        onlyPublisher
    {
        if (periodEnd < periodStart) revert InvalidPeriod();
        if (eventCount == 0) revert EmptyAnchor();
        if (_published[tenantId][root]) revert RootAlreadyPublished(tenantId, root);

        _published[tenantId][root] = true;
        _recordLatest(tenantId, root, eventCount, periodEnd);

        emit AnchorPublished(tenantId, root, eventCount, periodStart, periodEnd);
    }

    /// @notice Publish multiple tenant Merkle roots in one transaction.
    /// @dev    Same semantics as `anchor` for every element except duplicate
    ///         (tenantId, root) pairs are skipped, making batch retries safe
    ///         after a partial prior success.
    function anchorBatch(
        bytes32[] calldata tenantIds,
        bytes32[] calldata roots,
        uint256[] calldata eventCounts,
        uint256[] calldata periodStarts,
        uint256[] calldata periodEnds
    ) external onlyPublisher {
        uint256 len = tenantIds.length;
        if (roots.length != len || eventCounts.length != len || periodStarts.length != len || periodEnds.length != len)
        {
            revert BatchLengthMismatch();
        }
        if (len > MAX_BATCH) revert BatchTooLarge(len);

        for (uint256 i = 0; i < len; ++i) {
            if (periodEnds[i] < periodStarts[i]) revert InvalidPeriod();
            if (eventCounts[i] == 0) revert EmptyAnchor();
            bytes32 tenantId = tenantIds[i];
            bytes32 root = roots[i];
            if (_published[tenantId][root]) continue;

            _published[tenantId][root] = true;
            _recordLatest(tenantId, root, eventCounts[i], periodEnds[i]);

            emit AnchorPublished(tenantId, root, eventCounts[i], periodStarts[i], periodEnds[i]);
        }
    }

    /// @dev Advance the per-tenant "latest" pointer only when this anchor is at
    ///      least as recent as the one already recorded.
    ///
    ///      Publication order is not guaranteed to be chronological: a retry, a
    ///      backfill, or a catch-up batch can carry an OLDER window than what is
    ///      already stored. The pointer used to be overwritten unconditionally,
    ///      so `latestAnchor` could regress and report a stale root as current
    ///      to any third party verifying without trusting Brain. The
    ///      (tenantId, root) publication record is unaffected: every anchor is
    ///      still recorded and still emits its event.
    function _recordLatest(bytes32 tenantId, bytes32 root, uint256 eventCount, uint256 periodEnd) private {
        if (periodEnd < _latestByTenant[tenantId].periodEnd) return;
        _latestByTenant[tenantId] =
            Latest({root: root, blockNumber: block.number, eventCount: eventCount, periodEnd: periodEnd});
    }

    /// @notice Begin a two-step publisher rotation (multi-sig membership change).
    ///         Only the current publisher may propose. The rotation does NOT take
    ///         effect until `next` calls acceptPublisher() — a one-step set to a
    ///         mistyped or uncontrolled address would permanently brick anchoring.
    /// @param  next The proposed next publisher, or address(0) to cancel a pending
    ///         rotation.
    function setPublisher(address next) external onlyPublisher {
        pendingPublisher = next;
        emit PublisherTransferStarted(publisher, next);
    }

    /// @notice Complete a two-step publisher rotation. Callable only by the
    ///         address named in a prior setPublisher; clears the pending slot.
    function acceptPublisher() external {
        if (msg.sender != pendingPublisher) revert NotPendingPublisher();
        address prev = publisher;
        publisher = pendingPublisher;
        pendingPublisher = address(0);
        emit PublisherChanged(prev, publisher);
    }

    /// @notice The synthetic leaf every anchored tree carries at index 0, which
    ///         is what binds a root to its leaf COUNT.
    /// @dev    Reconstructible by anyone from the `eventCount` this contract
    ///         stores, so `verifyInclusion(root, countLeaf(eventCount), proof)`
    ///         proves the published root commits to the count published beside
    ///         it. Mirrored byte-for-byte by services/audit/src/merkle.ts.
    function countLeaf(uint256 eventCount) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(_COUNT_LEAF_DOMAIN, eventCount));
    }

    /// @notice Verify that a leaf is included in a root by a Merkle proof.
    /// @dev    Domain separation prevents second pre-image attacks:
    ///         leaf nodes   → keccak256(0x00 ++ leaf_data)
    ///         internal nodes → keccak256(0x01 ++ sort(left, right))
    ///         The audit publisher MUST use the same scheme off-chain.
    ///         `leaf` is raw leaf data; `proof` elements are already-computed
    ///         node hashes at each level (leaf hashes for bottom-level siblings,
    ///         internal node hashes for higher levels).
    ///
    ///         The tree still duplicates a trailing odd node, so [A,B,C] and
    ///         [A,B,C,C] produce the same FOLD. That no longer collides the root:
    ///         every tree carries {countLeaf} at index 0, so a root over 3 events
    ///         commits to 3 and can never be presented as a genuine 4-leaf
    ///         window. Membership was always provable; completeness now is too.
    ///         The 0x00/0x01 domain separation is unchanged and still blocks the
    ///         separate second-preimage case (presenting an internal node as a
    ///         leaf).
    function verifyInclusion(bytes32 root, bytes32 leaf, bytes32[] calldata proof) external pure returns (bool) {
        bytes32 computed = keccak256(abi.encodePacked(bytes1(0x00), leaf));
        uint256 len = proof.length;
        for (uint256 i = 0; i < len; ++i) {
            bytes32 sibling = proof[i];
            if (computed < sibling) {
                computed = keccak256(abi.encodePacked(bytes1(0x01), computed, sibling));
            } else {
                computed = keccak256(abi.encodePacked(bytes1(0x01), sibling, computed));
            }
        }
        return computed == root;
    }

    /// @notice Return the most recent anchor for a tenant.
    function latestAnchor(bytes32 tenantId) external view returns (bytes32 root, uint256 blockNumber) {
        Latest memory l = _latestByTenant[tenantId];
        return (l.root, l.blockNumber);
    }

    /// @notice Extended latest view — also exposes eventCount and periodEnd.
    function latestAnchorFull(bytes32 tenantId)
        external
        view
        returns (bytes32 root, uint256 blockNumber, uint256 eventCount, uint256 periodEnd)
    {
        Latest memory l = _latestByTenant[tenantId];
        return (l.root, l.blockNumber, l.eventCount, l.periodEnd);
    }

    /// @notice Check whether a root has been published for a tenant.
    function isPublished(bytes32 tenantId, bytes32 root) external view returns (bool) {
        return _published[tenantId][root];
    }
}
