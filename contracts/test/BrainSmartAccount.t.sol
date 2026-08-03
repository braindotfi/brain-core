// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {BrainSmartAccount} from "../src/BrainSmartAccount.sol";
import {BrainPolicyRegistry} from "../src/BrainPolicyRegistry.sol";

contract Target {
    uint256 public counter;

    event Ping(uint256 n);

    /// @dev `n` sits at calldata offset 4, so a CALL-mode key meters it.
    function ping(uint256 n) external payable {
        counter += n;
        emit Ping(n);
    }

    /// @dev No amount argument, so a CALL-mode key can never meter it.
    function noArgs() external pure returns (uint256) {
        return 1;
    }
}

/// @dev Minimal ERC20 stub — only the transfer-family selectors matter.
contract MockERC20 {
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public balanceOf;

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function increaseAllowance(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] += amount;
        return true;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }
}

/// @dev USDC stub: 6-decimal token to prove caps enforce in native units.
contract MockUSDC {
    mapping(address => uint256) public balanceOf;

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    /// @dev Non-standard selector used to prove ERC20 mode rejects
    ///      non-decodable selectors at grant time.
    function donateToCharity(uint256 amount) external {
        balanceOf[address(0xDEAD)] += amount;
        balanceOf[msg.sender] -= amount;
    }
}

/// @dev Stands in for BrainPolicyRegistry in the account unit tests. The real
///      registry is exercised end to end in test_M2_realRegistryBinding.
contract StubPolicyRegistry {
    mapping(bytes32 => mapping(bytes32 => bool)) private _registered;

    function setRegistered(bytes32 tenantId, bytes32 policyHash, bool value) external {
        _registered[tenantId][policyHash] = value;
    }

    function isRegisteredHash(bytes32 tenantId, bytes32 policyHash) external view returns (bool) {
        return _registered[tenantId][policyHash];
    }
}

/// @dev Re-entrancy probe. Acts as both holder AND target: when the account
///      calls back into `reenter()`, this contract tries to re-enter
///      executeViaSessionKey as itself (msg.sender == holder), which must be
///      blocked by the per-holder _locked guard (ReentrantCall).
contract ReentrantHolder {
    BrainSmartAccount public acct;
    bool public didReenter;
    bytes4 public caughtSelector;

    function setAcct(BrainSmartAccount a) external {
        acct = a;
    }

    function reenter(uint256 n) external payable {
        try acct.executeViaSessionKey(0, address(this), 0, abi.encodeCall(this.reenter, (n))) {
            didReenter = true;
        } catch (bytes memory err) {
            if (err.length >= 4) {
                caughtSelector = bytes4(err);
            }
        }
    }
}

contract BrainSmartAccountTest is Test {
    BrainSmartAccount internal acct;
    Target internal target;
    StubPolicyRegistry internal registry;

    address internal ownerKey = address(0xA11CE);
    address internal holder = address(0xB0B);
    address internal payee = address(0xBEEF);
    bytes32 internal constant TENANT = keccak256("tnt_x");
    bytes32 internal constant POLICY_VER = keccak256("pol-v1");

    /// @dev CALL mode meters the uint256 word right after the selector.
    uint256 internal constant PING_AMOUNT_OFFSET = 4;

    function setUp() public {
        // Fixed, deliberately period-unaligned start so window-boundary maths is
        // deterministic and not accidentally aligned to a 600s or 86400s edge.
        vm.warp(1_000_233);
        registry = new StubPolicyRegistry();
        registry.setRegistered(TENANT, POLICY_VER, true);
        acct = new BrainSmartAccount(ownerKey, TENANT, address(registry));
        target = new Target();
        vm.deal(address(acct), 100 ether);
    }

    // --- helpers ---------------------------------------------------------

    function _addrs(address a) internal pure returns (address[] memory out) {
        out = new address[](1);
        out[0] = a;
    }

    function _sels(bytes4 s) internal pure returns (bytes4[] memory out) {
        out = new bytes4[](1);
        out[0] = s;
    }

    /// @dev CALL-mode key over Target.ping, metering the `n` argument. Caps are
    ///      expressed in the same magnitudes the old value-metered tests used,
    ///      so their arithmetic carries over unchanged.
    function _grantBasicKey(address t) internal {
        _grantCallKeyFor(holder, t, 1 ether, 5 ether, 86_400);
    }

    function _grantCallKeyFor(address h, address t, uint256 perTx, uint256 perPeriod, uint256 period) internal {
        BrainSmartAccount.SessionKey memory key = BrainSmartAccount.SessionKey({
            holder: h,
            validAfter: block.timestamp,
            validUntil: block.timestamp + 3600,
            allowedTargets: _addrs(t),
            allowedSelectors: _sels(Target.ping.selector),
            capMode: BrainSmartAccount.CapMode.CALL,
            capToken: address(0),
            allowedRecipients: new address[](0),
            capAmountOffset: PING_AMOUNT_OFFSET,
            maxPerTx: perTx,
            maxPerPeriod: perPeriod,
            periodSeconds: period,
            policyVersion: POLICY_VER
        });
        vm.prank(ownerKey);
        acct.grantSessionKey(key);
    }

    /// @dev NATIVE-mode key: pure ETH transfer to `recipient`, no calldata.
    function _grantNativeKey(address recipient, uint256 perTx, uint256 perPeriod) internal {
        BrainSmartAccount.SessionKey memory key = BrainSmartAccount.SessionKey({
            holder: holder,
            validAfter: block.timestamp,
            validUntil: block.timestamp + 3600,
            allowedTargets: _addrs(recipient),
            allowedSelectors: new bytes4[](0),
            capMode: BrainSmartAccount.CapMode.NATIVE,
            capToken: address(0),
            allowedRecipients: new address[](0),
            capAmountOffset: 0,
            maxPerTx: perTx,
            maxPerPeriod: perPeriod,
            periodSeconds: 86_400,
            policyVersion: POLICY_VER
        });
        vm.prank(ownerKey);
        acct.grantSessionKey(key);
    }

    /// @dev ERC20-mode key bound to `token`, recipients `[payee]`.
    function _grantErc20Key(address token, bytes4[] memory selectors, uint256 perTx, uint256 perPeriod) internal {
        BrainSmartAccount.SessionKey memory key = BrainSmartAccount.SessionKey({
            holder: holder,
            validAfter: block.timestamp,
            validUntil: block.timestamp + 3600,
            allowedTargets: _addrs(token),
            allowedSelectors: selectors,
            capMode: BrainSmartAccount.CapMode.ERC20,
            capToken: token,
            allowedRecipients: _addrs(payee),
            capAmountOffset: 0,
            maxPerTx: perTx,
            maxPerPeriod: perPeriod,
            periodSeconds: 86_400,
            policyVersion: POLICY_VER
        });
        vm.prank(ownerKey);
        acct.grantSessionKey(key);
    }

    function _transferSels() internal pure returns (bytes4[] memory out) {
        out = new bytes4[](2);
        out[0] = 0xa9059cbb; // transfer(address,uint256)
        out[1] = 0x23b872dd; // transferFrom(address,address,uint256)
    }

    function _ping(uint256 n) internal pure returns (bytes memory) {
        return abi.encodeCall(Target.ping, (n));
    }

    // --- constructor validation (M1) -------------------------------------

    function test_M1_constructor_rejectsZeroOwner() public {
        vm.expectRevert(BrainSmartAccount.ZeroAddress.selector);
        new BrainSmartAccount(address(0), TENANT, address(registry));
    }

    function test_M1_constructor_rejectsZeroPolicyRegistry() public {
        vm.expectRevert(BrainSmartAccount.ZeroAddress.selector);
        new BrainSmartAccount(ownerKey, TENANT, address(0));
    }

    // --- grant authorization + validation --------------------------------

    function test_grant_onlyOwner() public {
        BrainSmartAccount.SessionKey memory key = BrainSmartAccount.SessionKey({
            holder: holder,
            validAfter: block.timestamp,
            validUntil: block.timestamp + 1,
            allowedTargets: _addrs(address(target)),
            allowedSelectors: _sels(Target.ping.selector),
            capMode: BrainSmartAccount.CapMode.CALL,
            capToken: address(0),
            allowedRecipients: new address[](0),
            capAmountOffset: PING_AMOUNT_OFFSET,
            maxPerTx: 1 ether,
            maxPerPeriod: 1 ether,
            periodSeconds: 0,
            policyVersion: POLICY_VER
        });

        vm.expectRevert(BrainSmartAccount.NotOwner.selector);
        acct.grantSessionKey(key);
    }

    /// An empty target allowlist was a "permit anything" footgun.
    function test_grant_rejectsEmptyTargets() public {
        BrainSmartAccount.SessionKey memory key;
        key.holder = holder;
        key.validUntil = block.timestamp + 3600;
        key.allowedSelectors = _sels(Target.ping.selector);
        key.policyVersion = POLICY_VER;

        vm.prank(ownerKey);
        vm.expectRevert(BrainSmartAccount.TargetsRequired.selector);
        acct.grantSessionKey(key);
    }

    /// An empty selector allowlist is a footgun in CALL and ERC20 mode.
    function test_grant_rejectsEmptySelectorsInCallMode() public {
        BrainSmartAccount.SessionKey memory key;
        key.holder = holder;
        key.validAfter = block.timestamp;
        key.validUntil = block.timestamp + 3600;
        key.allowedTargets = _addrs(address(target));
        key.capMode = BrainSmartAccount.CapMode.CALL;
        key.capAmountOffset = PING_AMOUNT_OFFSET;
        key.policyVersion = POLICY_VER;

        vm.prank(ownerKey);
        vm.expectRevert(BrainSmartAccount.SelectorsRequired.selector);
        acct.grantSessionKey(key);
    }

    /// Zero policyVersion is rejected at GRANT.
    function test_grant_rejectsZeroPolicyVersion() public {
        BrainSmartAccount.SessionKey memory key;
        key.holder = holder;
        key.validAfter = block.timestamp;
        key.validUntil = block.timestamp + 3600;
        key.allowedTargets = _addrs(address(target));
        key.allowedSelectors = _sels(Target.ping.selector);
        key.capMode = BrainSmartAccount.CapMode.CALL;
        key.capAmountOffset = PING_AMOUNT_OFFSET;
        key.policyVersion = bytes32(0);

        vm.prank(ownerKey);
        vm.expectRevert(BrainSmartAccount.PolicyVersionMismatch.selector);
        acct.grantSessionKey(key);
    }

    function test_grant_rejectsAlreadyExpiredKey() public {
        BrainSmartAccount.SessionKey memory key;
        key.holder = holder;
        key.validAfter = 0;
        key.validUntil = block.timestamp; // not strictly in the future
        key.allowedTargets = _addrs(address(target));
        key.allowedSelectors = _sels(Target.ping.selector);
        key.capMode = BrainSmartAccount.CapMode.CALL;
        key.capAmountOffset = PING_AMOUNT_OFFSET;
        key.policyVersion = POLICY_VER;

        vm.prank(ownerKey);
        vm.expectRevert(BrainSmartAccount.KeyExpired.selector);
        acct.grantSessionKey(key);
    }

    /// A validAfter at or past validUntil yields a key that can never execute,
    /// and (since windows anchor to validAfter) nonsensical spend accounting.
    function test_grant_rejectsInvertedValidityWindow() public {
        BrainSmartAccount.SessionKey memory key;
        key.holder = holder;
        key.validAfter = block.timestamp + 4000;
        key.validUntil = block.timestamp + 3600;
        key.allowedTargets = _addrs(address(target));
        key.allowedSelectors = _sels(Target.ping.selector);
        key.capMode = BrainSmartAccount.CapMode.CALL;
        key.capAmountOffset = PING_AMOUNT_OFFSET;
        key.policyVersion = POLICY_VER;

        vm.prank(ownerKey);
        vm.expectRevert(
            abi.encodeWithSelector(BrainSmartAccount.InvalidValidityWindow.selector, key.validAfter, key.validUntil)
        );
        acct.grantSessionKey(key);
    }

    // --- M2: the policy binding is real ----------------------------------

    /// The policyRegistry immutable used to be stored and never read, so
    /// "policy-version binding" was an unverified field.
    function test_M2_grant_rejectsUnregisteredPolicyHash() public {
        bytes32 unregistered = keccak256("never-registered");
        BrainSmartAccount.SessionKey memory key;
        key.holder = holder;
        key.validAfter = block.timestamp;
        key.validUntil = block.timestamp + 3600;
        key.allowedTargets = _addrs(address(target));
        key.allowedSelectors = _sels(Target.ping.selector);
        key.capMode = BrainSmartAccount.CapMode.CALL;
        key.capAmountOffset = PING_AMOUNT_OFFSET;
        key.policyVersion = unregistered;

        vm.prank(ownerKey);
        vm.expectRevert(abi.encodeWithSelector(BrainSmartAccount.PolicyVersionNotRegistered.selector, unregistered));
        acct.grantSessionKey(key);
    }

    function _signDigest(uint256 pk, bytes32 domain, bytes32 structHash) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked(hex"1901", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    /// @dev Deploy a real BrainPolicyRegistry with POLICY_VER registered for TENANT.
    function _realRegistryWithPolicy(uint256 pk) private returns (BrainPolicyRegistry real) {
        address signerAddr = vm.addr(pk);
        real = new BrainPolicyRegistry(signerAddr);
        bytes32 domain = real.domainSeparator();

        real.setTenantSigner(
            TENANT,
            signerAddr,
            true,
            signerAddr,
            _signDigest(
                pk,
                domain,
                keccak256(
                    abi.encode(
                        keccak256("TenantSignerChange(bytes32 tenantId,address signer,bool allowed,uint256 nonce)"),
                        TENANT,
                        signerAddr,
                        true,
                        uint256(0)
                    )
                )
            )
        );

        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _signDigest(
            pk,
            domain,
            keccak256(
                abi.encode(
                    keccak256("PolicyRegistration(bytes32 tenantId,uint256 version,bytes32 policyHash)"),
                    TENANT,
                    uint256(1),
                    POLICY_VER
                )
            )
        );
        real.registerPolicy(TENANT, 1, POLICY_VER, _addrs(signerAddr), sigs);
    }

    /// End-to-end against the REAL BrainPolicyRegistry, not the stub.
    function test_M2_realRegistryBinding() public {
        BrainPolicyRegistry real = _realRegistryWithPolicy(0xF00D);
        assertTrue(real.isRegisteredHash(TENANT, POLICY_VER));

        BrainSmartAccount bound = new BrainSmartAccount(ownerKey, TENANT, address(real));
        BrainSmartAccount.SessionKey memory key = BrainSmartAccount.SessionKey({
            holder: holder,
            validAfter: block.timestamp,
            validUntil: block.timestamp + 3600,
            allowedTargets: _addrs(address(target)),
            allowedSelectors: _sels(Target.ping.selector),
            capMode: BrainSmartAccount.CapMode.CALL,
            capToken: address(0),
            allowedRecipients: new address[](0),
            capAmountOffset: PING_AMOUNT_OFFSET,
            maxPerTx: 1 ether,
            maxPerPeriod: 5 ether,
            periodSeconds: 86_400,
            policyVersion: POLICY_VER
        });
        vm.prank(ownerKey);
        bound.grantSessionKey(key);
        assertEq(bound.sessionKey(holder).policyVersion, POLICY_VER);

        // A hash the tenant never registered is refused by the same account.
        key.policyVersion = keccak256("pol-v2");
        vm.prank(ownerKey);
        vm.expectRevert(
            abi.encodeWithSelector(BrainSmartAccount.PolicyVersionNotRegistered.selector, key.policyVersion)
        );
        bound.grantSessionKey(key);
    }

    // --- execute happy path + scope enforcement --------------------------

    function test_execute_happyPath() public {
        _grantBasicKey(address(target));
        vm.prank(holder);
        acct.executeViaSessionKey(0, address(target), 0, _ping(0.5 ether));
        assertEq(target.counter(), 0.5 ether);
        assertEq(acct.spentInCurrentWindow(holder), 0.5 ether);
    }

    function test_execute_rejectsNonHolder() public {
        _grantBasicKey(address(target));
        vm.expectRevert(BrainSmartAccount.NotHolder.selector);
        acct.executeViaSessionKey(0, address(target), 0, _ping(1));
    }

    function test_execute_rejectsTargetNotAllowed() public {
        _grantBasicKey(address(target));
        vm.prank(holder);
        vm.expectRevert(abi.encodeWithSelector(BrainSmartAccount.TargetNotAllowed.selector, address(0xDEAD)));
        acct.executeViaSessionKey(0, address(0xDEAD), 0, _ping(1));
    }

    function test_execute_rejectsSelectorNotAllowed() public {
        _grantBasicKey(address(target));
        vm.prank(holder);
        vm.expectRevert(abi.encodeWithSelector(BrainSmartAccount.SelectorNotAllowed.selector, bytes4(0xdeadbeef)));
        acct.executeViaSessionKey(0, address(target), 0, hex"deadbeef");
    }

    function test_execute_rejectsPerTxOverCap() public {
        _grantBasicKey(address(target));
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.ExceedsPerTxCap.selector);
        acct.executeViaSessionKey(0, address(target), 0, _ping(2 ether));
    }

    function test_execute_rejectsPerPeriodOverCap() public {
        _grantBasicKey(address(target));
        vm.startPrank(holder);
        for (uint256 i = 0; i < 5; ++i) {
            acct.executeViaSessionKey(i, address(target), 0, _ping(1 ether));
        }
        vm.expectRevert(BrainSmartAccount.ExceedsPerPeriodCap.selector);
        acct.executeViaSessionKey(5, address(target), 0, _ping(1 ether));
        vm.stopPrank();
    }

    function test_revoke_disables() public {
        _grantBasicKey(address(target));
        vm.prank(ownerKey);
        acct.revokeSessionKey(holder);
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.NotHolder.selector);
        acct.executeViaSessionKey(0, address(target), 0, _ping(1));
    }

    // --- H1: window is anchored to validAfter, not the unix epoch --------

    /// A per-task key's lifetime equals one period, so an epoch-aligned window
    /// almost always had a boundary inside it: the key could spend its full
    /// cumulative cap TWICE. The window now anchors to validAfter.
    function test_H1_perTaskKeyCannotDoubleSpendAcrossEpochBoundary() public {
        uint256 amount = 1 ether;
        // validAfter = 1_000_233, validUntil = 1_000_833, period = 600.
        // The epoch-aligned boundary at 1_000_800 falls INSIDE that lifetime.
        _grantCallKeyFor(holder, address(target), amount, amount, 600);
        // Shorten the key to exactly one period so it is a true per-task key.
        assertEq(acct.sessionKey(holder).validAfter, 1_000_233);

        vm.prank(holder);
        acct.executeViaSessionKey(0, address(target), 0, _ping(amount));
        assertEq(acct.spentInCurrentWindow(holder), amount);

        // Cross the epoch-aligned 600s boundary while the key is still valid.
        vm.warp(1_000_800);
        assertLt(block.timestamp, acct.sessionKey(holder).validUntil);

        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.ExceedsPerPeriodCap.selector);
        acct.executeViaSessionKey(1, address(target), 0, _ping(amount));

        // Still the same anchored window, so the spend is unchanged.
        assertEq(acct.spentInCurrentWindow(holder), amount);
    }

    /// A genuinely long-lived key still rolls over once a full period elapses
    /// FROM ITS OWN ANCHOR.
    function test_H1_windowRollsOverAfterAFullPeriodFromAnchor() public {
        _grantCallKeyFor(holder, address(target), 1 ether, 1 ether, 600);
        vm.prank(holder);
        acct.executeViaSessionKey(0, address(target), 0, _ping(1 ether));

        vm.warp(1_000_233 + 600);
        assertEq(acct.spentInCurrentWindow(holder), 0);
        vm.prank(holder);
        acct.executeViaSessionKey(1, address(target), 0, _ping(1 ether));
        assertEq(acct.spentInCurrentWindow(holder), 1 ether);
    }

    // --- H3: CALL mode meters the declared calldata amount ---------------

    /// A contract call used to pass caps with capAmount = msg.value = 0, so an
    /// escrow release was entirely un-metered by the session key.
    function test_H3_callModeMetersCalldataAmountNotValue() public {
        _grantBasicKey(address(target));
        // value is 0 but the calldata amount is over the per-tx cap.
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.ExceedsPerTxCap.selector);
        acct.executeViaSessionKey(0, address(target), 0, _ping(1 ether + 1));
    }

    function test_H3_callModeRejectsValue() public {
        _grantBasicKey(address(target));
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.ValueNotAllowedInCallMode.selector);
        acct.executeViaSessionKey(0, address(target), 1 wei, _ping(1));
    }

    function test_H3_callModeRejectsCalldataTooShortForOffset() public {
        _grantCallKeyFor(holder, address(target), 1 ether, 5 ether, 86_400);
        // noArgs() carries no amount word, so it can never be metered.
        BrainSmartAccount.SessionKey memory key = BrainSmartAccount.SessionKey({
            holder: holder,
            validAfter: block.timestamp,
            validUntil: block.timestamp + 3600,
            allowedTargets: _addrs(address(target)),
            allowedSelectors: _sels(Target.noArgs.selector),
            capMode: BrainSmartAccount.CapMode.CALL,
            capToken: address(0),
            allowedRecipients: new address[](0),
            capAmountOffset: PING_AMOUNT_OFFSET,
            maxPerTx: 1 ether,
            maxPerPeriod: 5 ether,
            periodSeconds: 86_400,
            policyVersion: POLICY_VER
        });
        vm.prank(ownerKey);
        acct.grantSessionKey(key);

        vm.prank(holder);
        vm.expectRevert(
            abi.encodeWithSelector(BrainSmartAccount.CalldataTooShortForCapOffset.selector, uint256(4), uint256(36))
        );
        acct.executeViaSessionKey(0, address(target), 0, abi.encodeCall(Target.noArgs, ()));
    }

    function test_H3_grant_rejectsUnalignedCapAmountOffset() public {
        BrainSmartAccount.SessionKey memory key;
        key.holder = holder;
        key.validAfter = block.timestamp;
        key.validUntil = block.timestamp + 3600;
        key.allowedTargets = _addrs(address(target));
        key.allowedSelectors = _sels(Target.ping.selector);
        key.capMode = BrainSmartAccount.CapMode.CALL;
        key.capAmountOffset = 5; // not word-aligned after the 4-byte selector
        key.policyVersion = POLICY_VER;

        vm.prank(ownerKey);
        vm.expectRevert(abi.encodeWithSelector(BrainSmartAccount.InvalidCapAmountOffset.selector, uint256(5)));
        acct.grantSessionKey(key);
    }

    // --- H4: NATIVE mode forbids calldata outright -----------------------

    function test_H4_nativeMode_capAppliesToValue() public {
        _grantNativeKey(payee, 1 ether, 5 ether);
        vm.prank(holder);
        acct.executeViaSessionKey(0, payee, 1 ether, "");
        assertEq(payee.balance, 1 ether);

        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.ExceedsPerTxCap.selector);
        acct.executeViaSessionKey(1, payee, 1 ether + 1, "");
    }

    /// The old NATIVE mode metered msg.value only and denied a hardcoded list of
    /// three ERC20 selectors, so ANY other value-moving selector (increaseAllowance,
    /// permit, transferWithAuthorization) passed with capAmount = 0. Calldata is
    /// now forbidden outright, which removes the denylist entirely.
    function test_H4_nativeMode_rejectsAnyCalldata() public {
        MockERC20 token = new MockERC20();
        _grantNativeKey(address(token), 1 ether, 5 ether);

        bytes memory data = abi.encodeCall(MockERC20.increaseAllowance, (address(0xDEAD), type(uint256).max));
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.CalldataNotAllowedInNativeMode.selector);
        acct.executeViaSessionKey(0, address(token), 0, data);
    }

    function test_H4_grant_nativeModeRejectsSelectorAllowlist() public {
        BrainSmartAccount.SessionKey memory key;
        key.holder = holder;
        key.validAfter = block.timestamp;
        key.validUntil = block.timestamp + 3600;
        key.allowedTargets = _addrs(address(target));
        key.allowedSelectors = _sels(Target.ping.selector);
        key.capMode = BrainSmartAccount.CapMode.NATIVE;
        key.policyVersion = POLICY_VER;

        vm.prank(ownerKey);
        vm.expectRevert(BrainSmartAccount.SelectorsNotAllowedInNativeMode.selector);
        acct.grantSessionKey(key);
    }

    // --- H2: ERC20 recipient binding -------------------------------------

    /// In ERC20 mode the only allowed TARGET is the token contract, so without a
    /// recipient allowlist the payee was an unchecked calldata argument.
    function test_H2_erc20_rejectsUnlistedRecipient() public {
        MockERC20 token = new MockERC20();
        token.mint(address(acct), 1000e18);
        _grantErc20Key(address(token), _transferSels(), 100e18, 500e18);

        bytes memory data = abi.encodeCall(MockERC20.transfer, (address(0xDEAD), 1e18));
        vm.prank(holder);
        vm.expectRevert(abi.encodeWithSelector(BrainSmartAccount.RecipientNotAllowed.selector, address(0xDEAD)));
        acct.executeViaSessionKey(0, address(token), 0, data);
    }

    function test_H2_erc20_allowsListedRecipient() public {
        MockERC20 token = new MockERC20();
        token.mint(address(acct), 1000e18);
        _grantErc20Key(address(token), _transferSels(), 100e18, 500e18);

        vm.prank(holder);
        acct.executeViaSessionKey(0, address(token), 0, abi.encodeCall(MockERC20.transfer, (payee, 1e18)));
        assertEq(token.balanceOf(payee), 1e18);
    }

    function test_H2_erc20_transferFromRecipientIsBound() public {
        address alice = address(0xA11CE2);
        MockERC20 token = new MockERC20();
        token.mint(alice, 1000e18);
        vm.prank(alice);
        token.approve(address(acct), type(uint256).max);
        _grantErc20Key(address(token), _transferSels(), 100e18, 500e18);

        // `to` is the bound field, not `from`.
        bytes memory bad = abi.encodeCall(MockERC20.transferFrom, (alice, address(0xDEAD), 1e18));
        vm.prank(holder);
        vm.expectRevert(abi.encodeWithSelector(BrainSmartAccount.RecipientNotAllowed.selector, address(0xDEAD)));
        acct.executeViaSessionKey(0, address(token), 0, bad);

        vm.prank(holder);
        acct.executeViaSessionKey(0, address(token), 0, abi.encodeCall(MockERC20.transferFrom, (alice, payee, 1e18)));
        assertEq(token.balanceOf(payee), 1e18);
    }

    function test_H2_grant_erc20RequiresRecipients() public {
        MockERC20 token = new MockERC20();
        BrainSmartAccount.SessionKey memory key;
        key.holder = holder;
        key.validAfter = block.timestamp;
        key.validUntil = block.timestamp + 3600;
        key.allowedTargets = _addrs(address(token));
        key.allowedSelectors = _transferSels();
        key.capMode = BrainSmartAccount.CapMode.ERC20;
        key.capToken = address(token);
        key.policyVersion = POLICY_VER;

        vm.prank(ownerKey);
        vm.expectRevert(BrainSmartAccount.RecipientsRequired.selector);
        acct.grantSessionKey(key);
    }

    // --- H5: approve is not grantable ------------------------------------

    /// An allowance outlives the accounting window, so a holder could grant a
    /// fresh maxPerPeriod allowance every window and accumulate claimable value
    /// far past the cumulative cap.
    function test_H5_grant_rejectsApproveInErc20Mode() public {
        MockERC20 token = new MockERC20();
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = 0x095ea7b3; // approve(address,uint256)

        BrainSmartAccount.SessionKey memory key;
        key.holder = holder;
        key.validAfter = block.timestamp;
        key.validUntil = block.timestamp + 3600;
        key.allowedTargets = _addrs(address(token));
        key.allowedSelectors = selectors;
        key.capMode = BrainSmartAccount.CapMode.ERC20;
        key.capToken = address(token);
        key.allowedRecipients = _addrs(payee);
        key.policyVersion = POLICY_VER;

        vm.prank(ownerKey);
        vm.expectRevert(BrainSmartAccount.ApproveNotPermittedInErc20Mode.selector);
        acct.grantSessionKey(key);
    }

    // --- ERC20 caps in token units ---------------------------------------

    function test_erc20_transfer_respectsPerTxCap() public {
        MockERC20 token = new MockERC20();
        token.mint(address(acct), 1000e18);
        _grantErc20Key(address(token), _transferSels(), 100e18, 500e18);

        vm.prank(holder);
        acct.executeViaSessionKey(0, address(token), 0, abi.encodeCall(MockERC20.transfer, (payee, 100e18)));

        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.ExceedsPerTxCap.selector);
        acct.executeViaSessionKey(1, address(token), 0, abi.encodeCall(MockERC20.transfer, (payee, 100e18 + 1)));
    }

    function test_erc20_transferFrom_respectsPerTxCap() public {
        address alice = address(0xA11CE2);
        MockERC20 token = new MockERC20();
        token.mint(alice, 1000e18);
        vm.prank(alice);
        token.approve(address(acct), type(uint256).max);
        _grantErc20Key(address(token), _transferSels(), 100e18, 500e18);

        bytes memory data = abi.encodeCall(MockERC20.transferFrom, (alice, payee, 101e18));
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.ExceedsPerTxCap.selector);
        acct.executeViaSessionKey(0, address(token), 0, data);
    }

    function test_erc20_transfer_respectsPerPeriodCap() public {
        MockERC20 token = new MockERC20();
        token.mint(address(acct), 1000e18);
        _grantErc20Key(address(token), _transferSels(), 100e18, 500e18);

        bytes memory data = abi.encodeCall(MockERC20.transfer, (payee, 100e18));
        vm.startPrank(holder);
        for (uint256 i = 0; i < 5; ++i) {
            acct.executeViaSessionKey(i, address(token), 0, data);
        }
        vm.expectRevert(BrainSmartAccount.ExceedsPerPeriodCap.selector);
        acct.executeViaSessionKey(5, address(token), 0, data);
        vm.stopPrank();
    }

    function testFuzz_erc20CapBypass(uint128 tokenAmt) public {
        if (tokenAmt <= 100e18) return;
        MockERC20 token = new MockERC20();
        token.mint(address(acct), type(uint256).max);
        _grantErc20Key(address(token), _transferSels(), 100e18, 500e18);

        bytes memory data = abi.encodeCall(MockERC20.transfer, (payee, tokenAmt));
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.ExceedsPerTxCap.selector);
        acct.executeViaSessionKey(0, address(token), 0, data);
    }

    /// Caps denominated in USDC (6dp) enforce in USDC raw units.
    function test_usdc6dp_capEnforcesInTokenUnits() public {
        MockUSDC usdc = new MockUSDC();
        usdc.mint(address(acct), 1000 * 1e6);
        bytes4[] memory sels = _sels(0xa9059cbb);
        _grantErc20Key(address(usdc), sels, 100 * 1e6, 1000 * 1e6);

        vm.prank(holder);
        acct.executeViaSessionKey(0, address(usdc), 0, abi.encodeCall(MockUSDC.transfer, (payee, 100 * 1e6)));
        assertEq(usdc.balanceOf(payee), 100 * 1e6);

        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.ExceedsPerTxCap.selector);
        acct.executeViaSessionKey(1, address(usdc), 0, abi.encodeCall(MockUSDC.transfer, (payee, 100 * 1e6 + 1)));
    }

    /// Caps denominated in an 18-decimal ERC20 enforce in those units.
    function test_dai18dp_capEnforcesInTokenUnits() public {
        MockERC20 dai = new MockERC20();
        dai.mint(address(acct), 1000 ether);
        _grantErc20Key(address(dai), _sels(0xa9059cbb), 100 ether, 1000 ether);

        vm.prank(holder);
        acct.executeViaSessionKey(0, address(dai), 0, abi.encodeCall(MockERC20.transfer, (payee, 100 ether)));

        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.ExceedsPerTxCap.selector);
        acct.executeViaSessionKey(1, address(dai), 0, abi.encodeCall(MockERC20.transfer, (payee, 100 ether + 1)));
    }

    /// ERC20 mode rejects a non-decodable selector at grant time.
    function test_grant_rejectsNonDecodableSelectorInErc20Mode() public {
        MockUSDC usdc = new MockUSDC();
        BrainSmartAccount.SessionKey memory key;
        key.holder = holder;
        key.validAfter = block.timestamp;
        key.validUntil = block.timestamp + 3600;
        key.allowedTargets = _addrs(address(usdc));
        key.allowedSelectors = _sels(MockUSDC.donateToCharity.selector);
        key.capMode = BrainSmartAccount.CapMode.ERC20;
        key.capToken = address(usdc);
        key.allowedRecipients = _addrs(payee);
        key.policyVersion = POLICY_VER;

        vm.prank(ownerKey);
        vm.expectRevert(
            abi.encodeWithSelector(
                BrainSmartAccount.NonDecodableSelectorInErc20Mode.selector, MockUSDC.donateToCharity.selector
            )
        );
        acct.grantSessionKey(key);
    }

    /// ERC20 mode requires allowedTargets == [capToken].
    function test_grant_rejectsTargetMismatchInErc20Mode() public {
        MockUSDC usdc = new MockUSDC();
        address[] memory targets = new address[](2);
        targets[0] = address(usdc);
        targets[1] = address(target);

        BrainSmartAccount.SessionKey memory key;
        key.holder = holder;
        key.validAfter = block.timestamp;
        key.validUntil = block.timestamp + 3600;
        key.allowedTargets = targets;
        key.allowedSelectors = _sels(0xa9059cbb);
        key.capMode = BrainSmartAccount.CapMode.ERC20;
        key.capToken = address(usdc);
        key.allowedRecipients = _addrs(payee);
        key.policyVersion = POLICY_VER;

        vm.prank(ownerKey);
        vm.expectRevert(BrainSmartAccount.CapTokenAllowlistMismatch.selector);
        acct.grantSessionKey(key);
    }

    function test_execute_rejectsValueInErc20Mode() public {
        MockERC20 dai = new MockERC20();
        dai.mint(address(acct), 1000 ether);
        _grantErc20Key(address(dai), _sels(0xa9059cbb), 100 ether, 1000 ether);

        vm.deal(address(acct), 1 ether);
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.ValueNotAllowedInErc20Mode.selector);
        acct.executeViaSessionKey(0, address(dai), 1 wei, abi.encodeCall(MockERC20.transfer, (payee, 10 ether)));
    }

    function test_execute_rejectsWrongTargetInErc20Mode() public {
        MockERC20 dai = new MockERC20();
        MockERC20 other = new MockERC20();
        dai.mint(address(acct), 1000 ether);
        _grantErc20Key(address(dai), _sels(0xa9059cbb), 100 ether, 1000 ether);

        vm.prank(holder);
        vm.expectRevert(abi.encodeWithSelector(BrainSmartAccount.TargetNotAllowed.selector, address(other)));
        acct.executeViaSessionKey(0, address(other), 0, abi.encodeCall(MockERC20.transfer, (payee, 10 ether)));
    }

    // --- replay nonce ----------------------------------------------------

    function test_nonce_startsAtZero() public {
        _grantBasicKey(address(target));
        assertEq(acct.nonce(holder), 0);
    }

    function test_nonce_incrementsOnAcceptedExecute() public {
        _grantBasicKey(address(target));
        vm.prank(holder);
        acct.executeViaSessionKey(0, address(target), 0, _ping(0.5 ether));
        assertEq(acct.nonce(holder), 1);
        vm.prank(holder);
        acct.executeViaSessionKey(1, address(target), 0, _ping(0.5 ether));
        assertEq(acct.nonce(holder), 2);
    }

    function test_execute_replayRevertsWithStaleNonce() public {
        _grantBasicKey(address(target));
        vm.prank(holder);
        acct.executeViaSessionKey(0, address(target), 0, _ping(0.5 ether));
        vm.prank(holder);
        vm.expectRevert(abi.encodeWithSelector(BrainSmartAccount.BadNonce.selector, uint256(1), uint256(0)));
        acct.executeViaSessionKey(0, address(target), 0, _ping(0.5 ether));
    }

    function test_execute_rejectsFutureNonce() public {
        _grantBasicKey(address(target));
        vm.prank(holder);
        vm.expectRevert(abi.encodeWithSelector(BrainSmartAccount.BadNonce.selector, uint256(0), uint256(7)));
        acct.executeViaSessionKey(7, address(target), 0, _ping(0.5 ether));
    }

    function test_execute_revertDoesNotConsumeNonce() public {
        _grantBasicKey(address(target));
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.ExceedsPerTxCap.selector);
        acct.executeViaSessionKey(0, address(target), 0, _ping(2 ether));
        assertEq(acct.nonce(holder), 0);
        vm.prank(holder);
        acct.executeViaSessionKey(0, address(target), 0, _ping(0.5 ether));
        assertEq(acct.nonce(holder), 1);
    }

    // --- re-entrancy guard -----------------------------------------------

    function test_execute_blocksReentrancy() public {
        ReentrantHolder rh = new ReentrantHolder();
        rh.setAcct(acct);
        address rhAddr = address(rh);

        BrainSmartAccount.SessionKey memory key = BrainSmartAccount.SessionKey({
            holder: rhAddr,
            validAfter: block.timestamp,
            validUntil: block.timestamp + 3600,
            allowedTargets: _addrs(rhAddr),
            allowedSelectors: _sels(ReentrantHolder.reenter.selector),
            capMode: BrainSmartAccount.CapMode.CALL,
            capToken: address(0),
            allowedRecipients: new address[](0),
            capAmountOffset: PING_AMOUNT_OFFSET,
            maxPerTx: 1 ether,
            maxPerPeriod: 5 ether,
            periodSeconds: 86_400,
            policyVersion: POLICY_VER
        });
        vm.prank(ownerKey);
        acct.grantSessionKey(key);

        vm.prank(rhAddr);
        acct.executeViaSessionKey(0, rhAddr, 0, abi.encodeCall(ReentrantHolder.reenter, (1)));

        assertFalse(rh.didReenter());
        assertEq(rh.caughtSelector(), BrainSmartAccount.ReentrantCall.selector);
        assertEq(acct.nonce(rhAddr), 1);
    }

    // --- revoked key never executes --------------------------------------

    function test_revokedKeyCannotExecute() public {
        _grantBasicKey(address(target));
        vm.prank(ownerKey);
        acct.revokeSessionKey(holder);

        for (uint256 i = 0; i < 5; ++i) {
            vm.prank(holder);
            vm.expectRevert(BrainSmartAccount.NotHolder.selector);
            acct.executeViaSessionKey(0, address(target), 0, _ping(1));
        }
    }

    // --- fuzz ------------------------------------------------------------

    function testFuzz_perTxCap(uint128 amount) public {
        _grantBasicKey(address(target));
        if (amount <= 1 ether) return;
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.ExceedsPerTxCap.selector);
        acct.executeViaSessionKey(0, address(target), 0, _ping(amount));
    }

    function testFuzz_nonceMonotonic(uint8 raw) public {
        _grantBasicKey(address(target));
        uint256 calls = uint256(raw) % 6; // <=5 x 0.5 ether stays within the 5-ether period cap
        vm.startPrank(holder);
        for (uint256 i = 0; i < calls; ++i) {
            assertEq(acct.nonce(holder), i);
            acct.executeViaSessionKey(i, address(target), 0, _ping(0.5 ether));
            assertEq(acct.nonce(holder), i + 1);
        }
        vm.stopPrank();
    }

    // --- kill-switch: pause vs revoke ------------------------------------

    function test_pause_onlyOwner() public {
        _grantBasicKey(address(target));
        vm.expectRevert(BrainSmartAccount.NotOwner.selector);
        acct.pauseSessionKey(holder);
    }

    function test_pause_blocksExecution() public {
        _grantBasicKey(address(target));
        vm.prank(ownerKey);
        acct.pauseSessionKey(holder);
        assertTrue(acct.isSessionKeyPaused(holder));

        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.KeyPaused.selector);
        acct.executeViaSessionKey(0, address(target), 0, _ping(0.5 ether));
    }

    function test_pause_preservesKeyRecordLimitsAndWindowSpend() public {
        _grantBasicKey(address(target));
        vm.prank(holder);
        acct.executeViaSessionKey(0, address(target), 0, _ping(0.5 ether));
        assertEq(acct.spentInCurrentWindow(holder), 0.5 ether);

        vm.prank(ownerKey);
        acct.pauseSessionKey(holder);

        BrainSmartAccount.SessionKey memory key = acct.sessionKey(holder);
        assertEq(key.holder, holder);
        assertEq(key.maxPerTx, 1 ether);
        assertEq(acct.spentInCurrentWindow(holder), 0.5 ether);

        vm.prank(ownerKey);
        acct.unpauseSessionKey(holder);
        assertFalse(acct.isSessionKeyPaused(holder));

        vm.prank(holder);
        acct.executeViaSessionKey(1, address(target), 0, _ping(0.5 ether));
        assertEq(target.counter(), 1 ether);
        assertEq(acct.spentInCurrentWindow(holder), 1 ether);
    }

    function test_revoke_isPermanentRemoval() public {
        _grantBasicKey(address(target));
        vm.prank(ownerKey);
        acct.revokeSessionKey(holder);
        assertEq(acct.sessionKey(holder).holder, address(0));
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.NotHolder.selector);
        acct.executeViaSessionKey(0, address(target), 0, _ping(0.5 ether));
    }

    // --- per-task minimum-privilege session key --------------------------

    function test_perTaskKey_allowsExactlyOneTransferThenExhausts() public {
        _grantCallKeyFor(holder, address(target), 1 ether, 1 ether, 600);
        vm.prank(holder);
        acct.executeViaSessionKey(0, address(target), 0, _ping(1 ether));

        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.ExceedsPerPeriodCap.selector);
        acct.executeViaSessionKey(1, address(target), 0, _ping(1 ether));
    }

    function test_perTaskKey_rejectsOverAmountAndExpiry() public {
        _grantCallKeyFor(holder, address(target), 1 ether, 1 ether, 600);

        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.ExceedsPerTxCap.selector);
        acct.executeViaSessionKey(0, address(target), 0, _ping(2 ether));

        vm.warp(block.timestamp + 3601);
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.KeyNotActive.selector);
        acct.executeViaSessionKey(0, address(target), 0, _ping(1 ether));
    }

    // --- two-step ownership ----------------------------------------------

    function test_transferOwnership_isTwoStep() public {
        address newOwner = address(0xC0FFEE);
        vm.prank(ownerKey);
        acct.transferOwnership(newOwner);
        assertEq(acct.owner(), ownerKey);
        assertEq(acct.pendingOwner(), newOwner);

        vm.prank(newOwner);
        acct.acceptOwnership();
        assertEq(acct.owner(), newOwner);
        assertEq(acct.pendingOwner(), address(0));
    }

    function test_transferOwnership_onlyOwner() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert(BrainSmartAccount.NotOwner.selector);
        acct.transferOwnership(address(0xC0FFEE));
    }

    function test_acceptOwnership_onlyPendingOwner() public {
        address newOwner = address(0xC0FFEE);
        vm.prank(ownerKey);
        acct.transferOwnership(newOwner);
        vm.prank(address(0xDEAD));
        vm.expectRevert(BrainSmartAccount.NotPendingOwner.selector);
        acct.acceptOwnership();
        assertEq(acct.owner(), ownerKey);
    }

    function test_transferOwnership_cancel() public {
        address newOwner = address(0xC0FFEE);
        vm.prank(ownerKey);
        acct.transferOwnership(newOwner);
        vm.prank(ownerKey);
        acct.transferOwnership(address(0));
        assertEq(acct.pendingOwner(), address(0));
        vm.prank(newOwner);
        vm.expectRevert(BrainSmartAccount.NotPendingOwner.selector);
        acct.acceptOwnership();
        assertEq(acct.owner(), ownerKey);
    }

    function test_acceptOwnership_transfersOwnerPowers() public {
        address newOwner = address(0xC0FFEE);
        vm.prank(ownerKey);
        acct.transferOwnership(newOwner);
        vm.prank(newOwner);
        acct.acceptOwnership();

        vm.prank(ownerKey);
        vm.expectRevert(BrainSmartAccount.NotOwner.selector);
        acct.pauseSessionKey(holder);

        vm.prank(newOwner);
        acct.pauseSessionKey(holder);
        assertTrue(acct.isSessionKeyPaused(holder));
    }

    // --- account-wide kill-switch ----------------------------------------

    function test_pauseAll_onlyOwner() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert(BrainSmartAccount.NotOwner.selector);
        acct.pauseAll();
    }

    function test_pauseAll_blocksAllHoldersRegardlessOfPerHolderState() public {
        address holder2 = address(0xB0B2);
        _grantBasicKey(address(target));
        _grantCallKeyFor(holder2, address(target), 1 ether, 5 ether, 86_400);
        assertFalse(acct.isAccountPaused());

        vm.prank(ownerKey);
        acct.pauseAll();
        assertTrue(acct.isAccountPaused());

        assertFalse(acct.isSessionKeyPaused(holder));
        assertFalse(acct.isSessionKeyPaused(holder2));
        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.AccountIsPaused.selector);
        acct.executeViaSessionKey(0, address(target), 0, _ping(0.5 ether));
        vm.prank(holder2);
        vm.expectRevert(BrainSmartAccount.AccountIsPaused.selector);
        acct.executeViaSessionKey(0, address(target), 0, _ping(0.5 ether));
    }

    function test_unpauseAll_restoresPriorPerHolderState() public {
        address holder2 = address(0xB0B2);
        _grantBasicKey(address(target));
        _grantCallKeyFor(holder2, address(target), 1 ether, 5 ether, 86_400);

        vm.prank(ownerKey);
        acct.pauseSessionKey(holder);
        vm.prank(ownerKey);
        acct.pauseAll();

        vm.prank(ownerKey);
        acct.unpauseAll();
        assertFalse(acct.isAccountPaused());

        vm.prank(holder);
        vm.expectRevert(BrainSmartAccount.KeyPaused.selector);
        acct.executeViaSessionKey(0, address(target), 0, _ping(0.5 ether));

        vm.prank(holder2);
        acct.executeViaSessionKey(0, address(target), 0, _ping(0.5 ether));
        assertEq(target.counter(), 0.5 ether);
    }

    // --- M13: the execution event names the real holder -------------------

    /// The holder was previously emitted as bytes32(bytes20(msg.sender)) under
    /// the name `agentId`, which decoded to a mangled value in indexers.
    function test_M13_eventEmitsHolderAddress() public {
        _grantBasicKey(address(target));
        vm.recordLogs();
        vm.prank(holder);
        acct.executeViaSessionKey(0, address(target), 0, _ping(0.5 ether));

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("AgentActionExecuted(bytes32,address,bytes32,address,bytes4,uint256,bytes32)");
        bool found;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics.length == 3 && logs[i].topics[0] == sig) {
                assertEq(logs[i].topics[1], TENANT);
                assertEq(address(uint160(uint256(logs[i].topics[2]))), holder);
                found = true;
            }
        }
        assertTrue(found, "AgentActionExecuted not emitted");
    }

    // --- allowlist bound --------------------------------------------------

    function test_grant_rejectsOversizedAllowlist() public {
        address[] memory targets = new address[](33);
        for (uint256 i = 0; i < 33; ++i) {
            targets[i] = address(uint160(i + 1));
        }
        BrainSmartAccount.SessionKey memory key;
        key.holder = holder;
        key.validAfter = block.timestamp;
        key.validUntil = block.timestamp + 3600;
        key.allowedTargets = targets;
        key.allowedSelectors = _sels(Target.ping.selector);
        key.capMode = BrainSmartAccount.CapMode.CALL;
        key.capAmountOffset = PING_AMOUNT_OFFSET;
        key.policyVersion = POLICY_VER;

        vm.prank(ownerKey);
        vm.expectRevert(abi.encodeWithSelector(BrainSmartAccount.AllowlistTooLarge.selector, uint256(32)));
        acct.grantSessionKey(key);
    }

    // --- no payable fallback ---------------------------------------------

    /// An unknown selector must revert, not silently succeed.
    function test_unknownSelectorReverts() public {
        (bool ok,) = address(acct).call(hex"deadbeef");
        assertFalse(ok);
    }

    function test_receivesPlainValue() public {
        uint256 before = address(acct).balance;
        (bool ok,) = address(acct).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(acct).balance, before + 1 ether);
    }
}
