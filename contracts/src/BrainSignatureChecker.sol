// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

/// @dev ERC-1271 signature-validation surface implemented by smart-contract
///      signers (Safe and friends). Declared inline so the Brain contracts stay
///      dependency-free.
interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4 magicValue);
}

/// @title BrainSignatureChecker
/// @notice Shared signature verification for the Brain registries. Accepts BOTH
///         EOA signatures (ECDSA) and smart-contract signatures (ERC-1271), so a
///         Safe multi-sig can act as a tenant signer.
/// @dev    Both BrainPolicyRegistry and BrainMCPAgentRegistry previously carried
///         byte-identical inline recovery. Neither supported ERC-1271, so the
///         "2-of-3 Safe multi-sig" posture the architecture documents specifies
///         for privileged roles was impossible for tenant signers: they had to
///         be EOAs.
///
///         Verification is claimed-signer based, not recovery based. The caller
///         names the address it expects to have signed and this library confirms
///         it. That is a requirement, not a style choice: a contract signature
///         cannot be recovered from, so there is nothing to compare a membership
///         allowlist against unless the claimed signer is supplied.
library BrainSignatureChecker {
    /// @dev ERC-1271 success value: bytes4(keccak256("isValidSignature(bytes32,bytes)")).
    bytes4 internal constant ERC1271_MAGIC_VALUE = 0x1626ba7e;

    /// @dev secp256k1 group order / 2. Signatures above this are the malleable
    ///      counterpart of a canonical one (EIP-2).
    uint256 private constant _HALF_ORDER = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    /// @notice Recover the EOA that produced `sig` over `digest`, or the zero
    ///         address when the signature is not canonical.
    /// @dev    Strict on both halves of EIP-2: high-s is rejected, and `v` must
    ///         already be 27 or 28. The previous implementations normalised
    ///         `v < 27` by adding 27, which made two distinct 65-byte signatures
    ///         recover the same signer. Brain's off-chain signers use viem,
    ///         which emits 27/28.
    function recoverEoa(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            let offset := sig.offset
            r := calldataload(offset)
            s := calldataload(add(offset, 32))
            v := byte(0, calldataload(add(offset, 64)))
        }
        if (uint256(s) > _HALF_ORDER) return address(0);
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }

    /// @notice Whether `signer` authorized `digest`.
    /// @dev    ECDSA recovery is tried FIRST, then ERC-1271 for addresses that
    ///         carry code. A staticcall is used so a malicious signer contract
    ///         cannot mutate state or re-enter.
    ///
    ///         Order matters. `signer.code.length == 0` is no longer an EOA/
    ///         contract discriminator: post-Pectra (live on Base) an EIP-7702
    ///         delegated EOA carries 23 bytes of `0xef0100 ++ address` while its
    ///         private key still signs. Asking 1271 first would route a plain-EOA
    ///         tenant signer to a delegate that does not implement it the moment
    ///         the user opts into a 7702 wallet — and a sole signer at threshold 1
    ///         would be PERMANENTLY locked out, because re-bootstrapping requires
    ///         `_tenantSignerCount == 0`, which requires a signature from that
    ///         same signer. Trying recovery first costs one ecrecover for contract
    ///         signers and cannot produce a false accept: matching would mean
    ///         holding the private key of the contract's own address.
    function isValidSignature(address signer, bytes32 digest, bytes calldata sig) internal view returns (bool) {
        if (signer == address(0)) return false;

        if (recoverEoa(digest, sig) == signer) return true;
        if (signer.code.length == 0) return false;

        (bool ok, bytes memory ret) =
            signer.staticcall(abi.encodeWithSelector(IERC1271.isValidSignature.selector, digest, sig));
        if (!ok || ret.length != 32) return false;
        return abi.decode(ret, (bytes4)) == ERC1271_MAGIC_VALUE;
    }
}
