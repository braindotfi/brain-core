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

    function test_setPublisher_rotates() public {
        address next = address(0xCAFE);
        vm.prank(publisher);
        anchor.setPublisher(next);
        assertEq(anchor.publisher(), next);
    }

    function test_setPublisher_onlyCurrentPublisher() public {
        vm.prank(nonPublisher);
        vm.expectRevert(BrainAuditAnchor.NotPublisher.selector);
        anchor.setPublisher(address(0xCAFE));
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

    // --- Fuzz ---

    function testFuzz_anchor_idempotentRejection(bytes32 root, uint256 count, uint256 start) public {
        vm.assume(count < 1e12);
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

    // Cross-check: a proof generated OFF-CHAIN by services/audit/src/merkle.ts
    // (4 leaves 0x01..×32 .. 0x04..×32, proof for leaf index 1) must verify here.
    // If this fails, the off-chain hashing scheme has drifted from the contract
    // (the original sha256-vs-keccak bug). Regenerate via the node snippet in
    // merkle.test.ts's PR description if the vector format ever changes.
    function test_verifyInclusion_offChainGeneratedVector() public view {
        bytes32 root = 0x5f50aa8c52d3544957d1d056e67bdf0fddcfa860f877a77fbe73efb6431a1c32;
        bytes32 leaf = 0x0202020202020202020202020202020202020202020202020202020202020202;
        bytes32[] memory proof = new bytes32[](2);
        proof[0] = 0xb11a95f7ddcfbdc542f175f12554edd00d11d2bdc67124e3e3f39f1a1e54bc4a;
        proof[1] = 0x29d5f518fb46bab34823a97ca296fa960582d3960d6fe7d012d3c92f34eccc78;
        assertTrue(anchor.verifyInclusion(root, leaf, proof));

        // Tamper one byte of the leaf → must not verify.
        bytes32 bad = 0x0302020202020202020202020202020202020202020202020202020202020202;
        assertFalse(anchor.verifyInclusion(root, bad, proof));
    }
}
