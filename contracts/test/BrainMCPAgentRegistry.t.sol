// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {BrainMCPAgentRegistry} from "../src/BrainMCPAgentRegistry.sol";

contract BrainMCPAgentRegistryTest is Test {
    BrainMCPAgentRegistry internal registry;
    bytes32 internal constant TENANT = keccak256("tnt_test");
    bytes32 internal constant BEHAVIOR = keccak256("behavior.v1");
    uint256 internal adminPk = 0xA11CE;
    uint256 internal signerPk = 0xB0B;
    uint256 internal externalPk = 0xCA75;
    address internal admin;
    address internal signer;

    function setUp() public {
        admin = vm.addr(adminPk);
        signer = vm.addr(signerPk);
        registry = new BrainMCPAgentRegistry(admin);
    }

    function _domainSep() internal view returns (bytes32) {
        return registry.domainSeparator();
    }

    function _signerChangeDigest(address s, bool allowed, uint256 nonce) internal view returns (bytes32) {
        bytes32 typeHash = keccak256("TenantSignerChange(bytes32 tenantId,address signer,bool allowed,uint256 nonce)");
        bytes32 structHash = keccak256(abi.encode(typeHash, TENANT, s, allowed, nonce));
        return keccak256(abi.encodePacked(hex"19_01", _domainSep(), structHash));
    }

    function _regDigest(bytes32 agentId, address addr, bytes32 scope) internal view returns (bytes32) {
        bytes32 typeHash = keccak256(
            "AgentRegistration(bytes32 agentId,address agentAddress,bytes32 tenantId,bytes32 scopeHash,bytes32 behaviorHash)"
        );
        bytes32 structHash = keccak256(abi.encode(typeHash, agentId, addr, TENANT, scope, BEHAVIOR));
        return keccak256(abi.encodePacked(hex"19_01", _domainSep(), structHash));
    }

    function _revDigest(bytes32 agentId) internal view returns (bytes32) {
        bytes32 typeHash = keccak256("AgentRevocation(bytes32 agentId,bytes32 tenantId)");
        bytes32 structHash = keccak256(abi.encode(typeHash, agentId, TENANT));
        return keccak256(abi.encodePacked(hex"19_01", _domainSep(), structHash));
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

    function test_register_rejectsWithoutTenantSigner() public {
        bytes32 agentId = keccak256("agent");
        bytes memory sig = _sign(externalPk, _regDigest(agentId, vm.addr(externalPk), keccak256("scope")));
        vm.expectRevert();
        registry.registerAgent(agentId, vm.addr(externalPk), TENANT, keccak256("scope"), BEHAVIOR, sig);
    }

    function test_register_happyPath() public {
        _bootstrapSigner(signer);
        bytes32 agentId = keccak256("agent");
        bytes32 scope = keccak256("scope.v1");
        address agentAddr = vm.addr(externalPk);

        bytes memory sig = _sign(signerPk, _regDigest(agentId, agentAddr, scope));
        registry.registerAgent(agentId, agentAddr, TENANT, scope, BEHAVIOR, sig);

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
        registry.registerAgent(agentId, a, TENANT, scope, BEHAVIOR, sig);
        vm.expectRevert(abi.encodeWithSelector(BrainMCPAgentRegistry.AgentAlreadyRegistered.selector, agentId));
        registry.registerAgent(agentId, a, TENANT, scope, BEHAVIOR, sig);
    }

    function test_revoke_happyPath() public {
        _bootstrapSigner(signer);
        bytes32 agentId = keccak256("agent");
        bytes32 scope = keccak256("scope");
        address a = vm.addr(externalPk);
        bytes memory regSig = _sign(signerPk, _regDigest(agentId, a, scope));
        registry.registerAgent(agentId, a, TENANT, scope, BEHAVIOR, regSig);

        bytes memory revSig = _sign(signerPk, _revDigest(agentId));
        registry.revokeAgent(agentId, revSig);
        assertFalse(registry.isAuthorized(agentId, TENANT));
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
            registry.registerAgent(agentId, a, TENANT, scope, BEHAVIOR, sig);
            BrainMCPAgentRegistry.AgentRegistration memory reg = registry.getAgent(agentId);
            assertEq(reg.scopeHash, scope);
            assertEq(reg.agentAddress, a);
        }
    }

    function _behaviorDigest(bytes32 agentId, bytes32 behaviorHash) internal view returns (bytes32) {
        bytes32 typeHash = keccak256("AgentBehaviorUpdate(bytes32 agentId,bytes32 tenantId,bytes32 behaviorHash)");
        bytes32 structHash = keccak256(abi.encode(typeHash, agentId, TENANT, behaviorHash));
        return keccak256(abi.encodePacked(hex"19_01", _domainSep(), structHash));
    }

    function test_updateBehaviorHash_reattests() public {
        _bootstrapSigner(signer);
        bytes32 agentId = keccak256("agent");
        bytes32 scope = keccak256("scope");
        address a = vm.addr(externalPk);
        registry.registerAgent(
            agentId, a, TENANT, scope, BEHAVIOR, _sign(signerPk, _regDigest(agentId, a, scope))
        );
        assertEq(registry.getAgent(agentId).behaviorHash, BEHAVIOR);

        // Promote to a new behavior with a fresh tenant-signed attestation.
        bytes32 next = keccak256("behavior.v2");
        registry.updateBehaviorHash(agentId, next, _sign(signerPk, _behaviorDigest(agentId, next)));
        assertEq(registry.getAgent(agentId).behaviorHash, next);
    }

    function test_updateBehaviorHash_rejectsNonSigner() public {
        _bootstrapSigner(signer);
        bytes32 agentId = keccak256("agent");
        bytes32 scope = keccak256("scope");
        address a = vm.addr(externalPk);
        registry.registerAgent(
            agentId, a, TENANT, scope, BEHAVIOR, _sign(signerPk, _regDigest(agentId, a, scope))
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
        registry.updateBehaviorHash(agentId, next, sig);
    }
}
