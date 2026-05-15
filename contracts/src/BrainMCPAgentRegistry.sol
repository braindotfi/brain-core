// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

/// @title BrainMCPAgentRegistry
/// @notice Public registry of third-party agents authorized to connect to a
///         tenant's MCP interface. On-chain scope attestation — any observer
///         can verify which agents have which permissions without trusting
///         Brain's off-chain records. §4 of Brain_MVP_Architecture.md.
/// @dev    Third-party agents cannot self-register. Registration requires an
///         EIP-712 signature from an address the tenant has pre-registered
///         as a signer. Revocation is immediate and requires the same.
contract BrainMCPAgentRegistry {
    struct AgentRegistration {
        bytes32 agentId;
        address agentAddress;
        bytes32 tenantId;
        bytes32 scopeHash;
        uint256 registeredAt;
        uint256 revokedAt;
    }

    event AgentRegistered(
        bytes32 indexed agentId,
        address indexed agentAddress,
        bytes32 indexed tenantId,
        bytes32 scopeHash
    );
    event AgentRevoked(bytes32 indexed agentId, bytes32 indexed tenantId);
    event TenantSignerSet(bytes32 indexed tenantId, address indexed signer, bool allowed);

    /// @dev Registered agents keyed by agentId (global namespace).
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
        "AgentRegistration(bytes32 agentId,address agentAddress,bytes32 tenantId,bytes32 scopeHash)"
    );
    bytes32 private constant _REVOKE_TYPEHASH = keccak256("AgentRevocation(bytes32 agentId,bytes32 tenantId)");
    bytes32 private constant _SIGNER_TYPEHASH = keccak256("TenantSignerChange(bytes32 tenantId,address signer,bool allowed,uint256 nonce)");
    bytes32 private constant _DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    bytes32 private immutable _hashedName;
    bytes32 private immutable _hashedVersion;
    bytes32 private immutable _cachedDomainSeparator;
    uint256 private immutable _cachedChainId;

    address public immutable initialAdmin;
    mapping(bytes32 => uint256) public signerNonce;

    error AgentAlreadyRegistered(bytes32 agentId);
    error AgentNotRegistered(bytes32 agentId);
    error AgentRevokedError(bytes32 agentId);
    error InvalidSignature();
    error NotTenantSigner(address signer);
    error ZeroAddress();
    error TenantMismatch();

    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        initialAdmin = admin;

        _hashedName = keccak256(bytes("Brain MCP Agent"));
        _hashedVersion = keccak256(bytes("1"));
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
    }

    // --- Tenant signer management (EIP-712 signed by an existing signer, or
    //     initialAdmin for the very first signer of a tenant). -------------

    function setTenantSigner(
        bytes32 tenantId,
        address signer,
        bool allowed,
        address authSigner,
        bytes calldata signature
    ) external {
        bytes32 digest = _hashSignerChange(tenantId, signer, allowed, signerNonce[tenantId]);
        address recovered = _recover(digest, signature);
        if (recovered == address(0)) revert InvalidSignature();

        bool authorized = (_tenantSigners[tenantId][recovered] && recovered == authSigner);
        // Bootstrap: first-ever signer must come from initialAdmin.
        bool firstSigner = !_hasAnySigner(tenantId);
        if (!authorized && !(firstSigner && recovered == initialAdmin)) {
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
        bytes calldata tenantSignature
    ) external {
        if (agentAddress == address(0)) revert ZeroAddress();
        if (_agents[agentId].registeredAt != 0) revert AgentAlreadyRegistered(agentId);

        bytes32 digest = _hashRegistration(agentId, agentAddress, tenantId, scopeHash);
        address recovered = _recover(digest, tenantSignature);
        if (recovered == address(0) || !_tenantSigners[tenantId][recovered]) {
            revert NotTenantSigner(recovered);
        }

        _agents[agentId] = AgentRegistration({
            agentId: agentId,
            agentAddress: agentAddress,
            tenantId: tenantId,
            scopeHash: scopeHash,
            registeredAt: block.timestamp,
            revokedAt: 0
        });

        emit AgentRegistered(agentId, agentAddress, tenantId, scopeHash);
    }

    function revokeAgent(bytes32 agentId, bytes calldata tenantSignature) external {
        AgentRegistration storage r = _agents[agentId];
        if (r.registeredAt == 0) revert AgentNotRegistered(agentId);
        if (r.revokedAt != 0) revert AgentRevokedError(agentId);

        bytes32 digest = _hashRevocation(agentId, r.tenantId);
        address recovered = _recover(digest, tenantSignature);
        if (recovered == address(0) || !_tenantSigners[r.tenantId][recovered]) {
            revert NotTenantSigner(recovered);
        }

        r.revokedAt = block.timestamp;
        emit AgentRevoked(agentId, r.tenantId);
    }

    // --- Views -----------------------------------------------------------

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

    function _hasAnySigner(bytes32 tenantId) private view returns (bool) {
        return _tenantSignerCount[tenantId] > 0;
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                _DOMAIN_TYPEHASH,
                _hashedName,
                _hashedVersion,
                block.chainid,
                address(this)
            )
        );
    }

    function _hashRegistration(
        bytes32 agentId,
        address agentAddress,
        bytes32 tenantId,
        bytes32 scopeHash
    ) private view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(_REGISTER_TYPEHASH, agentId, agentAddress, tenantId, scopeHash));
        return keccak256(abi.encodePacked(hex"19_01", domainSeparator(), structHash));
    }

    function _hashRevocation(bytes32 agentId, bytes32 tenantId) private view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(_REVOKE_TYPEHASH, agentId, tenantId));
        return keccak256(abi.encodePacked(hex"19_01", domainSeparator(), structHash));
    }

    function _hashSignerChange(
        bytes32 tenantId,
        address signer,
        bool allowed,
        uint256 nonce
    ) private view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(_SIGNER_TYPEHASH, tenantId, signer, allowed, nonce));
        return keccak256(abi.encodePacked(hex"19_01", domainSeparator(), structHash));
    }

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
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            return address(0);
        }
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
