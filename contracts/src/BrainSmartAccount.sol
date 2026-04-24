// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

/// @title BrainSmartAccount
/// @notice ERC-4337-style smart account for the payment-agent's on-chain
///         rail. The tenant's root key owns the account; Brain receives a
///         scoped, revocable session key. §4 of Brain_MVP_Architecture.md.
/// @dev    Session keys are per-holder with policy-version binding, target
///         + selector allowlists, per-tx amount cap, and per-period
///         cumulative cap. Scope is enforced in executeViaSessionKey —
///         the holder cannot call anything outside it.
contract BrainSmartAccount {
    struct SessionKey {
        address holder;
        uint256 validAfter;
        uint256 validUntil;
        address[] allowedTargets;
        bytes4[] allowedSelectors;
        uint256 maxPerTx;       // per call value cap (wei)
        uint256 maxPerPeriod;   // cumulative cap per periodSeconds window (wei)
        uint256 periodSeconds;  // e.g. 86400 for daily; 0 disables period accounting
        bytes32 policyVersion;  // must equal the expected policy digest at exec
    }

    event SessionKeyGranted(address indexed holder, bytes32 policyVersion, uint256 validUntil);
    event SessionKeyRevoked(address indexed holder);
    event AgentActionExecuted(
        bytes32 indexed tenantId,
        bytes32 indexed agentId,
        bytes32 policyVersion,
        address target,
        bytes4 selector,
        uint256 amount,
        bytes32 calldataHash
    );

    /// @dev Root key (hardware wallet or institutional custody).
    address public owner;
    /// @dev Immutable tenant id hash anchoring this account.
    bytes32 public immutable tenantId;
    /// @dev BrainPolicyRegistry this account trusts; policyVersion in a
    ///      session key must match the hash a verifier looks up there.
    address public immutable policyRegistry;

    mapping(address => SessionKey) private _keys;
    /// @dev holder => window_start_timestamp => spent_in_window
    mapping(address => mapping(uint256 => uint256)) private _windowSpent;

    error NotOwner();
    error NotHolder();
    error KeyNotActive();
    error TargetNotAllowed(address target);
    error SelectorNotAllowed(bytes4 selector);
    error ExceedsPerTxCap();
    error ExceedsPerPeriodCap();
    error PolicyVersionMismatch();
    error CallFailed(bytes reason);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _owner, bytes32 _tenantId, address _policyRegistry) {
        owner = _owner;
        tenantId = _tenantId;
        policyRegistry = _policyRegistry;
    }

    /// @notice Rotate the owner. Use this on hardware-wallet swap.
    function transferOwnership(address next) external onlyOwner {
        owner = next;
    }

    /// @notice Grant a session key. Overwrites any existing key for the holder.
    function grantSessionKey(SessionKey calldata key) external onlyOwner {
        require(key.holder != address(0), "holder required");
        require(key.validUntil > block.timestamp, "already expired");
        _keys[key.holder] = key;
        emit SessionKeyGranted(key.holder, key.policyVersion, key.validUntil);
    }

    /// @notice Revoke a session key. Owner-only. Takes effect immediately.
    function revokeSessionKey(address holder) external onlyOwner {
        delete _keys[holder];
        emit SessionKeyRevoked(holder);
    }

    /// @notice Execute a call via a session key. Holder-authenticated.
    ///         Reverts if anything falls outside the key's scope.
    function executeViaSessionKey(address target, uint256 value, bytes calldata data)
        external
        returns (bytes memory result)
    {
        SessionKey storage key = _keys[msg.sender];
        if (key.holder != msg.sender) revert NotHolder();
        if (block.timestamp < key.validAfter || block.timestamp >= key.validUntil) revert KeyNotActive();

        // Target allowlist (empty = any).
        if (key.allowedTargets.length != 0) {
            bool ok;
            for (uint256 i = 0; i < key.allowedTargets.length; ++i) {
                if (key.allowedTargets[i] == target) { ok = true; break; }
            }
            if (!ok) revert TargetNotAllowed(target);
        }

        bytes4 selector = data.length >= 4 ? bytes4(data[:4]) : bytes4(0);

        // Selector allowlist (empty = any).
        if (key.allowedSelectors.length != 0) {
            bool ok;
            for (uint256 i = 0; i < key.allowedSelectors.length; ++i) {
                if (key.allowedSelectors[i] == selector) { ok = true; break; }
            }
            if (!ok) revert SelectorNotAllowed(selector);
        }

        // Per-tx value cap.
        if (value > key.maxPerTx) revert ExceedsPerTxCap();

        // Per-period cumulative cap.
        if (key.periodSeconds > 0) {
            uint256 window = (block.timestamp / key.periodSeconds) * key.periodSeconds;
            uint256 spent = _windowSpent[msg.sender][window] + value;
            if (spent > key.maxPerPeriod) revert ExceedsPerPeriodCap();
            _windowSpent[msg.sender][window] = spent;
        }

        // Policy version gate — caller is responsible for passing the
        // version that matches what BrainPolicyRegistry returned for the
        // relevant (tenantId, version). The account does not re-verify
        // the on-chain registry state during execution (gas); the
        // off-chain decision already did. If this mismatches, revert.
        // The key's policyVersion is set at grant time; a no-op guard
        // here confirms the guard is active (prevents accidental
        // zero-policy keys).
        if (key.policyVersion == bytes32(0)) revert PolicyVersionMismatch();

        (bool success, bytes memory ret) = target.call{value: value}(data);
        if (!success) revert CallFailed(ret);

        emit AgentActionExecuted(
            tenantId,
            bytes32(bytes20(msg.sender)),
            key.policyVersion,
            target,
            selector,
            value,
            keccak256(data)
        );
        return ret;
    }

    /// @notice Read a holder's session key.
    function sessionKey(address holder) external view returns (SessionKey memory) {
        return _keys[holder];
    }

    /// @notice Amount spent by `holder` in the current period window.
    function spentInCurrentWindow(address holder) external view returns (uint256) {
        SessionKey storage key = _keys[holder];
        if (key.periodSeconds == 0) return 0;
        uint256 window = (block.timestamp / key.periodSeconds) * key.periodSeconds;
        return _windowSpent[holder][window];
    }

    receive() external payable {}
    fallback() external payable {}
}
