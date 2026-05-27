// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {BrainReputationRegistry} from "../src/BrainReputationRegistry.sol";
import {IBrainReputationRegistry} from "../src/IBrainReputationRegistry.sol";

contract BrainReputationRegistryTest is Test {
    BrainReputationRegistry internal registry;

    address internal attestor = address(0xA77E5704);
    address internal stranger = address(0xBAD);

    bytes32 internal constant AGENT = keccak256("agent-1");
    bytes32 internal constant ROOT_1 = keccak256("rep-root-1");
    bytes32 internal constant ROOT_2 = keccak256("rep-root-2");

    function setUp() public {
        registry = new BrainReputationRegistry(attestor);
    }

    // --- constructor ---------------------------------------------------------

    function test_constructor_setsAttestor() public view {
        assertEq(registry.attestor(), attestor);
    }

    function test_constructor_emitsAttestorChanged() public {
        vm.expectEmit(true, true, false, false);
        emit IBrainReputationRegistry.AttestorChanged(address(0), attestor);
        new BrainReputationRegistry(attestor);
    }

    function test_constructor_rejectsZeroAttestor() public {
        vm.expectRevert(IBrainReputationRegistry.ZeroAddress.selector);
        new BrainReputationRegistry(address(0));
    }

    // --- publish (happy path) ------------------------------------------------

    function test_publish_recordsPointer() public {
        vm.warp(1_000_000);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IBrainReputationRegistry.ReputationPublished(AGENT, ROOT_1, 1, uint64(block.timestamp));
        vm.prank(attestor);
        registry.publishReputation(AGENT, ROOT_1, 1);

        (bytes32 root, uint64 epoch, uint64 updatedAt) = registry.reputationOf(AGENT);
        assertEq(root, ROOT_1);
        assertEq(epoch, 1);
        assertEq(updatedAt, uint64(block.timestamp));
        assertTrue(registry.hasReputation(AGENT));
    }

    function test_publish_updatesAtHigherEpoch() public {
        vm.startPrank(attestor);
        registry.publishReputation(AGENT, ROOT_1, 1);
        vm.warp(block.timestamp + 5 days);
        registry.publishReputation(AGENT, ROOT_2, 7);
        vm.stopPrank();

        (bytes32 root, uint64 epoch, uint64 updatedAt) = registry.reputationOf(AGENT);
        assertEq(root, ROOT_2);
        assertEq(epoch, 7);
        assertEq(updatedAt, uint64(block.timestamp));
    }

    function test_publish_distinctAgentsAreIndependent() public {
        bytes32 other = keccak256("agent-2");
        vm.startPrank(attestor);
        registry.publishReputation(AGENT, ROOT_1, 3);
        registry.publishReputation(other, ROOT_2, 1);
        vm.stopPrank();

        (bytes32 r1, uint64 e1,) = registry.reputationOf(AGENT);
        (bytes32 r2, uint64 e2,) = registry.reputationOf(other);
        assertEq(r1, ROOT_1);
        assertEq(e1, 3);
        assertEq(r2, ROOT_2);
        assertEq(e2, 1);
    }

    // --- publish (rejections) ------------------------------------------------

    function test_publish_rejectsNonAttestor() public {
        vm.prank(stranger);
        vm.expectRevert(IBrainReputationRegistry.NotAttestor.selector);
        registry.publishReputation(AGENT, ROOT_1, 1);
    }

    function test_publish_rejectsZeroRoot() public {
        vm.prank(attestor);
        vm.expectRevert(IBrainReputationRegistry.ZeroRoot.selector);
        registry.publishReputation(AGENT, bytes32(0), 1);
    }

    function test_publish_rejectsZeroEpochOnFirstPublish() public {
        // First publish with epoch 0 is stale (0 <= current 0).
        vm.prank(attestor);
        vm.expectRevert(abi.encodeWithSelector(IBrainReputationRegistry.StaleEpoch.selector, AGENT, 0, 0));
        registry.publishReputation(AGENT, ROOT_1, 0);
    }

    function test_publish_rejectsEqualEpoch() public {
        vm.startPrank(attestor);
        registry.publishReputation(AGENT, ROOT_1, 5);
        vm.expectRevert(abi.encodeWithSelector(IBrainReputationRegistry.StaleEpoch.selector, AGENT, 5, 5));
        registry.publishReputation(AGENT, ROOT_2, 5);
        vm.stopPrank();
    }

    function test_publish_rejectsLowerEpoch() public {
        vm.startPrank(attestor);
        registry.publishReputation(AGENT, ROOT_1, 5);
        vm.expectRevert(abi.encodeWithSelector(IBrainReputationRegistry.StaleEpoch.selector, AGENT, 3, 5));
        registry.publishReputation(AGENT, ROOT_2, 3);
        vm.stopPrank();
        // State unchanged by the rejected publish.
        (bytes32 root, uint64 epoch,) = registry.reputationOf(AGENT);
        assertEq(root, ROOT_1);
        assertEq(epoch, 5);
    }

    // --- attestor rotation ---------------------------------------------------

    function test_setAttestor_rotates() public {
        address next = address(0xC0FFEE);
        vm.expectEmit(true, true, false, false, address(registry));
        emit IBrainReputationRegistry.AttestorChanged(attestor, next);
        vm.prank(attestor);
        registry.setAttestor(next);
        assertEq(registry.attestor(), next);
    }

    function test_setAttestor_oldAttestorLosesRights_newGains() public {
        address next = address(0xC0FFEE);
        vm.prank(attestor);
        registry.setAttestor(next);

        // old attestor can no longer publish
        vm.prank(attestor);
        vm.expectRevert(IBrainReputationRegistry.NotAttestor.selector);
        registry.publishReputation(AGENT, ROOT_1, 1);

        // new attestor can
        vm.prank(next);
        registry.publishReputation(AGENT, ROOT_1, 1);
        assertTrue(registry.hasReputation(AGENT));
    }

    function test_setAttestor_rejectsNonAttestor() public {
        vm.prank(stranger);
        vm.expectRevert(IBrainReputationRegistry.NotAttestor.selector);
        registry.setAttestor(stranger);
    }

    function test_setAttestor_rejectsZeroAddress() public {
        vm.prank(attestor);
        vm.expectRevert(IBrainReputationRegistry.ZeroAddress.selector);
        registry.setAttestor(address(0));
    }

    // --- views ---------------------------------------------------------------

    function test_unknownAgent_readsZero() public view {
        (bytes32 root, uint64 epoch, uint64 updatedAt) = registry.reputationOf(keccak256("nope"));
        assertEq(root, bytes32(0));
        assertEq(epoch, 0);
        assertEq(updatedAt, 0);
        assertFalse(registry.hasReputation(keccak256("nope")));
    }

    // --- fuzz ----------------------------------------------------------------

    /// @dev A strictly-increasing epoch sequence always stores the latest root +
    ///      epoch; the stored epoch never regresses below a prior publish.
    function testFuzz_strictlyIncreasingEpochsStoreLatest(bytes32 agentId, uint64 e1, uint64 e2, bytes32 root)
        public
    {
        e1 = uint64(bound(e1, 1, type(uint64).max - 1));
        e2 = uint64(bound(e2, uint256(e1) + 1, type(uint64).max));
        vm.assume(root != bytes32(0));

        vm.startPrank(attestor);
        registry.publishReputation(agentId, ROOT_1, e1);
        registry.publishReputation(agentId, root, e2);
        vm.stopPrank();

        (bytes32 storedRoot, uint64 storedEpoch,) = registry.reputationOf(agentId);
        assertEq(storedEpoch, e2);
        assertEq(storedRoot, root);
    }

    /// @dev Any epoch <= the current epoch is rejected (monotonicity).
    function testFuzz_staleEpochAlwaysReverts(uint64 first, uint64 second) public {
        first = uint64(bound(first, 1, type(uint64).max));
        second = uint64(bound(second, 0, first)); // <= current
        vm.startPrank(attestor);
        registry.publishReputation(AGENT, ROOT_1, first);
        vm.expectRevert(abi.encodeWithSelector(IBrainReputationRegistry.StaleEpoch.selector, AGENT, second, first));
        registry.publishReputation(AGENT, ROOT_2, second);
        vm.stopPrank();
    }
}

/// @dev Drives random valid publications across a small agent set so the
///      invariant can assert the stored epoch always equals the max published
///      epoch (never regresses) and the stored root is always the most-recent
///      non-zero root.
contract ReputationHandler is Test {
    BrainReputationRegistry internal registry;
    address internal attestor;
    bytes32[4] public agents;

    mapping(bytes32 => uint64) public ghostEpoch;
    mapping(bytes32 => bytes32) public ghostRoot;

    constructor(BrainReputationRegistry _registry, address _attestor) {
        registry = _registry;
        attestor = _attestor;
        agents[0] = keccak256("inv-agent-0");
        agents[1] = keccak256("inv-agent-1");
        agents[2] = keccak256("inv-agent-2");
        agents[3] = keccak256("inv-agent-3");
    }

    function agentAt(uint256 i) external view returns (bytes32) {
        return agents[i];
    }

    function publish(uint256 agentSeed, uint256 rootSeed, uint64 epochDelta) external {
        bytes32 agentId = agents[bound(agentSeed, 0, agents.length - 1)];
        (, uint64 current,) = registry.reputationOf(agentId);
        // Always strictly increase (bounded) so the publish is valid.
        uint64 delta = uint64(bound(epochDelta, 1, 1_000_000));
        if (current > type(uint64).max - delta) return; // avoid overflow at the ceiling
        uint64 next = current + delta;
        bytes32 root = bytes32(rootSeed | 1); // force non-zero

        vm.prank(attestor);
        registry.publishReputation(agentId, root, next);
        ghostEpoch[agentId] = next;
        ghostRoot[agentId] = root;
    }
}

contract BrainReputationRegistryInvariantTest is Test {
    BrainReputationRegistry internal registry;
    ReputationHandler internal handler;
    address internal attestor = address(0xA77E5704);

    function setUp() public {
        registry = new BrainReputationRegistry(attestor);
        handler = new ReputationHandler(registry, attestor);
        targetContract(address(handler));
    }

    /// @notice Stored epoch == max published epoch per agent (never regresses),
    ///         and the stored root is the most-recent non-zero root.
    function invariant_epochTracksGhostAndRootNonZero() public view {
        for (uint256 i = 0; i < 4; ++i) {
            bytes32 agentId = handler.agentAt(i);
            (bytes32 root, uint64 epoch,) = registry.reputationOf(agentId);
            assertEq(epoch, handler.ghostEpoch(agentId));
            if (epoch != 0) {
                assertEq(root, handler.ghostRoot(agentId));
                assertTrue(root != bytes32(0));
            }
        }
    }
}
