// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {BrainSignatureChecker} from "./BrainSignatureChecker.sol";

/// @title BrainPolicyRegistry
/// @notice Registers the hash and signer set of enterprise policies at the
///         time they go into force. Lets any third party verify which policy
///         was actually active on a given date, independent of Brain's
///         off-chain database. §4 of Brain_MVP_Architecture.md.
/// @dev    Each (tenantId, version) is write-once. Registration requires at
///         least `threshold` EIP-712 signatures from addresses that are
///         pre-authorized as tenant signers. The registry does not store
///         policy bodies — only the hash, the signer set, and the activation
///         time.
///
///         Authorization model: `initialAdmin` bootstraps the first signer
///         per tenant; thereafter signers manage themselves. If all signers
///         are removed, `initialAdmin` may re-bootstrap, preventing permanent
///         lockout. `initialAdmin` is rotatable through a two-step transfer, so
///         a compromised bootstrap key is recoverable without redeploying.
///
///         Signatures are verified through {BrainSignatureChecker}, so a tenant
///         signer may be an EOA or an ERC-1271 smart-contract wallet (Safe).
contract BrainPolicyRegistry {
    using BrainSignatureChecker for address;

    struct RegisteredPolicy {
        bytes32 policyHash;
        address[] signers;
        uint256 activatedAt;
        bool exists;
    }

    /// @notice Emitted on a successful policy registration.
    event PolicyRegistered(
        bytes32 indexed tenantId, uint256 indexed version, bytes32 policyHash, address[] signers, uint256 activatedAt
    );

    /// @notice Emitted when a tenant signer is added or removed.
    event TenantSignerSet(bytes32 indexed tenantId, address indexed signer, bool allowed);

    /// @notice Emitted when a tenant's approval threshold changes.
    event TenantThresholdSet(bytes32 indexed tenantId, uint256 threshold);

    /// @notice Emitted when a two-step admin rotation is proposed.
    event AdminTransferStarted(address indexed currentAdmin, address indexed pendingAdmin);

    /// @notice Emitted when a two-step admin rotation completes.
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    /// @dev Registered policies keyed by (tenantId, version).
    mapping(bytes32 => mapping(uint256 => RegisteredPolicy)) private _registrations;

    /// @dev Tracks the highest version per tenant so `registerPolicy` can
    ///      enforce strict monotonicity — can't retroactively insert older
    ///      versions.
    mapping(bytes32 => uint256) public latestVersion;

    /// @dev Per-tenant allowlist of authorized signer addresses.
    mapping(bytes32 => mapping(address => bool)) private _tenantSigners;

    /// @dev Count of active signers per tenant; zero means `initialAdmin`
    ///      may bootstrap a first signer.
    mapping(bytes32 => uint256) private _tenantSignerCount;

    /// @dev Per-tenant approval threshold (M-of-N). Zero means "not set", which
    ///      is read as 1 by {thresholdOf}.
    mapping(bytes32 => uint256) private _tenantThreshold;

    /// @dev Replay-protection nonce for signer-change and threshold-change
    ///      EIP-712 messages.
    mapping(bytes32 => uint256) public tenantSignerNonce;

    /// @dev tenantId => policyHash => registered. Lets BrainSmartAccount verify
    ///      that a session key's policyVersion is a policy this tenant actually
    ///      put into force, without knowing its version number.
    mapping(bytes32 => mapping(bytes32 => bool)) private _registeredHash;

    // EIP-712 domain
    bytes32 private constant _POLICY_TYPEHASH =
        keccak256("PolicyRegistration(bytes32 tenantId,uint256 version,bytes32 policyHash)");
    bytes32 private constant _SIGNER_TYPEHASH =
        keccak256("TenantSignerChange(bytes32 tenantId,address signer,bool allowed,uint256 nonce)");
    bytes32 private constant _THRESHOLD_TYPEHASH =
        keccak256("TenantThresholdChange(bytes32 tenantId,uint256 threshold,uint256 nonce)");
    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 private immutable _hashedName;
    bytes32 private immutable _hashedVersion;
    bytes32 private immutable _cachedDomainSeparator;
    uint256 private immutable _cachedChainId;

    /// @notice Can bootstrap the first signer per tenant; has no other privileges.
    ///         Rotatable via {transferAdmin} / {acceptAdmin}.
    address public initialAdmin;

    /// @notice Proposed next admin, who must call {acceptAdmin}. Zero when none
    ///         is pending.
    address public pendingAdmin;

    error AlreadyRegistered(bytes32 tenantId, uint256 version);
    error VersionNotMonotonic(bytes32 tenantId, uint256 supplied, uint256 latest);
    error InvalidVersion();
    error SignatureLengthMismatch();
    error InvalidSignature(address signer);
    error EmptySignerSet();
    error DuplicateSigner(address signer);
    error NotTenantSigner(address signer);
    error ZeroAddress();
    error NotAdmin();
    error NotPendingAdmin();
    error BelowThreshold(bytes32 tenantId, uint256 supplied, uint256 required);
    error InvalidThreshold(uint256 threshold, uint256 signerCount);
    error ThresholdWouldExceedSigners(uint256 remainingSigners, uint256 threshold);

    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        initialAdmin = admin;
        _hashedName = keccak256(bytes("Brain Policy"));
        _hashedVersion = keccak256(bytes("1"));
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
        emit AdminTransferred(address(0), admin);
    }

    // --- Admin rotation ---------------------------------------------------

    /// @notice Begin a two-step admin rotation. The transfer does NOT take
    ///         effect until `next` calls {acceptAdmin}, so a mistyped address
    ///         cannot strand the bootstrap capability.
    /// @param  next The proposed next admin, or address(0) to cancel.
    function transferAdmin(address next) external {
        if (msg.sender != initialAdmin) revert NotAdmin();
        pendingAdmin = next;
        emit AdminTransferStarted(initialAdmin, next);
    }

    /// @notice Complete a two-step admin rotation.
    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();
        address previous = initialAdmin;
        initialAdmin = pendingAdmin;
        pendingAdmin = address(0);
        emit AdminTransferred(previous, initialAdmin);
    }

    // --- Tenant signer management ----------------------------------------

    /// @notice Add or remove an authorized signer for a tenant.
    /// @dev    When signer count is zero, `initialAdmin` may bootstrap the
    ///         first signer. Subsequent changes require an existing tenant
    ///         signer. If all signers are removed, `initialAdmin` may
    ///         re-bootstrap, preventing permanent lockout.
    /// @param  authSigner The address claimed to have produced `signature`.
    ///         Required (not redundant): an ERC-1271 contract signature cannot
    ///         be recovered from, so the claimed signer must be supplied for the
    ///         membership check.
    function setTenantSigner(
        bytes32 tenantId,
        address signer,
        bool allowed,
        address authSigner,
        bytes calldata signature
    ) external {
        if (signer == address(0)) revert ZeroAddress();
        bytes32 digest = _hashSignerChange(tenantId, signer, allowed, tenantSignerNonce[tenantId]);
        if (!authSigner.isValidSignature(digest, signature)) revert InvalidSignature(authSigner);

        bool authorized = _tenantSigners[tenantId][authSigner];
        bool canBootstrap = (_tenantSignerCount[tenantId] == 0 && authSigner == initialAdmin);
        if (!authorized && !canBootstrap) revert NotTenantSigner(authSigner);

        if (allowed && !_tenantSigners[tenantId][signer]) {
            _tenantSignerCount[tenantId] += 1;
        } else if (!allowed && _tenantSigners[tenantId][signer]) {
            // Removing a signer must not strand the tenant below its own
            // threshold, which would make every future registration impossible.
            uint256 remaining = _tenantSignerCount[tenantId] - 1;
            uint256 required = thresholdOf(tenantId);
            if (remaining != 0 && remaining < required) {
                revert ThresholdWouldExceedSigners(remaining, required);
            }
            _tenantSignerCount[tenantId] = remaining;
        }
        _tenantSigners[tenantId][signer] = allowed;
        tenantSignerNonce[tenantId] += 1;

        emit TenantSignerSet(tenantId, signer, allowed);
    }

    /// @notice Set the M-of-N approval threshold for a tenant's policy
    ///         registrations. Requires a signature from an existing tenant
    ///         signer.
    /// @dev    A single authorized signer could previously register any policy
    ///         version, so the registry's answer to "which policy was in force"
    ///         rested on one key.
    function setTenantThreshold(bytes32 tenantId, uint256 threshold, address authSigner, bytes calldata signature)
        external
    {
        bytes32 digest = _hashThresholdChange(tenantId, threshold, tenantSignerNonce[tenantId]);
        if (!authSigner.isValidSignature(digest, signature)) revert InvalidSignature(authSigner);
        if (!_tenantSigners[tenantId][authSigner]) revert NotTenantSigner(authSigner);

        uint256 count = _tenantSignerCount[tenantId];
        if (threshold == 0 || threshold > count) revert InvalidThreshold(threshold, count);

        _tenantThreshold[tenantId] = threshold;
        tenantSignerNonce[tenantId] += 1;
        emit TenantThresholdSet(tenantId, threshold);
    }

    /// @notice The number of distinct tenant signatures a registration needs.
    ///         Unset defaults to 1, preserving single-signer tenants.
    function thresholdOf(bytes32 tenantId) public view returns (uint256) {
        uint256 t = _tenantThreshold[tenantId];
        return t == 0 ? 1 : t;
    }

    function isTenantSigner(bytes32 tenantId, address a) external view returns (bool) {
        return _tenantSigners[tenantId][a];
    }

    function tenantSignerCount(bytes32 tenantId) external view returns (uint256) {
        return _tenantSignerCount[tenantId];
    }

    // --- Policy lifecycle ------------------------------------------------

    /// @notice Register a policy version with the set of signatures that
    ///         authorized it.
    /// @param tenantId   keccak256 of the Brain tenant id.
    /// @param version    Policy version number. Must be non-zero and strictly
    ///                   greater than the tenant's latest.
    /// @param policyHash sha256 of the canonical policy content.
    /// @param signers    Addresses matching the supplied signatures — must be
    ///                   pre-authorized tenant signers, supplied in strict
    ///                   ascending address order (enforces uniqueness), and at
    ///                   least `thresholdOf(tenantId)` of them.
    /// @param signatures EIP-712 signatures over
    ///                   PolicyRegistration(tenantId, version, policyHash).
    function registerPolicy(
        bytes32 tenantId,
        uint256 version,
        bytes32 policyHash,
        address[] calldata signers,
        bytes[] calldata signatures
    ) external {
        // Version 0 previously registered without advancing latestVersion,
        // leaving monotonicity disengaged.
        if (version == 0) revert InvalidVersion();
        if (_registrations[tenantId][version].exists) {
            revert AlreadyRegistered(tenantId, version);
        }
        if (version <= latestVersion[tenantId]) {
            revert VersionNotMonotonic(tenantId, version, latestVersion[tenantId]);
        }
        if (signers.length == 0) revert EmptySignerSet();
        if (signers.length != signatures.length) revert SignatureLengthMismatch();

        uint256 required = thresholdOf(tenantId);
        if (signers.length < required) revert BelowThreshold(tenantId, signers.length, required);

        bytes32 digest = _hashPolicyRegistration(tenantId, version, policyHash);
        uint256 len = signers.length;
        for (uint256 i = 0; i < len; ++i) {
            // Enforce uniqueness via strict ordering.
            if (i > 0 && signers[i] <= signers[i - 1]) {
                revert DuplicateSigner(signers[i]);
            }
            // All signers must be pre-authorized for this tenant.
            if (!_tenantSigners[tenantId][signers[i]]) {
                revert NotTenantSigner(signers[i]);
            }
            if (!signers[i].isValidSignature(digest, signatures[i])) {
                revert InvalidSignature(signers[i]);
            }
        }

        _registrations[tenantId][version] =
            RegisteredPolicy({policyHash: policyHash, signers: signers, activatedAt: block.timestamp, exists: true});
        latestVersion[tenantId] = version;
        _registeredHash[tenantId][policyHash] = true;

        emit PolicyRegistered(tenantId, version, policyHash, signers, block.timestamp);
    }

    /// @notice Fetch a registered policy.
    /// @dev    `exists` is returned so callers can distinguish "never
    ///         registered" from "registered with a zero hash"; the zero-struct
    ///         was previously indistinguishable.
    function getPolicy(bytes32 tenantId, uint256 version)
        external
        view
        returns (bytes32 hash, address[] memory signers, uint256 activatedAt, bool exists)
    {
        RegisteredPolicy storage r = _registrations[tenantId][version];
        return (r.policyHash, r.signers, r.activatedAt, r.exists);
    }

    /// @notice Whether `policyHash` has ever been registered for `tenantId`.
    /// @dev    Consumed by BrainSmartAccount.grantSessionKey so a session key's
    ///         policyVersion is bound to a policy this tenant actually put into
    ///         force. Version-agnostic by design: the account holds a digest,
    ///         not a version number.
    function isRegisteredHash(bytes32 tenantId, bytes32 policyHash) external view returns (bool) {
        return _registeredHash[tenantId][policyHash];
    }

    /// @notice EIP-712 domain separator for off-chain signers to compute.
    function domainSeparator() public view returns (bytes32) {
        if (block.chainid == _cachedChainId) {
            return _cachedDomainSeparator;
        } else {
            return _buildDomainSeparator();
        }
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(abi.encode(_DOMAIN_TYPEHASH, _hashedName, _hashedVersion, block.chainid, address(this)));
    }

    function _hashPolicyRegistration(bytes32 tenantId, uint256 version, bytes32 policyHash)
        private
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(_POLICY_TYPEHASH, tenantId, version, policyHash));
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(), structHash));
    }

    function _hashSignerChange(bytes32 tenantId, address signer, bool allowed, uint256 nonceValue)
        private
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(_SIGNER_TYPEHASH, tenantId, signer, allowed, nonceValue));
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(), structHash));
    }

    function _hashThresholdChange(bytes32 tenantId, uint256 threshold, uint256 nonceValue)
        private
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(_THRESHOLD_TYPEHASH, tenantId, threshold, nonceValue));
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(), structHash));
    }
}
