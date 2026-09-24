// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

interface IBrainSmartAccountTenantView {
    function tenantId() external view returns (bytes32);
}

/// @title BrainTenantAccountRegistry
/// @notice Authoritative tenant to BrainSmartAccount binding.
/// @dev First assignment is immediate so new tenants can start. Replacing an
///      existing account is delayed on-chain so account substitution cannot be
///      used to skip BrainSmartAccount grant delays.
contract BrainTenantAccountRegistry {
    struct PendingAccountChange {
        address account;
        uint256 executableAt;
        bool exists;
    }

    uint256 public constant ACCOUNT_CHANGE_DELAY = 24 hours;

    address public owner;
    address public pendingOwner;

    mapping(bytes32 => address) private _accounts;
    mapping(bytes32 => PendingAccountChange) private _pendingChanges;

    event TenantAccountAssigned(bytes32 indexed tenantId, address indexed account);
    event TenantAccountChangeScheduled(bytes32 indexed tenantId, address indexed account, uint256 executableAt);
    event TenantAccountChangeCancelled(bytes32 indexed tenantId, address indexed account);
    event TenantAccountChangeActivated(bytes32 indexed tenantId, address indexed account);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotPendingOwner();
    error ZeroAddress();
    error ZeroTenant();
    error AccountTenantMismatch(bytes32 expected, bytes32 actual);
    error NoPendingAccountChange(bytes32 tenantId);
    error PendingAccountChangeNotReady(bytes32 tenantId, uint256 executableAt);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
        owner = initialOwner;
    }

    function transferOwnership(address next) external onlyOwner {
        pendingOwner = next;
        emit OwnershipTransferStarted(owner, next);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        address previous = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(previous, owner);
    }

    function assignAccount(bytes32 tenantId, address account) external onlyOwner {
        _validateAccount(tenantId, account);
        address current = _accounts[tenantId];
        if (current == address(0)) {
            _accounts[tenantId] = account;
            _cancelPendingIfExists(tenantId);
            emit TenantAccountAssigned(tenantId, account);
            return;
        }
        if (current == account) {
            _cancelPendingIfExists(tenantId);
            return;
        }
        uint256 executableAt = block.timestamp + ACCOUNT_CHANGE_DELAY;
        PendingAccountChange storage pending = _pendingChanges[tenantId];
        if (pending.exists) emit TenantAccountChangeCancelled(tenantId, pending.account);
        pending.account = account;
        pending.executableAt = executableAt;
        pending.exists = true;
        emit TenantAccountChangeScheduled(tenantId, account, executableAt);
    }

    function activatePendingAccountChange(bytes32 tenantId) external onlyOwner {
        PendingAccountChange storage pending = _pendingChanges[tenantId];
        if (!pending.exists) revert NoPendingAccountChange(tenantId);
        if (block.timestamp < pending.executableAt) {
            revert PendingAccountChangeNotReady(tenantId, pending.executableAt);
        }
        address account = pending.account;
        _validateAccount(tenantId, account);
        _accounts[tenantId] = account;
        delete _pendingChanges[tenantId];
        emit TenantAccountChangeActivated(tenantId, account);
    }

    function cancelPendingAccountChange(bytes32 tenantId) external onlyOwner {
        PendingAccountChange storage pending = _pendingChanges[tenantId];
        if (!pending.exists) revert NoPendingAccountChange(tenantId);
        address account = pending.account;
        delete _pendingChanges[tenantId];
        emit TenantAccountChangeCancelled(tenantId, account);
    }

    function accountOf(bytes32 tenantId) external view returns (address) {
        return _accounts[tenantId];
    }

    function pendingAccountChange(bytes32 tenantId)
        external
        view
        returns (address account, uint256 executableAt, bool exists)
    {
        PendingAccountChange storage pending = _pendingChanges[tenantId];
        return (pending.account, pending.executableAt, pending.exists);
    }

    function _validateAccount(bytes32 tenantId, address account) private view {
        if (tenantId == bytes32(0)) revert ZeroTenant();
        if (account == address(0)) revert ZeroAddress();
        bytes32 actual = IBrainSmartAccountTenantView(account).tenantId();
        if (actual != tenantId) revert AccountTenantMismatch(tenantId, actual);
    }

    function _cancelPendingIfExists(bytes32 tenantId) private {
        PendingAccountChange storage pending = _pendingChanges[tenantId];
        if (pending.exists) {
            address account = pending.account;
            delete _pendingChanges[tenantId];
            emit TenantAccountChangeCancelled(tenantId, account);
        }
    }
}
