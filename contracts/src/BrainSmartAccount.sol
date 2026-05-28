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
    /// @dev Kill-switch: execution disabled but the key record is preserved.
    event SessionKeyPaused(address indexed holder);
    event SessionKeyResumed(address indexed holder);
    /// @dev Account-wide kill-switch: blocks every holder at once, independent
    ///      of per-holder pause state.
    event AccountPaused();
    event AccountResumed();
    /// @dev Two-step ownership rotation (Ownable2Step): a transfer is proposed,
    ///      then accepted by the pending owner before it takes effect.
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
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
    /// @dev Two-step ownership: the proposed next owner, who must call
    ///      acceptOwnership() to take control. Zero when no transfer is pending.
    address public pendingOwner;
    /// @dev Immutable tenant id hash anchoring this account.
    bytes32 public immutable tenantId;
    /// @dev BrainPolicyRegistry this account trusts; policyVersion in a
    ///      session key must match the hash a verifier looks up there.
    address public immutable policyRegistry;

    mapping(address => SessionKey) private _keys;
    /// @dev holder => window_start_timestamp => spent_in_window
    mapping(address => mapping(uint256 => uint256)) private _windowSpent;
    /// @dev Kill-switch flag. Paused keys cannot execute but keep their record,
    ///      window spend, limits, and metadata so resume needs no re-grant.
    mapping(address => bool) private _paused;
    /// @dev H-03: per-holder replay nonce. Each execute must supply the current
    ///      value; it increments by 1 on every accepted execute.
    mapping(address => uint256) private _nonces;
    /// @dev H-03: per-holder re-entrancy guard for the external call.
    mapping(address => bool) private _locked;
    /// @dev Account-wide kill-switch. When set, NO holder can execute,
    ///      regardless of per-holder pause state. Owner-controlled.
    bool private _allPaused;

    error NotOwner();
    error NotHolder();
    error KeyPaused();
    error KeyNotActive();
    error KeyExpired();
    error ZeroAddress();
    error TargetNotAllowed(address target);
    error SelectorNotAllowed(bytes4 selector);
    error ExceedsPerTxCap();
    error ExceedsPerPeriodCap();
    error PolicyVersionMismatch();
    error CallFailed(bytes reason);
    // H-03 hardening.
    error TargetsRequired();
    error SelectorsRequired();
    error ReentrantCall();
    error BadNonce(uint256 expected, uint256 supplied);
    // Two-step ownership + account-wide pause hardening.
    error NotPendingOwner();
    error AccountIsPaused();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _owner, bytes32 _tenantId, address _policyRegistry) {
        owner = _owner;
        tenantId = _tenantId;
        policyRegistry = _policyRegistry;
    }

    /// @notice Begin a two-step owner rotation (e.g. a hardware-wallet swap).
    ///         The transfer does NOT take effect until `next` calls
    ///         acceptOwnership(). A one-step rotation to a mistyped or
    ///         uncontrolled address would permanently brick the account, so
    ///         ownership only moves once the incoming key proves control.
    /// @param  next The proposed next owner, or address(0) to cancel a pending
    ///         transfer.
    function transferOwnership(address next) external onlyOwner {
        pendingOwner = next;
        emit OwnershipTransferStarted(owner, next);
    }

    /// @notice Complete a two-step owner rotation. Callable only by the address
    ///         named in a prior transferOwnership; clears the pending slot.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        address previous = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(previous, owner);
    }

    /// @notice Grant a session key. Overwrites any existing key for the holder.
    /// @dev H-03: an empty target/selector allowlist is a footgun ("any" was
    ///      previously allowed), so require both non-empty, and require a real
    ///      policyVersion at grant time (moved here from executeViaSessionKey).
    function grantSessionKey(SessionKey calldata key) external onlyOwner {
        if (key.holder == address(0)) revert ZeroAddress();
        if (key.validUntil <= block.timestamp) revert KeyExpired();
        if (key.allowedTargets.length == 0) revert TargetsRequired();
        if (key.allowedSelectors.length == 0) revert SelectorsRequired();
        if (key.policyVersion == bytes32(0)) revert PolicyVersionMismatch();
        _keys[key.holder] = key;
        emit SessionKeyGranted(key.holder, key.policyVersion, key.validUntil);
    }

    /// @notice H-03: the next expected execute nonce for `holder`.
    function nonce(address holder) external view returns (uint256) {
        return _nonces[holder];
    }

    /// @notice Revoke a session key. Owner-only. Takes effect immediately.
    /// @dev    Final removal: deletes the key record entirely. Distinct from
    ///         pauseSessionKey, which preserves it. Also clears any pause flag.
    function revokeSessionKey(address holder) external onlyOwner {
        delete _keys[holder];
        delete _paused[holder];
        emit SessionKeyRevoked(holder);
    }

    /// @notice Pause a session key (kill-switch). Owner-only. Immediately
    ///         disables execution by this holder WITHOUT deleting the key
    ///         record, its window spend, limits, or metadata — so resume needs
    ///         no fresh grant/attestation. Idempotent. Distinct from
    ///         revokeSessionKey (permanent removal).
    function pauseSessionKey(address holder) external onlyOwner {
        _paused[holder] = true;
        emit SessionKeyPaused(holder);
    }

    /// @notice Resume a paused session key. Owner-only. Re-enables execution
    ///         under the key's existing scope and accumulated window spend.
    function unpauseSessionKey(address holder) external onlyOwner {
        _paused[holder] = false;
        emit SessionKeyResumed(holder);
    }

    /// @notice Whether `holder`'s session key is currently paused.
    function isSessionKeyPaused(address holder) external view returns (bool) {
        return _paused[holder];
    }

    /// @notice Account-wide kill-switch. Owner-only. Immediately blocks EVERY
    ///         holder's execution at once — the right blast-radius control during
    ///         a security incident, versus pausing N session keys individually.
    ///         Per-holder pause flags are left untouched, so unpauseAll() restores
    ///         exactly the pre-incident posture. Idempotent.
    function pauseAll() external onlyOwner {
        _allPaused = true;
        emit AccountPaused();
    }

    /// @notice Lift the account-wide pause. Owner-only. Holders that were paused
    ///         individually remain paused (their flag was never cleared).
    function unpauseAll() external onlyOwner {
        _allPaused = false;
        emit AccountResumed();
    }

    /// @notice Whether the account-wide kill-switch is currently engaged.
    function isAccountPaused() external view returns (bool) {
        return _allPaused;
    }

    /// @notice Execute a call via a session key. Holder-authenticated.
    ///         Reverts if anything falls outside the key's scope.
    function executeViaSessionKey(uint256 nonceSupplied, address target, uint256 value, bytes calldata data)
        external
        returns (bytes memory result)
    {
        // Account-wide kill-switch short-circuits every holder during an incident.
        if (_allPaused) revert AccountIsPaused();

        // H-03: re-entrancy guard — a malicious target cannot call back in.
        if (_locked[msg.sender]) revert ReentrantCall();

        SessionKey storage key = _keys[msg.sender];
        if (key.holder != msg.sender) revert NotHolder();
        if (_paused[msg.sender]) revert KeyPaused();
        if (block.timestamp < key.validAfter || block.timestamp >= key.validUntil) revert KeyNotActive();

        // H-03: replay nonce — each execute must supply the current value.
        if (nonceSupplied != _nonces[msg.sender]) revert BadNonce(_nonces[msg.sender], nonceSupplied);
        _nonces[msg.sender]++;

        _locked[msg.sender] = true;

        // Target allowlist. H-03 guarantees a granted key always has a
        // non-empty list, so the length guard is defense-in-depth only.
        if (key.allowedTargets.length != 0) {
            bool ok;
            for (uint256 i = 0; i < key.allowedTargets.length; ++i) {
                if (key.allowedTargets[i] == target) { ok = true; break; }
            }
            if (!ok) revert TargetNotAllowed(target);
        }

        bytes4 selector = data.length >= 4 ? bytes4(data[:4]) : bytes4(0);

        // Selector allowlist. As with targets, H-03 guarantees non-empty at
        // grant, so the length guard is defense-in-depth only.
        if (key.allowedSelectors.length != 0) {
            bool ok;
            for (uint256 i = 0; i < key.allowedSelectors.length; ++i) {
                if (key.allowedSelectors[i] == selector) { ok = true; break; }
            }
            if (!ok) revert SelectorNotAllowed(selector);
        }

        // Determine the effective amount subject to caps.
        // When value == 0 and the call targets a standard ERC20 method,
        // decode the token quantity from calldata. Without this, an agent
        // can bypass maxPerTx/maxPerPeriod by routing large token transfers
        // through calls with value=0.
        uint256 capAmount = value;
        if (value == 0 && data.length >= 4) {
            if ((selector == 0xa9059cbb || selector == 0x095ea7b3) && data.length >= 68) {
                // transfer(address,uint256) / approve(address,uint256): amount at [36,68)
                capAmount = uint256(bytes32(data[36:68]));
            } else if (selector == 0x23b872dd && data.length >= 100) {
                // transferFrom(address,address,uint256): amount at [68,100)
                capAmount = uint256(bytes32(data[68:100]));
            }
        }

        // Per-tx cap.
        if (capAmount > key.maxPerTx) revert ExceedsPerTxCap();

        // Per-period cumulative cap.
        if (key.periodSeconds > 0) {
            uint256 window = (block.timestamp / key.periodSeconds) * key.periodSeconds;
            uint256 spent = _windowSpent[msg.sender][window] + capAmount;
            if (spent > key.maxPerPeriod) revert ExceedsPerPeriodCap();
            _windowSpent[msg.sender][window] = spent;
        }

        // H-03: the policyVersion zero-check now lives in grantSessionKey
        // (a key can never be stored with a zero policyVersion), so it is
        // not re-checked here. The caller is still responsible for granting
        // a key whose policyVersion matches what BrainPolicyRegistry returned
        // for the relevant (tenantId, version); the account does not re-verify
        // the on-chain registry state during execution (gas) — the off-chain
        // decision already did.

        // Interaction. The nonce was already incremented and _locked set
        // above (checks-effects-interactions), so a malicious target cannot
        // replay or re-enter. Release the lock immediately after the call.
        (bool success, bytes memory ret) = target.call{value: value}(data);
        _locked[msg.sender] = false;
        if (!success) revert CallFailed(ret);

        emit AgentActionExecuted(
            tenantId,
            bytes32(bytes20(msg.sender)),
            key.policyVersion,
            target,
            selector,
            capAmount,
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
