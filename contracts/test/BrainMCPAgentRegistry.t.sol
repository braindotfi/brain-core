// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {BrainMCPAgentRegistry} from "../src/BrainMCPAgentRegistry.sol";

contract BrainMCPAgentRegistryTest is Test {
    BrainMCPAgentRegistry internal registry;
    bytes32 internal constant TENANT = keccak256("tnt_test");
    bytes32 internal constant BEHAVIOR = keccak256("behavior.v1");
    bytes32 internal constant AGENT_ID = keccak256("quorum_agent");
    bytes32 internal constant SCOPE = keccak256("quorum_scope");
    uint256 internal adminPk = 0xA11CE;
    uint256 internal signerPk = 0xB0B;
    uint256 internal signerPk2 = 0xB0B2;
    uint256 internal signerPk3 = 0xC0FFEE;
    uint256 internal externalPk = 0xCA75;
    address internal admin;
    address internal signer;
    address internal signer2;
    address internal signer3;

    function setUp() public {
        admin = vm.addr(adminPk);
        signer = vm.addr(signerPk);
        signer2 = vm.addr(signerPk2);
        signer3 = vm.addr(signerPk3);
        registry = new BrainMCPAgentRegistry(admin);
    }

    function _domainSep() internal view returns (bytes32) {
        return registry.domainSeparator();
    }

    function _signerChangeDigest(address s, bool allowed, uint256 nonce) internal view returns (bytes32) {
        bytes32 typeHash = keccak256("TenantSignerChange(bytes32 tenantId,address signer,bool allowed,uint256 nonce)");
        bytes32 structHash = keccak256(abi.encode(typeHash, TENANT, s, allowed, nonce));
        return keccak256(abi.encodePacked(hex"1901", _domainSep(), structHash));
    }

    function _regDigest(bytes32 agentId, address addr, bytes32 scope) internal view returns (bytes32) {
        bytes32 typeHash = keccak256(
            "AgentRegistration(bytes32 agentId,address agentAddress,bytes32 tenantId,bytes32 scopeHash,bytes32 behaviorHash)"
        );
        bytes32 structHash = keccak256(abi.encode(typeHash, agentId, addr, TENANT, scope, BEHAVIOR));
        return keccak256(abi.encodePacked(hex"1901", _domainSep(), structHash));
    }

    function _revDigest(bytes32 agentId) internal view returns (bytes32) {
        bytes32 typeHash = keccak256("AgentRevocation(bytes32 agentId,bytes32 tenantId,uint256 nonce)");
        bytes32 structHash = keccak256(abi.encode(typeHash, agentId, TENANT, registry.revocationNonce(agentId)));
        return keccak256(abi.encodePacked(hex"1901", _domainSep(), structHash));
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _bootstrapSigner(address s) internal {
        // Admin signs the very first signer for TENANT.
        bytes memory adminSig = _sign(adminPk, _signerChangeDigest(s, true, 0));
        registry.setTenantSigner(TENANT, s, true, admin, adminSig);
    }

    function _thresholdDigest(uint256 threshold, uint256 nonce) internal view returns (bytes32) {
        bytes32 typeHash = keccak256("TenantThresholdChange(bytes32 tenantId,uint256 threshold,uint256 nonce)");
        bytes32 structHash = keccak256(abi.encode(typeHash, TENANT, threshold, nonce));
        return keccak256(abi.encodePacked(hex"1901", _domainSep(), structHash));
    }

    function _scopeDigest(bytes32 agentId, bytes32 scope) internal view returns (bytes32) {
        bytes32 typeHash =
            keccak256("AgentScopeUpdate(bytes32 agentId,bytes32 tenantId,bytes32 scopeHash,uint256 nonce)");
        bytes32 structHash = keccak256(abi.encode(typeHash, agentId, TENANT, scope, registry.scopeNonce(agentId)));
        return keccak256(abi.encodePacked(hex"1901", _domainSep(), structHash));
    }

    /// @dev Add a signer while the tenant threshold is still 1.
    function _addSigner(address s) internal {
        uint256 n = registry.signerNonce(TENANT);
        registry.setTenantSigner(TENANT, s, true, signer, _sign(signerPk, _signerChangeDigest(s, true, n)));
    }

    /// @dev Seat signer2 and signer3 and move TENANT to a genuine 3-of-3 posture.
    function _make3of3() internal {
        _bootstrapSigner(signer);
        _addSigner(signer2);
        _addSigner(signer3);
        // Threshold is still the default 1 here, so one signature may raise it.
        uint256 n = registry.signerNonce(TENANT);
        registry.setTenantThreshold(TENANT, 3, signer, _sign(signerPk, _thresholdDigest(3, n)));
        assertEq(registry.thresholdOf(TENANT), 3);
    }

    /// @dev Sort (pk, address) pairs ascending by address, as the registry's
    ///      strict-ordering uniqueness rule requires, then sign `digest`.
    function _quorum(uint256[] memory pks, address[] memory addrs, bytes32 digest)
        internal
        pure
        returns (address[] memory signers, bytes[] memory signatures)
    {
        for (uint256 i = 1; i < addrs.length; ++i) {
            for (uint256 j = i; j > 0 && addrs[j] < addrs[j - 1]; --j) {
                (addrs[j], addrs[j - 1]) = (addrs[j - 1], addrs[j]);
                (pks[j], pks[j - 1]) = (pks[j - 1], pks[j]);
            }
        }
        signatures = new bytes[](addrs.length);
        for (uint256 i = 0; i < addrs.length; ++i) {
            signatures[i] = _sign(pks[i], digest);
        }
        signers = addrs;
    }

    /// @dev A 3-of-3 tenant with one live agent registered before the threshold
    ///      was raised — the shape an attacker with one key would find.
    function _make3of3WithLiveAgent() internal {
        _bootstrapSigner(signer);
        _addSigner(signer2);
        _addSigner(signer3);
        address a = vm.addr(externalPk);
        registry.registerAgent(
            AGENT_ID, a, TENANT, SCOPE, BEHAVIOR, signer, _sign(signerPk, _regDigest(AGENT_ID, a, SCOPE))
        );
        uint256 n = registry.signerNonce(TENANT);
        registry.setTenantThreshold(TENANT, 3, signer, _sign(signerPk, _thresholdDigest(3, n)));
        assertEq(registry.thresholdOf(TENANT), 3);
    }

    /// @dev The full 3-of-3 quorum over `digest`.
    function _quorum3(bytes32 digest) internal view returns (address[] memory signers, bytes[] memory signatures) {
        uint256[] memory pks = new uint256[](3);
        address[] memory addrs = new address[](3);
        (pks[0], addrs[0]) = (signerPk, signer);
        (pks[1], addrs[1]) = (signerPk2, signer2);
        (pks[2], addrs[2]) = (signerPk3, signer3);
        return _quorum(pks, addrs, digest);
    }

    function test_register_rejectsWithoutTenantSigner() public {
        bytes32 agentId = keccak256("agent");
        bytes memory sig = _sign(externalPk, _regDigest(agentId, vm.addr(externalPk), keccak256("scope")));
        vm.expectRevert();
        registry.registerAgent(
            agentId, vm.addr(externalPk), TENANT, keccak256("scope"), BEHAVIOR, vm.addr(externalPk), sig
        );
    }

    function test_register_happyPath() public {
        _bootstrapSigner(signer);
        bytes32 agentId = keccak256("agent");
        bytes32 scope = keccak256("scope.v1");
        address agentAddr = vm.addr(externalPk);

        bytes memory sig = _sign(signerPk, _regDigest(agentId, agentAddr, scope));
        registry.registerAgent(agentId, agentAddr, TENANT, scope, BEHAVIOR, signer, sig);

        assertTrue(registry.isAuthorized(agentId, TENANT));
        BrainMCPAgentRegistry.AgentRegistration memory reg = registry.getAgent(agentId);
        assertEq(reg.agentAddress, agentAddr);
        assertEq(reg.scopeHash, scope);
        assertEq(reg.behaviorHash, BEHAVIOR);
    }

    function test_admin_backdoor_closed() public {
        _bootstrapSigner(signer);
        // After first signer is set, admin can no longer set signers.
        address secondSigner = vm.addr(0x1234);
        bytes memory adminSig = _sign(adminPk, _signerChangeDigest(secondSigner, true, 1));
        vm.expectRevert(abi.encodeWithSelector(BrainMCPAgentRegistry.NotTenantSigner.selector, admin));
        registry.setTenantSigner(TENANT, secondSigner, true, admin, adminSig);
    }

    function test_register_rejectsDuplicate() public {
        _bootstrapSigner(signer);
        bytes32 agentId = keccak256("agent");
        bytes32 scope = keccak256("scope");
        address a = vm.addr(externalPk);
        bytes memory sig = _sign(signerPk, _regDigest(agentId, a, scope));
        registry.registerAgent(agentId, a, TENANT, scope, BEHAVIOR, signer, sig);
        vm.expectRevert(abi.encodeWithSelector(BrainMCPAgentRegistry.AgentAlreadyRegistered.selector, agentId));
        registry.registerAgent(agentId, a, TENANT, scope, BEHAVIOR, signer, sig);
    }

    function test_revoke_happyPath() public {
        _bootstrapSigner(signer);
        bytes32 agentId = keccak256("agent");
        bytes32 scope = keccak256("scope");
        address a = vm.addr(externalPk);
        bytes memory regSig = _sign(signerPk, _regDigest(agentId, a, scope));
        registry.registerAgent(agentId, a, TENANT, scope, BEHAVIOR, signer, regSig);

        bytes memory revSig = _sign(signerPk, _revDigest(agentId));
        registry.revokeAgent(agentId, signer, revSig);
        assertFalse(registry.isAuthorized(agentId, TENANT));
        assertEq(registry.revocationNonce(agentId), 1);
    }

    function test_admin_can_rebootstrap_after_lockout() public {
        _bootstrapSigner(signer);
        // signer revokes themselves (nonce is 1 after bootstrap)
        bytes memory revSig = _sign(signerPk, _signerChangeDigest(signer, false, 1));
        registry.setTenantSigner(TENANT, signer, false, signer, revSig);
        assertFalse(registry.isTenantSigner(TENANT, signer));
        // admin can now re-bootstrap because active signer count is 0 (nonce=2)
        address newSigner = vm.addr(0x9999);
        bytes memory adminSig = _sign(adminPk, _signerChangeDigest(newSigner, true, 2));
        registry.setTenantSigner(TENANT, newSigner, true, admin, adminSig);
        assertTrue(registry.isTenantSigner(TENANT, newSigner));
    }

    function test_invariant_scopeHashEqualsStored() public {
        _bootstrapSigner(signer);
        for (uint256 i = 0; i < 5; ++i) {
            bytes32 agentId = keccak256(abi.encodePacked("a", i));
            bytes32 scope = keccak256(abi.encodePacked("s", i));
            address a = address(uint160(i + 1));
            bytes memory sig = _sign(signerPk, _regDigest(agentId, a, scope));
            registry.registerAgent(agentId, a, TENANT, scope, BEHAVIOR, signer, sig);
            BrainMCPAgentRegistry.AgentRegistration memory reg = registry.getAgent(agentId);
            assertEq(reg.scopeHash, scope);
            assertEq(reg.agentAddress, a);
        }
    }

    function _behaviorDigest(bytes32 agentId, bytes32 behaviorHash) internal view returns (bytes32) {
        bytes32 typeHash =
            keccak256("AgentBehaviorUpdate(bytes32 agentId,bytes32 tenantId,bytes32 behaviorHash,uint256 nonce)");
        bytes32 structHash =
            keccak256(abi.encode(typeHash, agentId, TENANT, behaviorHash, registry.behaviorNonce(agentId)));
        return keccak256(abi.encodePacked(hex"1901", _domainSep(), structHash));
    }

    function _behaviorDigestWithNonce(bytes32 agentId, bytes32 behaviorHash, uint256 nonce)
        internal
        view
        returns (bytes32)
    {
        bytes32 typeHash =
            keccak256("AgentBehaviorUpdate(bytes32 agentId,bytes32 tenantId,bytes32 behaviorHash,uint256 nonce)");
        bytes32 structHash = keccak256(abi.encode(typeHash, agentId, TENANT, behaviorHash, nonce));
        return keccak256(abi.encodePacked(hex"1901", _domainSep(), structHash));
    }

    function test_updateBehaviorHash_reattests() public {
        _bootstrapSigner(signer);
        bytes32 agentId = keccak256("agent");
        bytes32 scope = keccak256("scope");
        address a = vm.addr(externalPk);
        registry.registerAgent(
            agentId, a, TENANT, scope, BEHAVIOR, signer, _sign(signerPk, _regDigest(agentId, a, scope))
        );
        assertEq(registry.getAgent(agentId).behaviorHash, BEHAVIOR);

        // Promote to a new behavior with a fresh tenant-signed attestation.
        bytes32 next = keccak256("behavior.v2");
        registry.updateBehaviorHash(agentId, next, signer, _sign(signerPk, _behaviorDigest(agentId, next)));
        assertEq(registry.getAgent(agentId).behaviorHash, next);
        assertEq(registry.behaviorNonce(agentId), 1);
    }

    function test_updateBehaviorHash_rejectsCapturedHistoricalSignatureReplay() public {
        _bootstrapSigner(signer);
        bytes32 agentId = keccak256("agent");
        bytes32 scope = keccak256("scope");
        address a = vm.addr(externalPk);
        registry.registerAgent(
            agentId, a, TENANT, scope, BEHAVIOR, signer, _sign(signerPk, _regDigest(agentId, a, scope))
        );

        bytes32 older = keccak256("behavior.old");
        bytes memory olderSig = _sign(signerPk, _behaviorDigestWithNonce(agentId, older, 0));
        registry.updateBehaviorHash(agentId, older, signer, olderSig);
        assertEq(registry.getAgent(agentId).behaviorHash, older);
        assertEq(registry.behaviorNonce(agentId), 1);

        bytes32 newer = keccak256("behavior.new");
        registry.updateBehaviorHash(agentId, newer, signer, _sign(signerPk, _behaviorDigest(agentId, newer)));
        assertEq(registry.getAgent(agentId).behaviorHash, newer);
        assertEq(registry.behaviorNonce(agentId), 2);

        vm.expectRevert();
        registry.updateBehaviorHash(agentId, older, signer, olderSig);
        assertEq(registry.getAgent(agentId).behaviorHash, newer);
    }

    function test_updateBehaviorHash_rejectsNonSigner() public {
        _bootstrapSigner(signer);
        bytes32 agentId = keccak256("agent");
        bytes32 scope = keccak256("scope");
        address a = vm.addr(externalPk);
        registry.registerAgent(
            agentId, a, TENANT, scope, BEHAVIOR, signer, _sign(signerPk, _regDigest(agentId, a, scope))
        );
        bytes32 next = keccak256("behavior.v2");
        // Compute the signature BEFORE expectRevert: _behaviorDigest() makes an
        // external call (registry.domainSeparator()), and a bare expectRevert
        // binds to the NEXT external call — computing the arg inline would bind
        // the cheatcode to domainSeparator() (which never reverts) instead of to
        // updateBehaviorHash. (Matches the sig-before-expectRevert pattern used
        // by the other reject tests.)
        bytes memory sig = _sign(externalPk, _behaviorDigest(agentId, next));
        // externalPk is not a tenant signer → reject.
        vm.expectRevert(abi.encodeWithSelector(BrainMCPAgentRegistry.NotTenantSigner.selector, a));
        registry.updateBehaviorHash(agentId, next, a, sig);
    }

    // --- M-of-N quorum on signer-set and threshold changes ----------------

    function test_thresholdOf_unsetReadsAsOne() public view {
        assertEq(registry.thresholdOf(keccak256("never_configured")), 1);
    }

    /// @notice Single-signer tenants (threshold unset) keep working through the
    ///         retained single-signature overloads.
    function test_singleSignerTenant_unaffected() public {
        _bootstrapSigner(signer);
        assertEq(registry.thresholdOf(TENANT), 1);
        _addSigner(signer2);
        assertTrue(registry.isTenantSigner(TENANT, signer2));
        assertEq(registry.tenantSignerCount(TENANT), 2);

        bytes32 agentId = keccak256("agent");
        bytes32 scope = keccak256("scope");
        address a = vm.addr(externalPk);
        registry.registerAgent(
            agentId, a, TENANT, scope, BEHAVIOR, signer, _sign(signerPk, _regDigest(agentId, a, scope))
        );
        assertTrue(registry.isAuthorized(agentId, TENANT));
    }

    /// @notice One compromised key of a 3-of-3 tenant cannot lower the threshold
    ///         and cannot seat attacker-controlled co-signers — the two moves that
    ///         would otherwise make every other quorum check worthless.
    function test_quorum_singleCompromisedKeyCannotWeakenTheTenant() public {
        _make3of3();
        uint256 n = registry.signerNonce(TENANT);
        address rogue = vm.addr(0xDEAD2);
        bytes memory lowerSig = _sign(signerPk, _thresholdDigest(1, n));
        bytes memory seatSig = _sign(signerPk, _signerChangeDigest(rogue, true, n));
        bytes memory below = abi.encodeWithSelector(BrainMCPAgentRegistry.BelowThreshold.selector, TENANT, 1, 3);

        vm.expectRevert(below);
        registry.setTenantThreshold(TENANT, 1, signer, lowerSig);

        vm.expectRevert(below);
        registry.setTenantSigner(TENANT, rogue, true, signer, seatSig);

        assertEq(registry.thresholdOf(TENANT), 3);
        assertFalse(registry.isTenantSigner(TENANT, rogue));
    }

    /// @notice A single key of a 3-of-3 tenant cannot register an
    ///         attacker-controlled agent. Gate check 5.5 attests any registered,
    ///         non-revoked agent regardless of registering tenant, so this is the
    ///         mint that every tenant's money path would honor.
    function test_quorum_singleCompromisedKeyCannotRegisterAgent() public {
        _make3of3();
        address rogue = vm.addr(0xDEAD2);
        bytes32 rogueAgent = keccak256("rogue-agent");
        bytes memory regSig = _sign(signerPk, _regDigest(rogueAgent, rogue, SCOPE));

        vm.expectRevert(abi.encodeWithSelector(BrainMCPAgentRegistry.BelowThreshold.selector, TENANT, 1, 3));
        registry.registerAgent(rogueAgent, rogue, TENANT, SCOPE, BEHAVIOR, signer, regSig);
        assertFalse(registry.isAuthorized(rogueAgent, TENANT));
    }

    /// @notice A single key of a 3-of-3 tenant cannot silently re-scope a live
    ///         agent.
    function test_quorum_singleCompromisedKeyCannotRescopeAgent() public {
        _make3of3WithLiveAgent();
        bytes32 attackerScope = keccak256("scope.attacker");
        bytes memory scopeSig = _sign(signerPk, _scopeDigest(AGENT_ID, attackerScope));

        vm.expectRevert(abi.encodeWithSelector(BrainMCPAgentRegistry.BelowThreshold.selector, TENANT, 1, 3));
        registry.updateScopeHash(AGENT_ID, attackerScope, signer, scopeSig);
        assertEq(registry.getAgent(AGENT_ID).scopeHash, SCOPE);
    }

    /// @notice A single key of a 3-of-3 tenant cannot revoke a legitimate agent.
    ///         Revocation is terminal, so this is unrecoverable denial of service.
    function test_quorum_singleCompromisedKeyCannotRevokeAgent() public {
        _make3of3WithLiveAgent();
        bytes memory revSig = _sign(signerPk, _revDigest(AGENT_ID));

        vm.expectRevert(abi.encodeWithSelector(BrainMCPAgentRegistry.BelowThreshold.selector, TENANT, 1, 3));
        registry.revokeAgent(AGENT_ID, signer, revSig);
        assertTrue(registry.isAuthorized(AGENT_ID, TENANT));
    }

    /// @notice A single key of a 3-of-3 tenant cannot re-attest an agent's pinned
    ///         behavior hash (§6 gate check 1.5).
    function test_quorum_singleCompromisedKeyCannotUpdateBehavior() public {
        _make3of3WithLiveAgent();
        bytes32 next = keccak256("behavior.attacker");
        bytes memory sig = _sign(signerPk, _behaviorDigest(AGENT_ID, next));

        vm.expectRevert(abi.encodeWithSelector(BrainMCPAgentRegistry.BelowThreshold.selector, TENANT, 1, 3));
        registry.updateBehaviorHash(AGENT_ID, next, signer, sig);
        assertEq(registry.getAgent(AGENT_ID).behaviorHash, BEHAVIOR);
    }

    /// @notice The array forms are the working path for an M-of-N tenant:
    ///         register, re-scope and revoke all succeed under a full quorum.
    function test_quorum_fullQuorumDrivesTheAgentLifecycle() public {
        _make3of3();
        address a = vm.addr(externalPk);
        (address[] memory qs, bytes[] memory qsig) = _quorum3(_regDigest(AGENT_ID, a, SCOPE));
        registry.registerAgent(AGENT_ID, a, TENANT, SCOPE, BEHAVIOR, qs, qsig);
        assertTrue(registry.isAuthorized(AGENT_ID, TENANT));

        bytes32 next = keccak256("scope.v2");
        (qs, qsig) = _quorum3(_scopeDigest(AGENT_ID, next));
        registry.updateScopeHash(AGENT_ID, next, qs, qsig);
        assertEq(registry.getAgent(AGENT_ID).scopeHash, next);

        (qs, qsig) = _quorum3(_revDigest(AGENT_ID));
        registry.revokeAgent(AGENT_ID, qs, qsig);
        assertFalse(registry.isAuthorized(AGENT_ID, TENANT));
    }

    function test_quorum_fullQuorumUpdatesBehaviorHash() public {
        _make3of3WithLiveAgent();
        bytes32 next = keccak256("behavior.v2");
        (address[] memory qs, bytes[] memory qsig) = _quorum3(_behaviorDigest(AGENT_ID, next));
        registry.updateBehaviorHash(AGENT_ID, next, qs, qsig);
        assertEq(registry.getAgent(AGENT_ID).behaviorHash, next);
    }

    /// @notice One key cannot pad itself to quorum size: distinctness is enforced
    ///         by strict ascending order.
    function test_quorum_rejectsRepeatedSigner() public {
        _make3of3();
        address a = vm.addr(externalPk);
        bytes memory sig = _sign(signerPk, _regDigest(AGENT_ID, a, SCOPE));
        address[] memory qs = new address[](3);
        bytes[] memory qsig = new bytes[](3);
        for (uint256 i = 0; i < 3; ++i) {
            qs[i] = signer;
            qsig[i] = sig;
        }

        vm.expectRevert(abi.encodeWithSelector(BrainMCPAgentRegistry.DuplicateSigner.selector, signer));
        registry.registerAgent(AGENT_ID, a, TENANT, SCOPE, BEHAVIOR, qs, qsig);
    }

    function test_setTenantThreshold_lowersWithFullQuorum() public {
        _make3of3();
        uint256 n = registry.signerNonce(TENANT);
        (address[] memory qs, bytes[] memory qsig) = _quorum3(_thresholdDigest(1, n));

        registry.setTenantThreshold(TENANT, 1, qs, qsig);
        assertEq(registry.thresholdOf(TENANT), 1);
    }

    function test_setTenantSigner_addsWithFullQuorum() public {
        _make3of3();
        address extra = vm.addr(0x4444);
        uint256 n = registry.signerNonce(TENANT);
        (address[] memory qs, bytes[] memory qsig) = _quorum3(_signerChangeDigest(extra, true, n));

        registry.setTenantSigner(TENANT, extra, true, qs, qsig);
        assertTrue(registry.isTenantSigner(TENANT, extra));
        assertEq(registry.tenantSignerCount(TENANT), 4);
    }

    /// @notice A quorum-authorized removal still cannot strand the tenant below
    ///         its own threshold.
    function test_setTenantSigner_quorumCannotStrandBelowThreshold() public {
        _make3of3();
        uint256 n = registry.signerNonce(TENANT);
        (address[] memory qs, bytes[] memory qsig) = _quorum3(_signerChangeDigest(signer3, false, n));

        vm.expectRevert(abi.encodeWithSelector(BrainMCPAgentRegistry.ThresholdWouldExceedSigners.selector, 2, 3));
        registry.setTenantSigner(TENANT, signer3, false, qs, qsig);
    }

    function test_setTenantThreshold_rejectsZeroAndAboveSignerCount() public {
        _bootstrapSigner(signer);
        _addSigner(signer2);
        uint256 n = registry.signerNonce(TENANT);
        bytes memory zeroSig = _sign(signerPk, _thresholdDigest(0, n));
        bytes memory tooHighSig = _sign(signerPk, _thresholdDigest(3, n));

        vm.expectRevert(abi.encodeWithSelector(BrainMCPAgentRegistry.InvalidThreshold.selector, 0, 2));
        registry.setTenantThreshold(TENANT, 0, signer, zeroSig);

        vm.expectRevert(abi.encodeWithSelector(BrainMCPAgentRegistry.InvalidThreshold.selector, 3, 2));
        registry.setTenantThreshold(TENANT, 3, signer, tooHighSig);
    }

    function test_setTenantThreshold_rejectsNonSigner() public {
        _bootstrapSigner(signer);
        address rogue = vm.addr(0xDEAD3);
        uint256 n = registry.signerNonce(TENANT);
        bytes memory sig = _sign(0xDEAD3, _thresholdDigest(1, n));
        vm.expectRevert(abi.encodeWithSelector(BrainMCPAgentRegistry.NotTenantSigner.selector, rogue));
        registry.setTenantThreshold(TENANT, 1, rogue, sig);
    }

    /// @notice The bootstrap exception is the only single-key authorization path
    ///         and it cannot reach the agent lifecycle: `initialAdmin` is not a
    ///         tenant signer.
    function test_bootstrapAdminCannotRegisterAgent() public {
        _bootstrapSigner(signer);
        assertTrue(registry.isTenantSigner(TENANT, signer));
        assertEq(registry.tenantSignerCount(TENANT), 1);

        bytes32 agentId = keccak256("admin-agent");
        bytes32 scope = keccak256("scope");
        address a = vm.addr(externalPk);
        bytes memory adminSig = _sign(adminPk, _regDigest(agentId, a, scope));
        vm.expectRevert(abi.encodeWithSelector(BrainMCPAgentRegistry.NotTenantSigner.selector, admin));
        registry.registerAgent(agentId, a, TENANT, scope, BEHAVIOR, admin, adminSig);
    }
}
