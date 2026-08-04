// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {BrainSignatureChecker} from "../src/BrainSignatureChecker.sol";

/// @dev The library is `internal`, so every call needs an on-chain harness for
///      the calldata slices and the staticcall boundary to be real.
contract SignatureCheckerHarness {
    function isValid(address signer, bytes32 digest, bytes calldata sig) external view returns (bool) {
        return BrainSignatureChecker.isValidSignature(signer, digest, sig);
    }

    function recover(bytes32 digest, bytes calldata sig) external pure returns (address) {
        return BrainSignatureChecker.recoverEoa(digest, sig);
    }
}

/// @dev A Safe-style contract signer that accepts everything.
contract AcceptingSigner {
    function isValidSignature(bytes32, bytes memory) external pure returns (bytes4) {
        return 0x1626ba7e;
    }
}

/// @dev Returns a well-formed bytes4 that is NOT the magic value.
contract RejectingSigner {
    function isValidSignature(bytes32, bytes memory) external pure returns (bytes4) {
        return 0xffffffff;
    }
}

contract RevertingSigner {
    function isValidSignature(bytes32, bytes memory) external pure returns (bytes4) {
        revert("nope");
    }
}

/// @dev Returns 31 bytes. abi.decode would read past the end, so the length
///      check is what keeps this from being decoded as garbage.
contract ShortReturnSigner {
    fallback() external {
        assembly {
            mstore(0, 0x1626ba7e00000000000000000000000000000000000000000000000000000000)
            return(0, 31)
        }
    }
}

/// @dev Returns 64 bytes whose first word IS the magic value.
contract LongReturnSigner {
    fallback() external {
        assembly {
            mstore(0, 0x1626ba7e00000000000000000000000000000000000000000000000000000000)
            mstore(32, 0)
            return(0, 64)
        }
    }
}

/// @dev Writes storage. The staticcall in the library must make this fail rather
///      than letting a "signer" mutate state (or re-enter) during verification.
contract StatefulSigner {
    uint256 public calls;

    function isValidSignature(bytes32, bytes memory) external returns (bytes4) {
        calls += 1;
        return 0x1626ba7e;
    }
}

contract BrainSignatureCheckerTest is Test {
    /// @dev secp256k1 group order.
    uint256 internal constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    SignatureCheckerHarness internal h;
    uint256 internal pk = 0xA11CE;
    address internal signer;
    bytes32 internal digest = keccak256("brain-digest");

    function setUp() public {
        h = new SignatureCheckerHarness();
        signer = vm.addr(pk);
    }

    function _sign(uint256 key, bytes32 d) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, d);
        return abi.encodePacked(r, s, v);
    }

    // --- EOA path ---------------------------------------------------------

    function test_eoa_acceptsCanonicalSignature() public view {
        assertTrue(h.isValid(signer, digest, _sign(pk, digest)));
        assertEq(h.recover(digest, _sign(pk, digest)), signer);
    }

    function test_eoa_rejectsWrongClaimedSigner() public view {
        assertFalse(h.isValid(vm.addr(0xB0B), digest, _sign(pk, digest)));
    }

    function test_eoa_rejectsWrongDigest() public view {
        assertFalse(h.isValid(signer, keccak256("other"), _sign(pk, digest)));
    }

    function test_rejectsZeroSigner() public view {
        assertFalse(h.isValid(address(0), digest, _sign(pk, digest)));
    }

    function test_eoa_rejectsWrongLength() public view {
        bytes memory sig = _sign(pk, digest);
        assertEq(h.recover(digest, hex""), address(0));
        assertEq(h.recover(digest, abi.encodePacked(sig, bytes1(0x00))), address(0)); // 66
        bytes memory short = new bytes(64);
        for (uint256 i = 0; i < 64; ++i) {
            short[i] = sig[i];
        }
        assertEq(h.recover(digest, short), address(0));
    }

    /// EIP-2 malleability: (r, N-s, flipped v) is the counterpart of a canonical
    /// signature over the same digest. It must NOT verify, or one authorization
    /// has two distinct on-chain representations.
    function test_eoa_rejectsHighS() public view {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        bytes32 flippedS = bytes32(N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        bytes memory malleable = abi.encodePacked(r, flippedS, flippedV);

        // Sanity: the canonical one does verify.
        assertTrue(h.isValid(signer, digest, abi.encodePacked(r, s, v)));
        // Its malleable twin does not, and recovers to nobody.
        assertEq(h.recover(digest, malleable), address(0));
        assertFalse(h.isValid(signer, digest, malleable));
    }

    /// The named regression: earlier inline implementations normalised `v < 27`
    /// by adding 27, so 0/1 and 27/28 recovered the SAME signer and one
    /// authorization had two valid encodings.
    function test_eoa_rejectsLegacyVZeroAndOne() public view {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        assertEq(h.recover(digest, abi.encodePacked(r, s, uint8(v - 27))), address(0));
        assertFalse(h.isValid(signer, digest, abi.encodePacked(r, s, uint8(v - 27))));
        // Both legacy values, regardless of which one this signature used.
        assertEq(h.recover(digest, abi.encodePacked(r, s, uint8(0))), address(0));
        assertEq(h.recover(digest, abi.encodePacked(r, s, uint8(1))), address(0));
    }

    function testFuzz_eoa_rejectsArbitraryV(uint8 v, bytes32 r, bytes32 s) public view {
        vm.assume(v != 27 && v != 28);
        assertEq(h.recover(digest, abi.encodePacked(r, s, v)), address(0));
    }

    // --- ERC-1271 path ----------------------------------------------------

    /// The reason the library exists: the architecture specifies a 2-of-3 Safe
    /// for privileged roles, which was impossible while signers had to be EOAs.
    function test_erc1271_acceptsContractSigner() public {
        address safe = address(new AcceptingSigner());
        // Deliberately garbage bytes: a contract signer defines its own format.
        assertTrue(h.isValid(safe, digest, hex"deadbeef"));
    }

    function test_erc1271_rejectsWrongMagicValue() public {
        assertFalse(h.isValid(address(new RejectingSigner()), digest, hex"deadbeef"));
    }

    function test_erc1271_rejectsRevertingSigner() public {
        assertFalse(h.isValid(address(new RevertingSigner()), digest, hex"deadbeef"));
    }

    /// A 31-byte return would be abi.decoded past its end. The explicit
    /// `ret.length != 32` check is what stops that.
    function test_erc1271_rejectsShortReturnData() public {
        assertFalse(h.isValid(address(new ShortReturnSigner()), digest, hex"deadbeef"));
    }

    /// 64 bytes whose FIRST word is the magic value is still malformed: an
    /// abi.decode-only check would accept it.
    function test_erc1271_rejectsOverlongReturnData() public {
        assertFalse(h.isValid(address(new LongReturnSigner()), digest, hex"deadbeef"));
    }

    /// The staticcall is load-bearing: a signer contract must not be able to
    /// mutate state or re-enter while its own signature is being verified.
    function test_erc1271_stateMutatingSignerCannotVerify() public {
        StatefulSigner s = new StatefulSigner();
        assertFalse(h.isValid(address(s), digest, hex"deadbeef"));
        assertEq(s.calls(), 0);
    }

    /// A contract address with code that is not a signer at all (no matching
    /// function) must fail closed rather than be treated as an EOA.
    function test_erc1271_nonSignerContractFailsClosed() public view {
        assertFalse(h.isValid(address(h), digest, _sign(pk, digest)));
    }
}
