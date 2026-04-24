// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {BrainPolicyRegistry} from "../src/BrainPolicyRegistry.sol";

contract BrainPolicyRegistryTest is Test {
    BrainPolicyRegistry internal registry;

    bytes32 internal constant TENANT = keccak256("tnt_test");
    uint256 internal signerPk1 = 0xA11CE;
    uint256 internal signerPk2 = 0xB0B;
    address internal signer1;
    address internal signer2;

    function setUp() public {
        registry = new BrainPolicyRegistry();
        signer1 = vm.addr(signerPk1);
        signer2 = vm.addr(signerPk2);
    }

    function _digest(bytes32 policyHash, uint256 version) internal view returns (bytes32) {
        bytes32 typeHash = keccak256("PolicyRegistration(bytes32 tenantId,uint256 version,bytes32 policyHash)");
        bytes32 structHash = keccak256(abi.encode(typeHash, TENANT, version, policyHash));
        return keccak256(abi.encodePacked(hex"19_01", registry.domainSeparator(), structHash));
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_register_acceptsValidSignature() public {
        bytes32 hash = keccak256("policy-1");
        bytes32 digest = _digest(hash, 1);

        address[] memory signers = new address[](1);
        signers[0] = signer1;
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sign(signerPk1, digest);

        registry.registerPolicy(TENANT, 1, hash, signers, sigs);

        (bytes32 storedHash, address[] memory storedSigners, uint256 activatedAt) = registry.getPolicy(TENANT, 1);
        assertEq(storedHash, hash);
        assertEq(storedSigners.length, 1);
        assertEq(storedSigners[0], signer1);
        assertEq(activatedAt, block.timestamp);
        assertEq(registry.latestVersion(TENANT), 1);
    }

    function test_register_rejectsInvalidSignature() public {
        bytes32 hash = keccak256("p");
        bytes32 digest = _digest(hash, 1);
        address[] memory signers = new address[](1);
        signers[0] = signer1;
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sign(signerPk2, digest); // wrong signer
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

    // --- Invariant-like: stored signer set matches the signature set ---

    function test_invariant_storedSignersMatchSubmitted() public {
        bytes32 hash = keccak256("p");
        address[] memory signers = new address[](2);
        signers[0] = signer1;
        signers[1] = signer2;
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(signerPk1, _digest(hash, 1));
        sigs[1] = _sign(signerPk2, _digest(hash, 1));
        registry.registerPolicy(TENANT, 1, hash, signers, sigs);

        (, address[] memory stored,) = registry.getPolicy(TENANT, 1);
        assertEq(stored.length, 2);
        assertEq(stored[0], signer1);
        assertEq(stored[1], signer2);
    }
}
