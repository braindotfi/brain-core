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
        bytes32 indexed tenantId,
        bytes32 root,
        uint256 eventCount,
        uint256 periodStart,
        uint256 periodEnd
    );

    /// @notice Emitted when the publisher is rotated (multi-sig change).
    event PublisherChanged(address indexed oldPublisher, address indexed newPublisher);

    /// @dev The single publisher address. In production this is a Safe
    ///      multi-sig (2-of-3) so a single-key compromise cannot publish.
    address public publisher;

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

    error NotPublisher();
    error RootAlreadyPublished(bytes32 tenantId, bytes32 root);
    error ZeroAddress();
    error InvalidPeriod();

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
    /// @param eventCount  Number of leaves in the tree (sanity bound).
    /// @param periodStart Window start (unix seconds).
    /// @param periodEnd   Window end (unix seconds, inclusive of last event).
    function anchor(
        bytes32 tenantId,
        bytes32 root,
        uint256 eventCount,
        uint256 periodStart,
        uint256 periodEnd
    ) external onlyPublisher {
        if (periodEnd < periodStart) revert InvalidPeriod();
        if (_published[tenantId][root]) revert RootAlreadyPublished(tenantId, root);

        _published[tenantId][root] = true;
        _latestByTenant[tenantId] = Latest({
            root: root,
            blockNumber: block.number,
            eventCount: eventCount,
            periodEnd: periodEnd
        });

        emit AnchorPublished(tenantId, root, eventCount, periodStart, periodEnd);
    }

    /// @notice Rotate the publisher. Only the current publisher can rotate.
    ///         Intended for multi-sig membership changes.
    function setPublisher(address next) external onlyPublisher {
        if (next == address(0)) revert ZeroAddress();
        address prev = publisher;
        publisher = next;
        emit PublisherChanged(prev, next);
    }

    /// @notice Verify that a leaf is included in a root by a Merkle proof.
    /// @dev    Hashing: pair-sort and keccak256. The audit publisher MUST
    ///         use the same order-independent pair hash when it builds
    ///         the tree off-chain.
    function verifyInclusion(bytes32 root, bytes32 leaf, bytes32[] calldata proof) external pure returns (bool) {
        bytes32 computed = leaf;
        uint256 len = proof.length;
        for (uint256 i = 0; i < len; ++i) {
            bytes32 sibling = proof[i];
            if (computed < sibling) {
                computed = keccak256(abi.encodePacked(computed, sibling));
            } else {
                computed = keccak256(abi.encodePacked(sibling, computed));
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
