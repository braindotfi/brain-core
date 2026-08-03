// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

/// @dev Minimal view surface of BrainPolicyRegistry used at grant time. Declared
///      inline so the account stays dependency-free (matches the other Brain
///      contracts).
interface IBrainPolicyRegistryView {
    function isRegisteredHash(bytes32 tenantId, bytes32 policyHash) external view returns (bool);
}

/// @title BrainSmartAccount
/// @notice Smart account with directly-called session keys for the
///         payment-agent's on-chain rail. The tenant's root key owns the
///         account; Brain receives a scoped, revocable session key.
///         §4 of Brain_MVP_Architecture.md.
/// @dev    Not ERC-4337: there is no EntryPoint, no UserOperation, no
///         paymaster. Holders call executeViaSessionKey directly and the
///         account enforces scope on every call.
///
///         Session keys are per-holder with policy-version binding, target
///         + selector allowlists, recipient binding, a per-tx amount cap, and a
///         per-period cumulative cap. Scope is enforced in executeViaSessionKey;
///         the holder cannot call anything outside it.
///
///         Three cap modes, declared explicitly at grant time. There is NO
///         un-metered call path: every mode either forbids calldata outright or
///         names exactly where the capped amount lives.
///
///           NATIVE  Pure value transfer. `data` MUST be empty and caps meter
///                   msg.value in wei. Because calldata is forbidden, a NATIVE
///                   key can never move ERC20 units, so there is no selector
///                   denylist to keep complete.
///           ERC20   Caps denominated in capToken's raw units (USDC=6dp).
///                   `target` MUST equal capToken, `value` MUST be 0, and the
///                   selector MUST be transfer or transferFrom. The RECIPIENT is
///                   decoded from calldata and must appear in allowedRecipients,
///                   so the key is bound to a counterparty and not merely to the
///                   token contract. `approve` is deliberately NOT permitted:
///                   an allowance outlives the accounting window and would let a
///                   holder accumulate claimable value past the cumulative cap.
///           CALL    Arbitrary allowlisted contract call (e.g. BrainEscrow
///                   release). `value` MUST be 0 and the capped amount is read
///                   from the uint256 word at `capAmountOffset`, declared and
///                   bounds-checked at grant time. This is what makes a contract
///                   call meterable instead of silently passing caps at zero.
contract BrainSmartAccount {
    /// @notice How a session key's caps are measured. See the contract docs.
    enum CapMode {
        NATIVE,
        ERC20,
        CALL
    }

    struct SessionKey {
        address holder;
        uint256 validAfter;
        uint256 validUntil;
        address[] allowedTargets;
        bytes4[] allowedSelectors;
        /// @dev Which cap rule applies. Validated exhaustively in grantSessionKey.
        CapMode capMode;
        /// @dev ERC20 mode only: the token whose raw units denominate the caps.
        ///      MUST be zero in NATIVE and CALL mode.
        address capToken;
        /// @dev ERC20 mode only: the permitted `to` addresses. MUST be empty in
        ///      NATIVE and CALL mode.
        address[] allowedRecipients;
        /// @dev CALL mode only: byte offset of the uint256 amount word within
        ///      calldata. MUST be zero in NATIVE and ERC20 mode.
        uint256 capAmountOffset;
        uint256 maxPerTx; // per-call cap in capToken units (or wei in NATIVE mode)
        uint256 maxPerPeriod; // cumulative cap per periodSeconds window (same units)
        uint256 periodSeconds; // e.g. 86400 for daily; 0 disables period accounting
        bytes32 policyVersion; // must be registered in BrainPolicyRegistry for this tenant
    }

    /// @dev ERC20 selector constants for cap-decode and grant-time validation.
    bytes4 private constant _SELECTOR_TRANSFER = 0xa9059cbb; // transfer(address,uint256)
    bytes4 private constant _SELECTOR_APPROVE = 0x095ea7b3; // approve(address,uint256)
    bytes4 private constant _SELECTOR_TRANSFER_FROM = 0x23b872dd; // transferFrom(address,address,uint256)

    /// @notice Upper bound on each allowlist. Keeps the linear scan in
    ///         executeViaSessionKey bounded, so a key can never be granted with
    ///         an allowlist too large to execute against.
    uint256 public constant MAX_ALLOWLIST = 32;

    event SessionKeyGranted(address indexed holder, bytes32 policyVersion, uint256 validUntil, CapMode capMode);
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
    /// @dev `holder` is the session-key EOA that authorized the call. It was
    ///      previously emitted as a bytes32-packed address under the name
    ///      `agentId`, which decoded to a mangled value in indexers.
    event AgentActionExecuted(
        bytes32 indexed tenantId,
        address indexed holder,
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
    /// @dev BrainPolicyRegistry this account trusts. A session key's
    ///      policyVersion must be a hash this registry has registered for
    ///      `tenantId`, checked in grantSessionKey.
    address public immutable policyRegistry;

    mapping(address => SessionKey) private _keys;
    /// @dev holder => window_start_timestamp => spent_in_window. Windows are
    ///      anchored to the key's validAfter, not to the unix epoch.
    mapping(address => mapping(uint256 => uint256)) private _windowSpent;
    /// @dev Kill-switch flag. Paused keys cannot execute but keep their record,
    ///      window spend, limits, and metadata so resume needs no re-grant.
    mapping(address => bool) private _paused;
    /// @dev H-03: per-holder replay nonce. Each execute must supply the current
    ///      value; it increments by 1 on every accepted execute. The holder is
    ///      already authenticated by msg.sender, so this is not signature-replay
    ///      protection: it exists so the execution outbox gets an on-chain
    ///      exactly-once guarantee, a racing re-dispatch reverting with BadNonce.
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
    // Cap-mode enforcement.
    error CapTokenAllowlistMismatch();
    error NonDecodableSelectorInErc20Mode(bytes4 selector);
    error ValueNotAllowedInErc20Mode();
    error TargetMustEqualCapTokenInErc20Mode();
    error ApproveNotPermittedInErc20Mode();
    error CapTokenNotAllowedInThisMode();
    error RecipientsRequired();
    error RecipientsNotAllowedInThisMode();
    error RecipientNotAllowed(address recipient);
    error SelectorsNotAllowedInNativeMode();
    error CalldataNotAllowedInNativeMode();
    error ValueNotAllowedInCallMode();
    error CapAmountOffsetNotAllowedInThisMode();
    error InvalidCapAmountOffset(uint256 offset);
    error MalformedErc20Calldata(uint256 length);
    error CalldataTooShortForCapOffset(uint256 length, uint256 required);
    error AllowlistTooLarge(uint256 maxAllowed);
    error InvalidValidityWindow(uint256 validAfter, uint256 validUntil);
    error PolicyVersionNotRegistered(bytes32 policyVersion);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _owner, bytes32 _tenantId, address _policyRegistry) {
        // A zero owner permanently bricks an account that can still receive
        // funds through receive(); a zero registry makes the policy binding
        // unverifiable. Both are fatal at construction.
        if (_owner == address(0) || _policyRegistry == address(0)) revert ZeroAddress();
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
    /// @dev Validation is exhaustive per cap mode so executeViaSessionKey can be
    ///      straight-line and every accepted key is guaranteed meterable. The
    ///      policyVersion must be a hash BrainPolicyRegistry has registered for
    ///      this account's tenant, so the binding is real rather than an unread
    ///      field.
    function grantSessionKey(SessionKey calldata key) external onlyOwner {
        if (key.holder == address(0)) revert ZeroAddress();
        if (key.validUntil <= block.timestamp) revert KeyExpired();
        if (key.validAfter >= key.validUntil) revert InvalidValidityWindow(key.validAfter, key.validUntil);
        if (key.allowedTargets.length == 0) revert TargetsRequired();
        if (key.policyVersion == bytes32(0)) revert PolicyVersionMismatch();
        if (
            key.allowedTargets.length > MAX_ALLOWLIST || key.allowedSelectors.length > MAX_ALLOWLIST
                || key.allowedRecipients.length > MAX_ALLOWLIST
        ) {
            revert AllowlistTooLarge(MAX_ALLOWLIST);
        }
        if (!IBrainPolicyRegistryView(policyRegistry).isRegisteredHash(tenantId, key.policyVersion)) {
            revert PolicyVersionNotRegistered(key.policyVersion);
        }

        if (key.capMode == CapMode.NATIVE) {
            // Pure value transfer. Forbidding calldata outright is what removes
            // the need for a selector denylist: no calldata means no token
            // movement, so there is nothing left to under-meter.
            if (key.allowedSelectors.length != 0) revert SelectorsNotAllowedInNativeMode();
            if (key.allowedRecipients.length != 0) revert RecipientsNotAllowedInThisMode();
            if (key.capToken != address(0)) revert CapTokenNotAllowedInThisMode();
            if (key.capAmountOffset != 0) revert CapAmountOffsetNotAllowedInThisMode();
        } else if (key.capMode == CapMode.ERC20) {
            if (key.capToken == address(0)) revert ZeroAddress();
            if (key.allowedTargets.length != 1 || key.allowedTargets[0] != key.capToken) {
                revert CapTokenAllowlistMismatch();
            }
            if (key.allowedSelectors.length == 0) revert SelectorsRequired();
            if (key.allowedRecipients.length == 0) revert RecipientsRequired();
            if (key.capAmountOffset != 0) revert CapAmountOffsetNotAllowedInThisMode();
            for (uint256 i = 0; i < key.allowedSelectors.length; ++i) {
                bytes4 s = key.allowedSelectors[i];
                if (s == _SELECTOR_APPROVE) revert ApproveNotPermittedInErc20Mode();
                if (s != _SELECTOR_TRANSFER && s != _SELECTOR_TRANSFER_FROM) {
                    revert NonDecodableSelectorInErc20Mode(s);
                }
            }
            for (uint256 i = 0; i < key.allowedRecipients.length; ++i) {
                if (key.allowedRecipients[i] == address(0)) revert ZeroAddress();
            }
        } else {
            // CapMode.CALL
            if (key.allowedSelectors.length == 0) revert SelectorsRequired();
            if (key.allowedRecipients.length != 0) revert RecipientsNotAllowedInThisMode();
            if (key.capToken != address(0)) revert CapTokenNotAllowedInThisMode();
            // The amount word must sit after the 4-byte selector and be
            // word-aligned, so it names a real ABI argument slot.
            if (key.capAmountOffset < 4 || (key.capAmountOffset - 4) % 32 != 0) {
                revert InvalidCapAmountOffset(key.capAmountOffset);
            }
        }

        _keys[key.holder] = key;
        emit SessionKeyGranted(key.holder, key.policyVersion, key.validUntil, key.capMode);
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

        // Target allowlist. grantSessionKey guarantees a non-empty list.
        bool targetOk;
        for (uint256 i = 0; i < key.allowedTargets.length; ++i) {
            if (key.allowedTargets[i] == target) {
                targetOk = true;
                break;
            }
        }
        if (!targetOk) revert TargetNotAllowed(target);

        bytes4 selector = data.length >= 4 ? bytes4(data[:4]) : bytes4(0);

        // Selector allowlist. Empty only in NATIVE mode, where calldata is
        // forbidden outright and the check in _capAmount is the stronger one.
        if (key.allowedSelectors.length != 0) {
            bool selectorOk;
            for (uint256 i = 0; i < key.allowedSelectors.length; ++i) {
                if (key.allowedSelectors[i] == selector) {
                    selectorOk = true;
                    break;
                }
            }
            if (!selectorOk) revert SelectorNotAllowed(selector);
        }

        uint256 capAmount = _capAmount(key, target, value, data);

        // Per-tx cap.
        if (capAmount > key.maxPerTx) revert ExceedsPerTxCap();

        // Per-period cumulative cap. The window is anchored to the key's
        // validAfter, NOT to the unix epoch. An epoch-aligned window let a key
        // whose lifetime straddled a boundary spend its full cumulative cap
        // twice, which defeated per-task keys entirely: their lifetime equals
        // one period, so a boundary almost always fell inside it.
        if (key.periodSeconds > 0) {
            uint256 elapsed = block.timestamp - key.validAfter;
            uint256 window = key.validAfter + (elapsed - (elapsed % key.periodSeconds));
            uint256 spent = _windowSpent[msg.sender][window] + capAmount;
            if (spent > key.maxPerPeriod) revert ExceedsPerPeriodCap();
            _windowSpent[msg.sender][window] = spent;
        }

        // Interaction. The nonce was already incremented and _locked set
        // above (checks-effects-interactions), so a malicious target cannot
        // replay or re-enter. Release the lock immediately after the call.
        (bool success, bytes memory ret) = target.call{value: value}(data);
        _locked[msg.sender] = false;
        if (!success) revert CallFailed(ret);

        emit AgentActionExecuted(tenantId, msg.sender, key.policyVersion, target, selector, capAmount, keccak256(data));
        return ret;
    }

    /// @dev Resolve the amount subject to caps for this call, enforcing the
    ///      per-mode calldata rules. Every mode yields a real number: there is
    ///      no path that returns zero for a value-moving call.
    function _capAmount(SessionKey storage key, address target, uint256 value, bytes calldata data)
        private
        view
        returns (uint256)
    {
        if (key.capMode == CapMode.NATIVE) {
            // Forbidding calldata is what makes the wei-denominated cap sound:
            // a call carrying data could move token units while value is zero.
            if (data.length != 0) revert CalldataNotAllowedInNativeMode();
            return value;
        }

        if (key.capMode == CapMode.ERC20) {
            if (value != 0) revert ValueNotAllowedInErc20Mode();
            if (target != key.capToken) revert TargetMustEqualCapTokenInErc20Mode();
            bytes4 selector = bytes4(data[:4]);
            address recipient;
            uint256 amount;
            if (selector == _SELECTOR_TRANSFER) {
                // transfer(address to, uint256 amount)
                if (data.length != 68) revert MalformedErc20Calldata(data.length);
                recipient = address(uint160(uint256(bytes32(data[4:36]))));
                amount = uint256(bytes32(data[36:68]));
            } else {
                // transferFrom(address from, address to, uint256 amount).
                // grantSessionKey admits no other selector in this mode.
                if (data.length != 100) revert MalformedErc20Calldata(data.length);
                recipient = address(uint160(uint256(bytes32(data[36:68]))));
                amount = uint256(bytes32(data[68:100]));
            }
            // Recipient binding. Without this the target allowlist is worthless
            // in ERC20 mode: the only allowed target IS the token contract, so
            // the payee lives in calldata and would otherwise be unchecked.
            bool recipientOk;
            for (uint256 i = 0; i < key.allowedRecipients.length; ++i) {
                if (key.allowedRecipients[i] == recipient) {
                    recipientOk = true;
                    break;
                }
            }
            if (!recipientOk) revert RecipientNotAllowed(recipient);
            return amount;
        }

        // CapMode.CALL
        if (value != 0) revert ValueNotAllowedInCallMode();
        uint256 required = key.capAmountOffset + 32;
        if (data.length < required) revert CalldataTooShortForCapOffset(data.length, required);
        return uint256(bytes32(data[key.capAmountOffset:required]));
    }

    /// @notice Read a holder's session key.
    function sessionKey(address holder) external view returns (SessionKey memory) {
        return _keys[holder];
    }

    /// @notice Amount spent by `holder` in the current period window.
    function spentInCurrentWindow(address holder) external view returns (uint256) {
        SessionKey storage key = _keys[holder];
        if (key.periodSeconds == 0) return 0;
        if (block.timestamp < key.validAfter) return 0;
        uint256 elapsed = block.timestamp - key.validAfter;
        uint256 window = key.validAfter + (elapsed - (elapsed % key.periodSeconds));
        return _windowSpent[holder][window];
    }

    /// @dev Plain value receipts only. There is deliberately no payable
    ///      fallback: an unknown selector must revert rather than silently
    ///      succeed, so a mistyped or removed function surfaces as a failure.
    receive() external payable {}
}
