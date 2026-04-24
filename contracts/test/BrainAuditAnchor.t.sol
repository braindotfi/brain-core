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

    function test_verifyInclusion_singleLeaf() public view {
        bytes32 leaf = keccak256("only");
        bytes32[] memory proof = new bytes32[](0);
        assertTrue(anchor.verifyInclusion(leaf, leaf, proof));
    }

    function test_verifyInclusion_pair() public view {
        bytes32 a = keccak256("a");
        bytes32 b = keccak256("b");
        bytes32 root = a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = b;
        assertTrue(anchor.verifyInclusion(root, a, proof));
        proof[0] = a;
        assertTrue(anchor.verifyInclusion(root, b, proof));
    }

    function test_verifyInclusion_wrongProofFails() public view {
        bytes32 a = keccak256("a");
        bytes32 b = keccak256("b");
        bytes32 root = keccak256(abi.encodePacked(a, b));
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = keccak256("wrong");
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
        bytes32 root = leaf < sibling
            ? keccak256(abi.encodePacked(leaf, sibling))
            : keccak256(abi.encodePacked(sibling, leaf));
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = sibling;
        assertTrue(anchor.verifyInclusion(root, leaf, proof));
    }
}
