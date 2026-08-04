// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {BrainPolicyRegistry} from "../src/BrainPolicyRegistry.sol";

contract BrainPolicyRegistryTest is Test {
    BrainPolicyRegistry internal registry;

    bytes32 internal constant TENANT = keccak256("tnt_test");
    uint256 internal adminPk = 0xAD1;
    uint256 internal signerPk1 = 0xA11CE;
    uint256 internal signerPk2 = 0xB0B;
    address internal admin;
    address internal signer1;
    address internal signer2;

    function setUp() public {
        admin = vm.addr(adminPk);
        registry = new BrainPolicyRegistry(admin);
        signer1 = vm.addr(signerPk1);
        signer2 = vm.addr(signerPk2);
        // Bootstrap signer1 via admin, then signer1 authorizes signer2.
        _bootstrapSigner(signer1);
        _addSigner(signerPk1, signer1, signer2);
    }

    function _thresholdDigest(uint256 threshold, uint256 nonce) internal view returns (bytes32) {
        bytes32 typeHash = keccak256("TenantThresholdChange(bytes32 tenantId,uint256 threshold,uint256 nonce)");
        bytes32 structHash = keccak256(abi.encode(typeHash, TENANT, threshold, nonce));
        return keccak256(abi.encodePacked(hex"1901", registry.domainSeparator(), structHash));
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

    /// @dev Seat signer3 and move the tenant to a genuine 3-of-3 posture.
    function _make3of3() internal returns (address signer3, uint256 signerPk3) {
        signerPk3 = 0xC0FFEE;
        signer3 = vm.addr(signerPk3);
        _addSigner(signerPk1, signer1, signer3);
        // Threshold is still the default 1 here, so one signature may raise it.
        uint256 n = registry.tenantSignerNonce(TENANT);
        registry.setTenantThreshold(TENANT, 3, signer1, _sign(signerPk1, _thresholdDigest(3, n)));
        assertEq(registry.thresholdOf(TENANT), 3);
    }

    // --- Helpers ---------------------------------------------------------

    function _signerChangeDigest(address s, bool allowed, uint256 nonce) internal view returns (bytes32) {
        bytes32 typeHash = keccak256("TenantSignerChange(bytes32 tenantId,address signer,bool allowed,uint256 nonce)");
        bytes32 structHash = keccak256(abi.encode(typeHash, TENANT, s, allowed, nonce));
        return keccak256(abi.encodePacked(hex"1901", registry.domainSeparator(), structHash));
    }

    function _digest(bytes32 policyHash, uint256 version) internal view returns (bytes32) {
        bytes32 typeHash = keccak256("PolicyRegistration(bytes32 tenantId,uint256 version,bytes32 policyHash)");
        bytes32 structHash = keccak256(abi.encode(typeHash, TENANT, version, policyHash));
        return keccak256(abi.encodePacked(hex"1901", registry.domainSeparator(), structHash));
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _bootstrapSigner(address s) internal {
        bytes memory sig = _sign(adminPk, _signerChangeDigest(s, true, 0));
        registry.setTenantSigner(TENANT, s, true, admin, sig);
    }

    function _addSigner(uint256 existingPk, address existingSigner, address newSigner) internal {
        uint256 nonce = registry.tenantSignerNonce(TENANT);
        bytes memory sig = _sign(existingPk, _signerChangeDigest(newSigner, true, nonce));
        registry.setTenantSigner(TENANT, newSigner, true, existingSigner, sig);
    }

    function _removeSigner(uint256 existingPk, address existingSigner, address target) internal {
        uint256 nonce = registry.tenantSignerNonce(TENANT);
        bytes memory sig = _sign(existingPk, _signerChangeDigest(target, false, nonce));
        registry.setTenantSigner(TENANT, target, false, existingSigner, sig);
    }

    // --- Signer management -----------------------------------------------

    function test_setTenantSigner_bootstrapByAdmin() public view {
        assertTrue(registry.isTenantSigner(TENANT, signer1));
        assertTrue(registry.isTenantSigner(TENANT, signer2));
        assertEq(registry.tenantSignerNonce(TENANT), 2); // one per setTenantSigner call
    }

    function test_setTenantSigner_adminBackdoorClosed() public {
        // After signers exist, admin cannot add more signers directly.
        address extra = vm.addr(0x1234);
        uint256 nonce = registry.tenantSignerNonce(TENANT);
        bytes memory adminSig = _sign(adminPk, _signerChangeDigest(extra, true, nonce));
        vm.expectRevert(abi.encodeWithSelector(BrainPolicyRegistry.NotTenantSigner.selector, admin));
        registry.setTenantSigner(TENANT, extra, true, admin, adminSig);
    }

    function test_setTenantSigner_adminCanRebootstrapAfterLockout() public {
        // Remove both signers, then admin may re-bootstrap.
        _removeSigner(signerPk1, signer1, signer2);
        _removeSigner(signerPk1, signer1, signer1);
        assertFalse(registry.isTenantSigner(TENANT, signer1));
        assertFalse(registry.isTenantSigner(TENANT, signer2));

        address newSigner = vm.addr(0x9999);
        uint256 nonce = registry.tenantSignerNonce(TENANT);
        bytes memory adminSig = _sign(adminPk, _signerChangeDigest(newSigner, true, nonce));
        registry.setTenantSigner(TENANT, newSigner, true, admin, adminSig);
        assertTrue(registry.isTenantSigner(TENANT, newSigner));
    }

    // --- registerPolicy --------------------------------------------------

    function test_register_acceptsValidSignature() public {
        bytes32 hash = keccak256("policy-1");
        bytes32 digest = _digest(hash, 1);

        address[] memory signers = new address[](1);
        signers[0] = signer1;
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sign(signerPk1, digest);

        registry.registerPolicy(TENANT, 1, hash, signers, sigs);

        (bytes32 storedHash, address[] memory storedSigners, uint256 activatedAt,) = registry.getPolicy(TENANT, 1);
        assertEq(storedHash, hash);
        assertEq(storedSigners.length, 1);
        assertEq(storedSigners[0], signer1);
        assertEq(activatedAt, block.timestamp);
        assertEq(registry.latestVersion(TENANT), 1);
    }

    function test_register_rejectsUnauthorizedSigner() public {
        // An address not in _tenantSigners cannot register a policy.
        address rogue = vm.addr(0xDEAD1);
        bytes32 hash = keccak256("rogue-policy");
        address[] memory signers = new address[](1);
        signers[0] = rogue;
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sign(0xDEAD1, _digest(hash, 1));
        vm.expectRevert(abi.encodeWithSelector(BrainPolicyRegistry.NotTenantSigner.selector, rogue));
        registry.registerPolicy(TENANT, 1, hash, signers, sigs);
    }

    function test_register_rejectsInvalidSignature() public {
        bytes32 hash = keccak256("p");
        bytes32 digest = _digest(hash, 1);
        address[] memory signers = new address[](1);
        signers[0] = signer1;
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sign(signerPk2, digest); // wrong key
        vm.expectRevert(abi.encodeWithSelector(BrainPolicyRegistry.InvalidSignature.selector, signer1));
        registry.registerPolicy(TENANT, 1, hash, signers, sigs);
    }

    function test_register_rejectsDoubleRegister() public {
        bytes32 hash = keccak256("p");
        bytes32 digest = _digest(hash, 1);
        address[] memory signers = new address[](1);
        signers[0] = signer1;
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sign(signerPk1, digest);
        registry.registerPolicy(TENANT, 1, hash, signers, sigs);
        vm.expectRevert(abi.encodeWithSelector(BrainPolicyRegistry.AlreadyRegistered.selector, TENANT, 1));
        registry.registerPolicy(TENANT, 1, hash, signers, sigs);
    }

    function test_register_enforcesVersionMonotonic() public {
        bytes32 hashA = keccak256("pA");
        bytes32 hashB = keccak256("pB");
        address[] memory signers = new address[](1);
        signers[0] = signer1;
        bytes[] memory sigsA = new bytes[](1);
        sigsA[0] = _sign(signerPk1, _digest(hashA, 2));
        registry.registerPolicy(TENANT, 2, hashA, signers, sigsA);

        bytes[] memory sigsB = new bytes[](1);
        sigsB[0] = _sign(signerPk1, _digest(hashB, 1));
        vm.expectRevert(abi.encodeWithSelector(BrainPolicyRegistry.VersionNotMonotonic.selector, TENANT, 1, 2));
        registry.registerPolicy(TENANT, 1, hashB, signers, sigsB);
    }

    function test_register_rejectsMismatchedArrays() public {
        bytes32 hash = keccak256("p");
        address[] memory signers = new address[](2);
        signers[0] = signer1;
        signers[1] = signer2;
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sign(signerPk1, _digest(hash, 1));
        vm.expectRevert(BrainPolicyRegistry.SignatureLengthMismatch.selector);
        registry.registerPolicy(TENANT, 1, hash, signers, sigs);
    }

    function test_register_rejectsEmptySignerSet() public {
        bytes32 hash = keccak256("p");
        address[] memory signers = new address[](0);
        bytes[] memory sigs = new bytes[](0);
        vm.expectRevert(BrainPolicyRegistry.EmptySignerSet.selector);
        registry.registerPolicy(TENANT, 1, hash, signers, sigs);
    }

    function test_register_rejectsDuplicateSigner() public {
        bytes32 hash = keccak256("p");
        bytes32 digest = _digest(hash, 1);
        address[] memory signers = new address[](2);
        signers[0] = signer1;
        signers[1] = signer1; // duplicate
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(signerPk1, digest);
        sigs[1] = _sign(signerPk1, digest);
        vm.expectRevert(abi.encodeWithSelector(BrainPolicyRegistry.DuplicateSigner.selector, signer1));
        registry.registerPolicy(TENANT, 1, hash, signers, sigs);
    }

    function test_register_rejectsUnsortedSigners() public {
        bytes32 hash = keccak256("p");
        bytes32 digest = _digest(hash, 1);
        address[] memory signers = new address[](2);
        // Determine which address is smaller and place them in reversed order.
        address s1 = signer1 < signer2 ? signer1 : signer2;
        address s2 = signer1 < signer2 ? signer2 : signer1;
        uint256 p1 = signer1 < signer2 ? signerPk1 : signerPk2;
        uint256 p2 = signer1 < signer2 ? signerPk2 : signerPk1;

        signers[0] = s2; // intentionally reversed
        signers[1] = s1;
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(p2, digest);
        sigs[1] = _sign(p1, digest);

        vm.expectRevert(abi.encodeWithSelector(BrainPolicyRegistry.DuplicateSigner.selector, s1));
        registry.registerPolicy(TENANT, 1, hash, signers, sigs);
    }

    // --- Invariant-like: stored signer set matches the signature set ---

    function test_invariant_storedSignersMatchSubmitted() public {
        bytes32 hash = keccak256("p");
        // Sort signers ascending as the contract requires.
        address s0 = signer1 < signer2 ? signer1 : signer2;
        address s1 = signer1 < signer2 ? signer2 : signer1;
        uint256 pk0 = signer1 < signer2 ? signerPk1 : signerPk2;
        uint256 pk1 = signer1 < signer2 ? signerPk2 : signerPk1;

        address[] memory signers = new address[](2);
        signers[0] = s0;
        signers[1] = s1;
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(pk0, _digest(hash, 1));
        sigs[1] = _sign(pk1, _digest(hash, 1));
        registry.registerPolicy(TENANT, 1, hash, signers, sigs);

        (, address[] memory stored,,) = registry.getPolicy(TENANT, 1);
        assertEq(stored.length, 2);
        assertEq(stored[0], s0);
        assertEq(stored[1], s1);
    }

    // --- M-of-N quorum on signer-set and threshold changes ----------------

    function test_thresholdOf_unsetReadsAsOne() public view {
        assertEq(registry.thresholdOf(keccak256("never_configured")), 1);
    }

    /// @notice The whole attack in one test: one compromised key of a 3-of-3
    ///         tenant must not be able to lower the threshold, seat a signer, or
    ///         register a policy.
    function test_quorum_singleCompromisedKeyCannotForgePolicy() public {
        _make3of3();

        uint256 n = registry.tenantSignerNonce(TENANT);
        address rogue = vm.addr(0xDEAD2);
        bytes32 hash = keccak256("forged-policy");
        bytes memory lowerSig = _sign(signerPk1, _thresholdDigest(1, n));
        bytes memory seatSig = _sign(signerPk1, _signerChangeDigest(rogue, true, n));
        address[] memory signers = new address[](1);
        signers[0] = signer1;
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sign(signerPk1, _digest(hash, 1));

        // 1. Cannot drop the threshold to 1 alone.
        vm.expectRevert(abi.encodeWithSelector(BrainPolicyRegistry.BelowThreshold.selector, TENANT, 1, 3));
        registry.setTenantThreshold(TENANT, 1, signer1, lowerSig);

        // 2. Cannot seat attacker-controlled co-signers alone.
        vm.expectRevert(abi.encodeWithSelector(BrainPolicyRegistry.BelowThreshold.selector, TENANT, 1, 3));
        registry.setTenantSigner(TENANT, rogue, true, signer1, seatSig);

        // 3. Cannot register a policy alone.
        vm.expectRevert(abi.encodeWithSelector(BrainPolicyRegistry.BelowThreshold.selector, TENANT, 1, 3));
        registry.registerPolicy(TENANT, 1, hash, signers, sigs);

        // And the forged hash never became bindable by a session key.
        assertFalse(registry.isRegisteredHash(TENANT, hash));
    }

    function test_setTenantThreshold_lowersWithFullQuorum() public {
        (address signer3, uint256 signerPk3) = _make3of3();

        uint256 n = registry.tenantSignerNonce(TENANT);
        uint256[] memory pks = new uint256[](3);
        address[] memory addrs = new address[](3);
        (pks[0], addrs[0]) = (signerPk1, signer1);
        (pks[1], addrs[1]) = (signerPk2, signer2);
        (pks[2], addrs[2]) = (signerPk3, signer3);
        (address[] memory qs, bytes[] memory qsig) = _quorum(pks, addrs, _thresholdDigest(1, n));

        registry.setTenantThreshold(TENANT, 1, qs, qsig);
        assertEq(registry.thresholdOf(TENANT), 1);
    }

    function test_setTenantSigner_addsWithFullQuorum() public {
        (address signer3, uint256 signerPk3) = _make3of3();
        address extra = vm.addr(0x4444);

        uint256 n = registry.tenantSignerNonce(TENANT);
        uint256[] memory pks = new uint256[](3);
        address[] memory addrs = new address[](3);
        (pks[0], addrs[0]) = (signerPk1, signer1);
        (pks[1], addrs[1]) = (signerPk2, signer2);
        (pks[2], addrs[2]) = (signerPk3, signer3);
        (address[] memory qs, bytes[] memory qsig) = _quorum(pks, addrs, _signerChangeDigest(extra, true, n));

        registry.setTenantSigner(TENANT, extra, true, qs, qsig);
        assertTrue(registry.isTenantSigner(TENANT, extra));
        assertEq(registry.tenantSignerCount(TENANT), 4);
    }

    /// @notice A quorum-authorized removal still cannot strand the tenant below
    ///         its own threshold.
    function test_setTenantSigner_quorumCannotStrandBelowThreshold() public {
        (address signer3, uint256 signerPk3) = _make3of3();

        uint256 n = registry.tenantSignerNonce(TENANT);
        uint256[] memory pks = new uint256[](3);
        address[] memory addrs = new address[](3);
        (pks[0], addrs[0]) = (signerPk1, signer1);
        (pks[1], addrs[1]) = (signerPk2, signer2);
        (pks[2], addrs[2]) = (signerPk3, signer3);
        (address[] memory qs, bytes[] memory qsig) = _quorum(pks, addrs, _signerChangeDigest(signer3, false, n));

        vm.expectRevert(abi.encodeWithSelector(BrainPolicyRegistry.ThresholdWouldExceedSigners.selector, 2, 3));
        registry.setTenantSigner(TENANT, signer3, false, qs, qsig);
    }

    function test_setTenantThreshold_rejectsZeroAndAboveSignerCount() public {
        uint256 n = registry.tenantSignerNonce(TENANT);
        bytes memory zeroSig = _sign(signerPk1, _thresholdDigest(0, n));
        bytes memory tooHighSig = _sign(signerPk1, _thresholdDigest(3, n));

        vm.expectRevert(abi.encodeWithSelector(BrainPolicyRegistry.InvalidThreshold.selector, 0, 2));
        registry.setTenantThreshold(TENANT, 0, signer1, zeroSig);

        vm.expectRevert(abi.encodeWithSelector(BrainPolicyRegistry.InvalidThreshold.selector, 3, 2));
        registry.setTenantThreshold(TENANT, 3, signer1, tooHighSig);
    }

    function test_setTenantThreshold_rejectsNonSigner() public {
        address rogue = vm.addr(0xDEAD3);
        uint256 n = registry.tenantSignerNonce(TENANT);
        bytes memory sig = _sign(0xDEAD3, _thresholdDigest(2, n));
        vm.expectRevert(abi.encodeWithSelector(BrainPolicyRegistry.NotTenantSigner.selector, rogue));
        registry.setTenantThreshold(TENANT, 2, rogue, sig);
    }

    function test_setTenantThreshold_rejectsInvalidSignature() public {
        uint256 n = registry.tenantSignerNonce(TENANT);
        bytes memory wrongSig = _sign(signerPk2, _thresholdDigest(2, n));
        vm.expectRevert(abi.encodeWithSelector(BrainPolicyRegistry.InvalidSignature.selector, signer1));
        registry.setTenantThreshold(TENANT, 2, signer1, wrongSig);
    }

    /// @notice The bootstrap exception is the only single-key authorization path
    ///         and it cannot reach registerPolicy: `initialAdmin` is not a signer.
    function test_bootstrapAdminCannotRegisterPolicy() public {
        bytes32 fresh = keccak256("tnt_no_signers");
        bytes32 hash = keccak256("admin-policy");
        address[] memory signers = new address[](1);
        signers[0] = admin;
        bytes[] memory sigs = new bytes[](1);
        bytes32 typeHash = keccak256("PolicyRegistration(bytes32 tenantId,uint256 version,bytes32 policyHash)");
        bytes32 structHash = keccak256(abi.encode(typeHash, fresh, uint256(1), hash));
        sigs[0] = _sign(adminPk, keccak256(abi.encodePacked(hex"1901", registry.domainSeparator(), structHash)));
        vm.expectRevert(abi.encodeWithSelector(BrainPolicyRegistry.NotTenantSigner.selector, admin));
        registry.registerPolicy(fresh, 1, hash, signers, sigs);
    }
}
