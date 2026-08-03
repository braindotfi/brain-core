// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {BrainSignatureChecker} from "./BrainSignatureChecker.sol";

/// @title BrainMCPAgentRegistry
/// @notice Public registry of third-party agents authorized to connect to a
///         tenant's MCP interface. On-chain scope attestation — any observer
///         can verify which agents have which permissions without trusting
///         Brain's off-chain records. §4 of Brain_MVP_Architecture.md.
/// @dev    Third-party agents cannot self-register. Registration requires an
///         EIP-712 signature from an address the tenant has pre-registered
///         as a signer. Revocation is immediate and requires the same.
///
///         Revocation is TERMINAL: a revoked agentId can never be re-registered
///         or re-attested, and the id is permanently consumed. Off-chain callers
///         must surface this as revoked, never as "paused" — there is no unpause.
///
///         Signatures are verified through {BrainSignatureChecker}, so a tenant
///         signer may be an EOA or an ERC-1271 smart-contract wallet (Safe).
contract BrainMCPAgentRegistry {
    using BrainSignatureChecker for address;

    struct AgentRegistration {
        bytes32 agentId;
        address agentAddress;
        bytes32 tenantId;
        bytes32 scopeHash;
        /// @dev keccak256(model_id, model_version, prompt_template_hash, tool_manifest_hash).
        ///      Pins the agent's behavior; the §6 gate (check 1.5) rejects runtime
        ///      execution whose behaviorHash differs from this registered value.
        bytes32 behaviorHash;
        uint256 registeredAt;
        uint256 revokedAt;
    }

    event AgentRegistered(
        bytes32 indexed agentId,
        address indexed agentAddress,
        bytes32 indexed tenantId,
        bytes32 scopeHash,
        bytes32 behaviorHash
    );
    event AgentRevoked(bytes32 indexed agentId, bytes32 indexed tenantId);
    event AgentBehaviorUpdated(bytes32 indexed agentId, bytes32 indexed tenantId, bytes32 behaviorHash);
    event AgentScopeUpdated(bytes32 indexed agentId, bytes32 indexed tenantId, bytes32 scopeHash);
    event TenantSignerSet(bytes32 indexed tenantId, address indexed signer, bool allowed);
    event AdminTransferStarted(address indexed currentAdmin, address indexed pendingAdmin);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    /// @dev Registered agents keyed by agentId (global namespace). An id is
    ///      consumed permanently on first registration.
    mapping(bytes32 => AgentRegistration) private _agents;

    /// @dev Per-tenant allowlist of signer addresses. A tenant must have
    ///      at least one signer configured before any agent can be
    ///      registered for them.
    mapping(bytes32 => mapping(address => bool)) private _tenantSigners;

    /// @dev Count of active signers per tenant; zero means initialAdmin may
    ///      bootstrap. Using a counter (not a bool) allows re-bootstrap after
    ///      all signers are revoked, preventing permanent tenant lockout.
    mapping(bytes32 => uint256) private _tenantSignerCount;

    // EIP-712
    bytes32 private constant _REGISTER_TYPEHASH = keccak256(
        "AgentRegistration(bytes32 agentId,address agentAddress,bytes32 tenantId,bytes32 scopeHash,bytes32 behaviorHash)"
    );
    bytes32 private constant _REVOKE_WITH_NONCE_TYPEHASH =
        keccak256("AgentRevocation(bytes32 agentId,bytes32 tenantId,uint256 nonce)");
    bytes32 private constant _BEHAVIOR_WITH_NONCE_TYPEHASH =
        keccak256("AgentBehaviorUpdate(bytes32 agentId,bytes32 tenantId,bytes32 behaviorHash,uint256 nonce)");
    bytes32 private constant _SCOPE_WITH_NONCE_TYPEHASH =
        keccak256("AgentScopeUpdate(bytes32 agentId,bytes32 tenantId,bytes32 scopeHash,uint256 nonce)");
    bytes32 private constant _SIGNER_TYPEHASH =
        keccak256("TenantSignerChange(bytes32 tenantId,address signer,bool allowed,uint256 nonce)");
    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 private immutable _hashedName;
    bytes32 private immutable _hashedVersion;
    bytes32 private immutable _cachedDomainSeparator;
    uint256 private immutable _cachedChainId;

    /// @notice Bootstraps the first signer per tenant. Rotatable via
    ///         {transferAdmin} / {acceptAdmin}.
    address public initialAdmin;
    /// @notice Proposed next admin, who must call {acceptAdmin}.
    address public pendingAdmin;

    mapping(bytes32 => uint256) public signerNonce;
    mapping(bytes32 => uint256) public behaviorNonce;
    mapping(bytes32 => uint256) public scopeNonce;
    mapping(bytes32 => uint256) public revocationNonce;

    error AgentAlreadyRegistered(bytes32 agentId);
    error AgentNotRegistered(bytes32 agentId);
    error AgentRevokedError(bytes32 agentId);
    error InvalidSignature();
    error NotTenantSigner(address signer);
    error ZeroAddress();
    error TenantMismatch();
    error NotAdmin();
    error NotPendingAdmin();

    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        initialAdmin = admin;

        _hashedName = keccak256(bytes("Brain MCP Agent"));
        _hashedVersion = keccak256(bytes("1"));
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
        emit AdminTransferred(address(0), admin);
    }

    // --- Admin rotation ---------------------------------------------------

    /// @notice Begin a two-step admin rotation. Takes effect only when `next`
    ///         calls {acceptAdmin}.
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

    // --- Tenant signer management (EIP-712 signed by an existing signer, or
    //     initialAdmin for the very first signer of a tenant). -------------

    /// @param authSigner The address claimed to have produced `signature`.
    ///        Required for ERC-1271: a contract signature cannot be recovered
    ///        from, so the claimed signer must be supplied for the membership
    ///        check.
    function setTenantSigner(
        bytes32 tenantId,
        address signer,
        bool allowed,
        address authSigner,
        bytes calldata signature
    ) external {
        if (signer == address(0)) revert ZeroAddress();
        bytes32 digest = _hashSignerChange(tenantId, signer, allowed, signerNonce[tenantId]);
        if (!authSigner.isValidSignature(digest, signature)) revert InvalidSignature();

        bool authorized = _tenantSigners[tenantId][authSigner];
        // Bootstrap: first-ever signer must come from initialAdmin.
        bool firstSigner = !_hasAnySigner(tenantId);
        if (!authorized && !(firstSigner && authSigner == initialAdmin)) {
            revert NotTenantSigner(authSigner);
        }

        if (allowed && !_tenantSigners[tenantId][signer]) {
            _tenantSignerCount[tenantId] += 1;
        } else if (!allowed && _tenantSigners[tenantId][signer]) {
            _tenantSignerCount[tenantId] -= 1;
        }
        _tenantSigners[tenantId][signer] = allowed;
        signerNonce[tenantId] += 1;

        emit TenantSignerSet(tenantId, signer, allowed);
    }

    function isTenantSigner(bytes32 tenantId, address a) external view returns (bool) {
        return _tenantSigners[tenantId][a];
    }

    // --- Agent lifecycle -------------------------------------------------

    function registerAgent(
        bytes32 agentId,
        address agentAddress,
        bytes32 tenantId,
        bytes32 scopeHash,
        bytes32 behaviorHash,
        address authSigner,
        bytes calldata tenantSignature
    ) external {
        if (agentAddress == address(0)) revert ZeroAddress();
        if (_agents[agentId].registeredAt != 0) revert AgentAlreadyRegistered(agentId);

        bytes32 digest = _hashRegistration(agentId, agentAddress, tenantId, scopeHash, behaviorHash);
        _requireTenantSignature(tenantId, authSigner, digest, tenantSignature);

        _agents[agentId] = AgentRegistration({
            agentId: agentId,
            agentAddress: agentAddress,
            tenantId: tenantId,
            scopeHash: scopeHash,
            behaviorHash: behaviorHash,
            registeredAt: block.timestamp,
            revokedAt: 0
        });

        emit AgentRegistered(agentId, agentAddress, tenantId, scopeHash, behaviorHash);
    }

    /// @notice Promote an agent to a new behaviorHash. Requires fresh tenant
    ///         re-attestation (an EIP-712 signature over the new behaviorHash)
    ///         from a tenant signer — the on-chain analogue of re-signing the
    ///         ScopeAttestation when the model/prompt/tools change (2.3).
    function updateBehaviorHash(
        bytes32 agentId,
        bytes32 behaviorHash,
        address authSigner,
        bytes calldata tenantSignature
    ) external {
        AgentRegistration storage r = _liveAgent(agentId);

        bytes32 digest = _hashBehaviorUpdate(agentId, r.tenantId, behaviorHash, behaviorNonce[agentId]);
        _requireTenantSignature(r.tenantId, authSigner, digest, tenantSignature);

        behaviorNonce[agentId] += 1;
        r.behaviorHash = behaviorHash;
        emit AgentBehaviorUpdated(agentId, r.tenantId, behaviorHash);
    }

    /// @notice Re-scope a registered agent under fresh tenant attestation.
    /// @dev    scopeHash was previously immutable for an agent's whole life, so
    ///         changing an agent's permissions meant burning its agentId (the id
    ///         is globally unique and never freed) and minting a new one.
    function updateScopeHash(bytes32 agentId, bytes32 scopeHash, address authSigner, bytes calldata tenantSignature)
        external
    {
        AgentRegistration storage r = _liveAgent(agentId);

        bytes32 digest = _hashScopeUpdate(agentId, r.tenantId, scopeHash, scopeNonce[agentId]);
        _requireTenantSignature(r.tenantId, authSigner, digest, tenantSignature);

        scopeNonce[agentId] += 1;
        r.scopeHash = scopeHash;
        emit AgentScopeUpdated(agentId, r.tenantId, scopeHash);
    }

    /// @notice Permanently revoke an agent. Terminal: the agentId can never be
    ///         re-registered or re-attested.
    function revokeAgent(bytes32 agentId, address authSigner, bytes calldata tenantSignature) external {
        AgentRegistration storage r = _liveAgent(agentId);

        bytes32 digest = _hashRevocation(agentId, r.tenantId, revocationNonce[agentId]);
        _requireTenantSignature(r.tenantId, authSigner, digest, tenantSignature);

        revocationNonce[agentId] += 1;
        r.revokedAt = block.timestamp;
        emit AgentRevoked(agentId, r.tenantId);
    }

    // --- Views -----------------------------------------------------------

    /// @notice Whether `agentId` is a live registration belonging to `tenantId`.
    /// @dev    The tenant binding is the point: `_agents` is a GLOBAL namespace,
    ///         so an agent registered by one tenant must not satisfy an
    ///         authorization check made on behalf of another. Callers must use
    ///         this rather than reading {getAgent} and ignoring `tenantId`.
    function isAuthorized(bytes32 agentId, bytes32 tenantId) external view returns (bool) {
        AgentRegistration memory r = _agents[agentId];
        return r.registeredAt != 0 && r.revokedAt == 0 && r.tenantId == tenantId;
    }

    function getAgent(bytes32 agentId) external view returns (AgentRegistration memory) {
        return _agents[agentId];
    }

    function domainSeparator() public view returns (bytes32) {
        if (block.chainid == _cachedChainId) {
            return _cachedDomainSeparator;
        } else {
            return _buildDomainSeparator();
        }
    }

    // --- Internals -------------------------------------------------------

    /// @dev Load a registered, non-revoked agent or revert.
    function _liveAgent(bytes32 agentId) private view returns (AgentRegistration storage r) {
        r = _agents[agentId];
        if (r.registeredAt == 0) revert AgentNotRegistered(agentId);
        if (r.revokedAt != 0) revert AgentRevokedError(agentId);
    }

    /// @dev Verify `authSigner` signed `digest` AND is an authorized signer for
    ///      `tenantId`.
    function _requireTenantSignature(bytes32 tenantId, address authSigner, bytes32 digest, bytes calldata signature)
        private
        view
    {
        if (!authSigner.isValidSignature(digest, signature)) revert InvalidSignature();
        if (!_tenantSigners[tenantId][authSigner]) revert NotTenantSigner(authSigner);
    }

    function _hasAnySigner(bytes32 tenantId) private view returns (bool) {
        return _tenantSignerCount[tenantId] > 0;
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(abi.encode(_DOMAIN_TYPEHASH, _hashedName, _hashedVersion, block.chainid, address(this)));
    }

    function _hashRegistration(
        bytes32 agentId,
        address agentAddress,
        bytes32 tenantId,
        bytes32 scopeHash,
        bytes32 behaviorHash
    ) private view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(_REGISTER_TYPEHASH, agentId, agentAddress, tenantId, scopeHash, behaviorHash)
        );
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(), structHash));
    }

    function _hashBehaviorUpdate(bytes32 agentId, bytes32 tenantId, bytes32 behaviorHash, uint256 nonceValue)
        private
        view
        returns (bytes32)
    {
        bytes32 structHash =
            keccak256(abi.encode(_BEHAVIOR_WITH_NONCE_TYPEHASH, agentId, tenantId, behaviorHash, nonceValue));
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(), structHash));
    }

    function _hashScopeUpdate(bytes32 agentId, bytes32 tenantId, bytes32 scopeHash, uint256 nonceValue)
        private
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(_SCOPE_WITH_NONCE_TYPEHASH, agentId, tenantId, scopeHash, nonceValue));
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(), structHash));
    }

    function _hashRevocation(bytes32 agentId, bytes32 tenantId, uint256 nonceValue) private view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(_REVOKE_WITH_NONCE_TYPEHASH, agentId, tenantId, nonceValue));
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
}
