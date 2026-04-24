// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

/// @title BrainPolicyRegistry
/// @notice Registers the hash and signer set of enterprise policies at the
///         time they go into force. Lets any third party verify which policy
///         was actually active on a given date, independent of Brain's
///         off-chain database. §4 of Brain_MVP_Architecture.md.
/// @dev    Each (tenantId, version) is write-once. Registration requires
///         one or more EIP-712 signatures from addresses controlled by
///         the tenant. The registry does not store policy bodies — only
///         the hash, the signer set, and the activation time.
contract BrainPolicyRegistry {
    struct RegisteredPolicy {
        bytes32 policyHash;
        address[] signers;
        uint256 activatedAt;
        bool exists;
    }

    /// @notice Emitted on a successful policy registration.
    event PolicyRegistered(
        bytes32 indexed tenantId,
        uint256 indexed version,
        bytes32 policyHash,
        address[] signers,
        uint256 activatedAt
    );

    /// @dev Registered policies keyed by (tenantId, version).
    mapping(bytes32 => mapping(uint256 => RegisteredPolicy)) private _registrations;

    /// @dev Tracks the highest version per tenant so `registerPolicy` can
    ///      enforce strict monotonicity — can't retroactively insert older
    ///      versions.
    mapping(bytes32 => uint256) public latestVersion;

    // EIP-712 domain
    bytes32 private constant _POLICY_TYPEHASH =
        keccak256("PolicyRegistration(bytes32 tenantId,uint256 version,bytes32 policyHash)");
    bytes32 private constant _DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private immutable _domainSeparator;

    error AlreadyRegistered(bytes32 tenantId, uint256 version);
    error VersionNotMonotonic(bytes32 tenantId, uint256 supplied, uint256 latest);
    error SignatureLengthMismatch();
    error InvalidSignature(address signer);
    error EmptySignerSet();

    constructor() {
        _domainSeparator = keccak256(
            abi.encode(
                _DOMAIN_TYPEHASH,
                keccak256(bytes("Brain Policy")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    /// @notice Register a policy version with the set of signatures that
    ///         authorized it.
    /// @param tenantId   keccak256 of the Brain tenant id.
    /// @param version    Policy version number.
    /// @param policyHash sha256 of the canonical policy content.
    /// @param signers    Addresses matching the supplied signatures.
    /// @param signatures EIP-712 signatures over
    ///                   PolicyRegistration(tenantId, version, policyHash).
    function registerPolicy(
        bytes32 tenantId,
        uint256 version,
        bytes32 policyHash,
        address[] calldata signers,
        bytes[] calldata signatures
    ) external {
        if (_registrations[tenantId][version].exists) {
            revert AlreadyRegistered(tenantId, version);
        }
        if (version <= latestVersion[tenantId] && latestVersion[tenantId] != 0) {
            revert VersionNotMonotonic(tenantId, version, latestVersion[tenantId]);
        }
        if (signers.length == 0) revert EmptySignerSet();
        if (signers.length != signatures.length) revert SignatureLengthMismatch();

        bytes32 digest = _hashPolicyRegistration(tenantId, version, policyHash);
        uint256 len = signers.length;
        for (uint256 i = 0; i < len; ++i) {
            address recovered = _recover(digest, signatures[i]);
            if (recovered == address(0) || recovered != signers[i]) {
                revert InvalidSignature(signers[i]);
            }
        }

        _registrations[tenantId][version] = RegisteredPolicy({
            policyHash: policyHash,
            signers: signers,
            activatedAt: block.timestamp,
            exists: true
        });
        latestVersion[tenantId] = version;

        emit PolicyRegistered(tenantId, version, policyHash, signers, block.timestamp);
    }

    /// @notice Fetch a registered policy.
    function getPolicy(bytes32 tenantId, uint256 version)
        external
        view
        returns (bytes32 hash, address[] memory signers, uint256 activatedAt)
    {
        RegisteredPolicy storage r = _registrations[tenantId][version];
        return (r.policyHash, r.signers, r.activatedAt);
    }

    /// @notice EIP-712 domain separator for off-chain signers to compute.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparator;
    }

    function _hashPolicyRegistration(
        bytes32 tenantId,
        uint256 version,
        bytes32 policyHash
    ) private view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(_POLICY_TYPEHASH, tenantId, version, policyHash));
        return keccak256(abi.encodePacked(hex"19_01", _domainSeparator, structHash));
    }

    /// @dev Compact ECDSA recover, no pre-image prefix. EIP-712 digest in.
    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
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
        if (v < 27) v += 27;
        // Reject high-s signatures (EIP-2 malleability guard).
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            return address(0);
        }
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
