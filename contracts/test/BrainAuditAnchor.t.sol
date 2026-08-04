// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {BrainAuditAnchor} from "../src/BrainAuditAnchor.sol";

contract BrainAuditAnchorTest is Test {
    BrainAuditAnchor internal anchor;
    address internal publisher = address(0xA11CE);
    address internal nonPublisher = address(0xB0B);

    bytes32 internal constant TENANT_A = keccak256("tnt_A");
    bytes32 internal constant TENANT_B = keccak256("tnt_B");

    function setUp() public {
        anchor = new BrainAuditAnchor(publisher);
    }

    function test_constructor_setsPublisher() public view {
        assertEq(anchor.publisher(), publisher);
    }

    function test_constructor_rejectsZero() public {
        vm.expectRevert(BrainAuditAnchor.ZeroAddress.selector);
        new BrainAuditAnchor(address(0));
    }

    function test_anchor_onlyPublisher() public {
        vm.prank(nonPublisher);
        vm.expectRevert(BrainAuditAnchor.NotPublisher.selector);
        anchor.anchor(TENANT_A, keccak256("r"), 1, 0, 1);
    }

    function test_anchor_records_and_emits() public {
        bytes32 root = keccak256("root-1");
        vm.expectEmit(true, false, false, true, address(anchor));
        emit BrainAuditAnchor.AnchorPublished(TENANT_A, root, 7, 100, 200);

        vm.prank(publisher);
        anchor.anchor(TENANT_A, root, 7, 100, 200);

        assertTrue(anchor.isPublished(TENANT_A, root));
        (bytes32 latestRoot, uint256 blk) = anchor.latestAnchor(TENANT_A);
        assertEq(latestRoot, root);
        assertEq(blk, block.number);
    }

    function test_anchor_rejectsDuplicateRoot() public {
        bytes32 root = keccak256("r");
        vm.startPrank(publisher);
        anchor.anchor(TENANT_A, root, 1, 0, 1);
        vm.expectRevert(abi.encodeWithSelector(BrainAuditAnchor.RootAlreadyPublished.selector, TENANT_A, root));
        anchor.anchor(TENANT_A, root, 1, 2, 3);
        vm.stopPrank();
    }

    function test_anchor_sameRootDifferentTenantsOK() public {
        bytes32 root = keccak256("r");
        vm.startPrank(publisher);
        anchor.anchor(TENANT_A, root, 1, 0, 1);
        anchor.anchor(TENANT_B, root, 1, 0, 1);
        vm.stopPrank();
        assertTrue(anchor.isPublished(TENANT_A, root));
        assertTrue(anchor.isPublished(TENANT_B, root));
    }

    function test_anchor_rejectsInvalidPeriod() public {
        vm.prank(publisher);
        vm.expectRevert(BrainAuditAnchor.InvalidPeriod.selector);
        anchor.anchor(TENANT_A, keccak256("r"), 1, 200, 100);
    }

    function test_anchorBatch_recordsAndEmitsEachTenant() public {
        bytes32[] memory tenants = new bytes32[](3);
        tenants[0] = TENANT_A;
        tenants[1] = TENANT_B;
        tenants[2] = keccak256("tnt_C");
        bytes32[] memory roots = new bytes32[](3);
        roots[0] = keccak256("root-a");
        roots[1] = keccak256("root-b");
        roots[2] = keccak256("root-c");
        uint256[] memory counts = new uint256[](3);
        counts[0] = 2;
        counts[1] = 3;
        counts[2] = 4;
        uint256[] memory starts = new uint256[](3);
        starts[0] = 100;
        starts[1] = 110;
        starts[2] = 120;
        uint256[] memory ends = new uint256[](3);
        ends[0] = 101;
        ends[1] = 111;
        ends[2] = 121;

        vm.expectEmit(true, false, false, true, address(anchor));
        emit BrainAuditAnchor.AnchorPublished(tenants[0], roots[0], counts[0], starts[0], ends[0]);
        vm.expectEmit(true, false, false, true, address(anchor));
        emit BrainAuditAnchor.AnchorPublished(tenants[1], roots[1], counts[1], starts[1], ends[1]);
        vm.expectEmit(true, false, false, true, address(anchor));
        emit BrainAuditAnchor.AnchorPublished(tenants[2], roots[2], counts[2], starts[2], ends[2]);

        vm.prank(publisher);
        anchor.anchorBatch(tenants, roots, counts, starts, ends);

        for (uint256 i = 0; i < tenants.length; ++i) {
            assertTrue(anchor.isPublished(tenants[i], roots[i]));
            (bytes32 latestRoot, uint256 blk, uint256 eventCount, uint256 periodEnd) =
                anchor.latestAnchorFull(tenants[i]);
            assertEq(latestRoot, roots[i]);
            assertEq(blk, block.number);
            assertEq(eventCount, counts[i]);
            assertEq(periodEnd, ends[i]);
        }
    }

    function test_anchorBatch_skipsAlreadyPublishedAndPublishesRest() public {
        bytes32 rootA = keccak256("root-a");
        bytes32 rootB = keccak256("root-b");
        vm.prank(publisher);
        anchor.anchor(TENANT_A, rootA, 1, 0, 1);

        bytes32[] memory tenants = new bytes32[](2);
        tenants[0] = TENANT_A;
        tenants[1] = TENANT_B;
        bytes32[] memory roots = new bytes32[](2);
        roots[0] = rootA;
        roots[1] = rootB;
        uint256[] memory counts = new uint256[](2);
        counts[0] = 9;
        counts[1] = 7;
        uint256[] memory starts = new uint256[](2);
        starts[0] = 10;
        starts[1] = 20;
        uint256[] memory ends = new uint256[](2);
        ends[0] = 11;
        ends[1] = 21;

        vm.expectEmit(true, false, false, true, address(anchor));
        emit BrainAuditAnchor.AnchorPublished(TENANT_B, rootB, 7, 20, 21);
        vm.prank(publisher);
        anchor.anchorBatch(tenants, roots, counts, starts, ends);

        (bytes32 latestA,, uint256 countA, uint256 endA) = anchor.latestAnchorFull(TENANT_A);
        assertEq(latestA, rootA);
        assertEq(countA, 1);
        assertEq(endA, 1);
        assertTrue(anchor.isPublished(TENANT_B, rootB));
    }

    function test_anchorBatch_rejectsLengthMismatch() public {
        bytes32[] memory tenants = new bytes32[](1);
        bytes32[] memory roots = new bytes32[](0);
        uint256[] memory counts = new uint256[](1);
        uint256[] memory starts = new uint256[](1);
        uint256[] memory ends = new uint256[](1);
        vm.prank(publisher);
        vm.expectRevert(BrainAuditAnchor.BatchLengthMismatch.selector);
        anchor.anchorBatch(tenants, roots, counts, starts, ends);
    }

    function test_anchorBatch_onlyPublisher() public {
        bytes32[] memory tenants = new bytes32[](1);
        tenants[0] = TENANT_A;
        bytes32[] memory roots = new bytes32[](1);
        roots[0] = keccak256("root");
        uint256[] memory counts = new uint256[](1);
        uint256[] memory starts = new uint256[](1);
        uint256[] memory ends = new uint256[](1);
        ends[0] = 1;
        vm.prank(nonPublisher);
        vm.expectRevert(BrainAuditAnchor.NotPublisher.selector);
        anchor.anchorBatch(tenants, roots, counts, starts, ends);
    }

    function test_anchorBatch_rejectsOverMaxBatch() public {
        uint256 len = anchor.MAX_BATCH() + 1;
        bytes32[] memory tenants = new bytes32[](len);
        bytes32[] memory roots = new bytes32[](len);
        uint256[] memory counts = new uint256[](len);
        uint256[] memory starts = new uint256[](len);
        uint256[] memory ends = new uint256[](len);
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(BrainAuditAnchor.BatchTooLarge.selector, len));
        anchor.anchorBatch(tenants, roots, counts, starts, ends);
    }

    function test_setPublisher_isTwoStep() public {
        address next = address(0xCAFE);
        vm.prank(publisher);
        anchor.setPublisher(next);
        // Rotation does NOT take effect until the new publisher accepts.
        assertEq(anchor.publisher(), publisher);
        assertEq(anchor.pendingPublisher(), next);

        vm.expectEmit(true, true, false, false, address(anchor));
        emit BrainAuditAnchor.PublisherChanged(publisher, next);
        vm.prank(next);
        anchor.acceptPublisher();
        assertEq(anchor.publisher(), next);
        assertEq(anchor.pendingPublisher(), address(0));
    }

    function test_setPublisher_onlyCurrentPublisher() public {
        vm.prank(nonPublisher);
        vm.expectRevert(BrainAuditAnchor.NotPublisher.selector);
        anchor.setPublisher(address(0xCAFE));
    }

    function test_acceptPublisher_onlyPending() public {
        address next = address(0xCAFE);
        vm.prank(publisher);
        anchor.setPublisher(next);
        // A non-pending address cannot accept the role.
        vm.prank(nonPublisher);
        vm.expectRevert(BrainAuditAnchor.NotPendingPublisher.selector);
        anchor.acceptPublisher();
        assertEq(anchor.publisher(), publisher);
    }

    function test_setPublisher_cancel() public {
        address next = address(0xCAFE);
        vm.prank(publisher);
        anchor.setPublisher(next);
        // Cancel the pending rotation by proposing the zero address.
        vm.prank(publisher);
        anchor.setPublisher(address(0));
        assertEq(anchor.pendingPublisher(), address(0));
        // The previously-pending publisher can no longer accept.
        vm.prank(next);
        vm.expectRevert(BrainAuditAnchor.NotPendingPublisher.selector);
        anchor.acceptPublisher();
        assertEq(anchor.publisher(), publisher);
    }

    /// The publisher role still anchors after a completed two-step rotation.
    function test_acceptPublisher_newPublisherCanAnchor() public {
        address next = address(0xCAFE);
        vm.prank(publisher);
        anchor.setPublisher(next);
        vm.prank(next);
        anchor.acceptPublisher();

        // Old publisher is locked out; new publisher can anchor.
        vm.prank(publisher);
        vm.expectRevert(BrainAuditAnchor.NotPublisher.selector);
        anchor.anchor(TENANT_A, keccak256("r"), 1, 0, 1);

        vm.prank(next);
        anchor.anchor(TENANT_A, keccak256("r"), 1, 0, 1);
        assertTrue(anchor.isPublished(TENANT_A, keccak256("r")));
    }

    // --- Merkle verify ---
    // Domain separation scheme: leaf = keccak256(0x00 ++ data),
    // internal node = keccak256(0x01 ++ sort(left, right)).
    // proof[] elements are pre-computed node hashes at each level.

    function _leafHash(bytes32 data) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes1(0x00), data));
    }

    function _nodeHash(bytes32 left, bytes32 right) internal pure returns (bytes32) {
        if (left < right) return keccak256(abi.encodePacked(bytes1(0x01), left, right));
        return keccak256(abi.encodePacked(bytes1(0x01), right, left));
    }

    function test_verifyInclusion_singleLeaf() public view {
        bytes32 leaf = keccak256("only");
        bytes32 root = _leafHash(leaf);
        bytes32[] memory proof = new bytes32[](0);
        assertTrue(anchor.verifyInclusion(root, leaf, proof));
    }

    function test_verifyInclusion_pair() public view {
        bytes32 a = keccak256("a");
        bytes32 b = keccak256("b");
        bytes32 ha = _leafHash(a);
        bytes32 hb = _leafHash(b);
        bytes32 root = _nodeHash(ha, hb);
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = hb; // sibling of a (already leaf-hashed)
        assertTrue(anchor.verifyInclusion(root, a, proof));
        proof[0] = ha; // sibling of b
        assertTrue(anchor.verifyInclusion(root, b, proof));
    }

    function test_verifyInclusion_wrongProofFails() public view {
        bytes32 a = keccak256("a");
        bytes32 b = keccak256("b");
        bytes32 ha = _leafHash(a);
        bytes32 hb = _leafHash(b);
        bytes32 root = _nodeHash(ha, hb);
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = keccak256("wrong"); // not hb
        assertFalse(anchor.verifyInclusion(root, a, proof));
    }

    /// P1.3 invariant: for a valid (root, leaf, proof), mutating any byte of any
    /// input flips verifyInclusion to false (a collision is cryptographically
    /// infeasible). Mirrors the off-chain property test in
    /// services/audit/src/merkle.inclusion.property.test.ts.
    function testFuzz_verifyInclusion_tamperFails(uint8 which, bytes32 delta) public view {
        vm.assume(delta != bytes32(0));
        bytes32 a = keccak256("a");
        bytes32 b = keccak256("b");
        bytes32 ha = _leafHash(a);
        bytes32 hb = _leafHash(b);
        bytes32 root = _nodeHash(ha, hb);
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = hb;

        // The untampered proof verifies.
        assertTrue(anchor.verifyInclusion(root, a, proof));

        // Mutating exactly one of {root, leaf, proof element} breaks it.
        uint8 sel = which % 3;
        if (sel == 0) {
            assertFalse(anchor.verifyInclusion(root ^ delta, a, proof));
        } else if (sel == 1) {
            assertFalse(anchor.verifyInclusion(root, a ^ delta, proof));
        } else {
            proof[0] = hb ^ delta;
            assertFalse(anchor.verifyInclusion(root, a, proof));
        }
    }

    // --- Fuzz ---

    function testFuzz_anchor_idempotentRejection(bytes32 root, uint256 count, uint256 start) public {
        // eventCount 0 is now rejected outright: an empty window has nothing to
        // prove and its root is a constant, which would burn the (tenant, root)
        // slot for every future empty window.
        vm.assume(count != 0 && count < 1e12);
        vm.assume(start < 1e10);
        vm.startPrank(publisher);
        anchor.anchor(TENANT_A, root, count, start, start + 1);
        vm.expectRevert(abi.encodeWithSelector(BrainAuditAnchor.RootAlreadyPublished.selector, TENANT_A, root));
        anchor.anchor(TENANT_A, root, count + 1, start + 10, start + 11);
        vm.stopPrank();
    }

    function testFuzz_verify_roundTrip(bytes32 leaf, bytes32 sibling) public view {
        bytes32 hl = _leafHash(leaf);
        bytes32 hs = _leafHash(sibling);
        bytes32 root = _nodeHash(hl, hs);
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = hs; // sibling leaf hash
        assertTrue(anchor.verifyInclusion(root, leaf, proof));
    }

    // --- Leaf-count binding ------------------------------------------------
    //
    // Vectors below are generated by services/audit/src/merkle.ts over leaves
    // 0x01..x32 .. 0x0N..x32. They are the cross-language pin: if either side of
    // the scheme drifts (the original sha256-vs-keccak bug, or the count leaf
    // being dropped from one implementation) these stop matching.
    // Regenerate with buildTree / makeProof / makeCountProof / countLeaf.

    bytes32 internal constant LEAF_1 = 0x0101010101010101010101010101010101010101010101010101010101010101;
    bytes32 internal constant LEAF_2 = 0x0202020202020202020202020202020202020202020202020202020202020202;
    bytes32 internal constant ROOT_3 = 0x2fa7ac6b90efb497cf9d8cbe2aca1c10c4cef781ca3a8d6738c8fe66d1833a17;
    bytes32 internal constant ROOT_4 = 0x7598f950100f29a6dd250e4a6f48d13305f85eebfca5135c4046b20b7ff38dab;
    /// @dev buildTree([L1, L2, L3, L3]) — the duplicate-trailing-node forgery.
    bytes32 internal constant ROOT_ABCC = 0x5733e97b922349659de080eb7d17372c278034cb00b3db53ec7b0c24ea18f355;

    /// The count leaf must be byte-identical in Solidity and TypeScript, or
    /// nothing else here holds. Pinned on both sides (merkle.test.ts).
    function test_countLeaf_matchesOffChainVector() public view {
        assertEq(anchor.countLeaf(3), 0x9bf4b76acb5ce3bc1fcfdbc898180cc4e30dc22357dc60045998591084e76d59);
        assertEq(anchor.countLeaf(4), 0xaa0ed86d9ad2fd8bad3f28dbab649a90fbf023704784aed9c3d20335a174f2d7);
    }

    // Cross-check: a proof generated OFF-CHAIN by services/audit/src/merkle.ts
    // (4 leaves, proof for event leaf index 1) must verify here.
    function test_verifyInclusion_offChainGeneratedVector() public view {
        bytes32[] memory proof = new bytes32[](3);
        proof[0] = 0x4f02043ddc57fe1c114cbe5e5c72ff6ec6254c9fcef42ea9cd55a05dd82d27aa;
        proof[1] = 0x8349b973cfde3f5a7800ad0e0d7cdef9658811e31220276feefdd97fd5ad1d93;
        proof[2] = 0xc9fb54b93905eec828f614ad1ea66bd2b9691c16ebc0197d27d4837af754342b;
        assertTrue(anchor.verifyInclusion(ROOT_4, LEAF_2, proof));

        // Tamper one byte of the leaf → must not verify.
        bytes32 bad = 0x0302020202020202020202020202020202020202020202020202020202020202;
        assertFalse(anchor.verifyInclusion(ROOT_4, bad, proof));
    }

    /// The published root commits to the leaf COUNT, provable on-chain from the
    /// eventCount this contract stores.
    function test_verifyInclusion_countLeafIsProvableAgainstTheRoot() public view {
        bytes32[] memory proof = new bytes32[](3);
        proof[0] = 0xb11a95f7ddcfbdc542f175f12554edd00d11d2bdc67124e3e3f39f1a1e54bc4a;
        proof[1] = 0xa5bc7280b6113eca92b40283cc52f5967e550f8413a3bd42c0b2d4e26532b326;
        proof[2] = 0xc9fb54b93905eec828f614ad1ea66bd2b9691c16ebc0197d27d4837af754342b;
        assertTrue(anchor.verifyInclusion(ROOT_4, anchor.countLeaf(4), proof));
        // The same proof cannot re-label the window as any other size.
        assertFalse(anchor.verifyInclusion(ROOT_4, anchor.countLeaf(3), proof));
        assertFalse(anchor.verifyInclusion(ROOT_4, anchor.countLeaf(5), proof));
    }

    /// The completeness gap itself: [A,B,C] and [A,B,C,C] used to fold to the
    /// SAME root, so an anchor claiming eventCount = 4 over a 3-event window was
    /// on-chain indistinguishable from a genuine 4-leaf window.
    function test_root_distinguishesDuplicateTrailingLeafForgery() public pure {
        assertTrue(ROOT_3 != ROOT_ABCC);
    }

    /// A 3-event window's own proofs verify under its own root and NOT under the
    /// forged 4-leaf root claiming to cover the same events.
    function test_verifyInclusion_threeLeafWindowVector() public view {
        bytes32[] memory proof = new bytes32[](2);
        proof[0] = 0x4f02043ddc57fe1c114cbe5e5c72ff6ec6254c9fcef42ea9cd55a05dd82d27aa;
        proof[1] = 0x0d5bf192b6daf2b29c4d7a69bd3945e9a93a887ef90f8b7c55f9c3dbc2160756;
        assertTrue(anchor.verifyInclusion(ROOT_3, LEAF_2, proof));
        assertFalse(anchor.verifyInclusion(ROOT_ABCC, LEAF_2, proof));

        bytes32[] memory countProof = new bytes32[](2);
        countProof[0] = 0xb11a95f7ddcfbdc542f175f12554edd00d11d2bdc67124e3e3f39f1a1e54bc4a;
        countProof[1] = 0xa5bc7280b6113eca92b40283cc52f5967e550f8413a3bd42c0b2d4e26532b326;
        assertTrue(anchor.verifyInclusion(ROOT_3, anchor.countLeaf(3), countProof));
        assertFalse(anchor.verifyInclusion(ROOT_3, anchor.countLeaf(4), countProof));
        assertTrue(LEAF_1 != LEAF_2);
    }

    // --- Anchor bookkeeping ------------------------------------------------

    function test_anchor_rejectsZeroEventCount() public {
        vm.prank(publisher);
        vm.expectRevert(BrainAuditAnchor.EmptyAnchor.selector);
        anchor.anchor(TENANT_A, keccak256("empty"), 0, 100, 200);
    }

    function test_anchorBatch_rejectsZeroEventCount() public {
        bytes32[] memory ids = new bytes32[](1);
        bytes32[] memory roots = new bytes32[](1);
        uint256[] memory counts = new uint256[](1);
        uint256[] memory starts = new uint256[](1);
        uint256[] memory ends = new uint256[](1);
        ids[0] = TENANT_A;
        roots[0] = keccak256("empty-batch");
        counts[0] = 0;
        starts[0] = 100;
        ends[0] = 200;
        vm.prank(publisher);
        vm.expectRevert(BrainAuditAnchor.EmptyAnchor.selector);
        anchor.anchorBatch(ids, roots, counts, starts, ends);
    }

    /// Publication order is not chronological (retries, backfills, catch-up
    /// batches). An older window must be recorded and emitted but must NOT
    /// regress the "latest" pointer a third party reads as current.
    function test_recordLatest_staleAnchorDoesNotRegressLatest() public {
        bytes32 newRoot = keccak256("new");
        bytes32 oldRoot = keccak256("old");
        vm.startPrank(publisher);
        anchor.anchor(TENANT_A, newRoot, 10, 1000, 2000);
        anchor.anchor(TENANT_A, oldRoot, 3, 100, 200);
        vm.stopPrank();

        (bytes32 root,, uint256 eventCount, uint256 periodEnd) = anchor.latestAnchorFull(TENANT_A);
        assertEq(root, newRoot);
        assertEq(eventCount, 10);
        assertEq(periodEnd, 2000);
        // The stale anchor is still recorded, just not "latest".
        assertTrue(anchor.isPublished(TENANT_A, oldRoot));
    }

    /// An equal periodEnd DOES advance (>= is deliberate): a same-window retry
    /// with a corrected root must be able to replace the pointer.
    function test_recordLatest_equalPeriodEndAdvances() public {
        bytes32 first = keccak256("first");
        bytes32 second = keccak256("second");
        vm.startPrank(publisher);
        anchor.anchor(TENANT_A, first, 4, 100, 200);
        anchor.anchor(TENANT_A, second, 5, 100, 200);
        vm.stopPrank();

        (bytes32 root,, uint256 eventCount,) = anchor.latestAnchorFull(TENANT_A);
        assertEq(root, second);
        assertEq(eventCount, 5);
    }
}
