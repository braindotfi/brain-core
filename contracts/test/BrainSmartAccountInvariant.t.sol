// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {BrainSmartAccount} from "../src/BrainSmartAccount.sol";
import {Target, StubPolicyRegistry} from "./BrainSmartAccount.t.sol";

/// @dev Drives executeViaSessionKey as the session-key HOLDER (the handler is
///      the holder, so msg.sender is already correct and no prank is needed).
///
///      Every call is wrapped in try/catch so the handler itself never reverts,
///      which is what lets `fail_on_revert = true` stay on: a run in which every
///      call reverted would otherwise "pass" while proving nothing. That is also
///      why `accepted` is asserted non-zero in afterInvariant().
contract SessionKeyHandler {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    BrainSmartAccount public immutable acct;
    address public immutable target;
    uint256 public immutable period;

    /// @dev Sum of amounts the account ACCEPTED, across all windows.
    uint256 public ghostSpent;
    /// @dev Same tally, split by accounting window, so the invariants stay valid
    ///      once time warps past a period boundary.
    mapping(uint256 => uint256) public ghostByWindow;
    uint256 public accepted;
    uint256 public rejected;

    /// @dev Must stay at zero. A dedicated counter, NOT a ghost-spend comparison:
    ///      the old out-of-scope invariant re-asserted the ghost/ledger equality
    ///      and credited a rogue success to BOTH sides, so it could not observe
    ///      the thing it was named for.
    uint256 public outOfScopeAccepted;
    /// @dev Must stay at zero. CALL mode forbids msg.value outright.
    uint256 public valueAccepted;

    constructor(BrainSmartAccount a, address t, uint256 p) {
        acct = a;
        target = t;
        period = p;
    }

    /// @dev Independent reimplementation of the account's window arithmetic, so
    ///      the invariants check the contract against a second implementation
    ///      rather than against itself.
    function currentWindow() public view returns (uint256) {
        uint256 anchor = acct.windowAnchor(address(this));
        uint256 elapsed = block.timestamp - anchor;
        return anchor + (elapsed - (elapsed % period));
    }

    /// @param rawAmount fuzzed; bounded so the run straddles the per-tx cap in
    ///        both directions rather than always overshooting.
    function execute(uint256 rawAmount) external {
        uint256 amount = rawAmount % 2 ether;
        uint256 n = acct.nonce(address(this));
        uint256 w = currentWindow();
        bytes memory data = abi.encodeCall(Target.ping, (amount));
        try acct.executeViaSessionKey(n, target, 0, data) {
            ghostSpent += amount;
            ghostByWindow[w] += amount;
            accepted += 1;
        } catch {
            rejected += 1;
        }
    }

    /// @dev Attempt a call outside the key's scope. Must ALWAYS be rejected.
    ///      Most fuzzed addresses are codeless, and `call{value: 0}` to an EOA
    ///      returns success — so if the target allowlist check were removed, this
    ///      would go through.
    function executeOutOfScope(uint256 rawAmount, address rogueTarget) external {
        uint256 amount = rawAmount % 2 ether;
        uint256 n = acct.nonce(address(this));
        if (rogueTarget == target) return; // in-scope; covered by execute()
        bytes memory data = abi.encodeCall(Target.ping, (amount));
        try acct.executeViaSessionKey(n, rogueTarget, 0, data) {
            outOfScopeAccepted += 1;
        } catch {
            rejected += 1;
        }
    }

    /// @dev Attempt a value-carrying call. CALL mode must reject every one, so
    ///      the account's ETH balance is provably untouched. Nothing exercised
    ///      this before, which made invariant_callModeNeverMovesValue vacuous.
    function executeWithValue(uint256 rawAmount, uint256 rawValue) external {
        uint256 amount = rawAmount % 2 ether;
        uint256 value = (rawValue % 1 ether) + 1; // always non-zero
        uint256 n = acct.nonce(address(this));
        bytes memory data = abi.encodeCall(Target.ping, (amount));
        try acct.executeViaSessionKey(n, target, value, data) {
            valueAccepted += 1;
        } catch {
            rejected += 1;
        }
    }

    /// @dev Advance time so the run actually crosses period boundaries. Bounded
    ///      well under the key's validUntil so the key does not simply expire and
    ///      turn the rest of the run into a no-op.
    function warp(uint256 rawSeconds) external {
        VM.warp(block.timestamp + (rawSeconds % (2 * period)) + 1);
    }
}

/// @notice Stateful invariants for BrainSmartAccount.
/// @dev    The contract previously had NONE. `test_invariant_revokedKeyCannotExecute`
///         in BrainSmartAccount.t.sol is a plain unit test whose name only looks
///         like an invariant, so the most complex and most dangerous contract in
///         the set had no state-space coverage at all.
contract BrainSmartAccountInvariantTest is Test {
    BrainSmartAccount internal acct;
    Target internal target;
    StubPolicyRegistry internal registry;
    SessionKeyHandler internal handler;

    address internal owner = address(0xA11CE);
    bytes32 internal constant TENANT = keccak256("tnt_inv");
    bytes32 internal constant POLICY_VER = keccak256("pol-inv");

    uint256 internal constant MAX_PER_TX = 1 ether;
    uint256 internal constant MAX_PER_PERIOD = 5 ether;
    /// @dev Short on purpose. A 365-day period meant no window ever rolled over,
    ///      so the run had ZERO coverage of the validAfter/anchor window
    ///      arithmetic — the exact code the re-grant double-spend lived in.
    uint256 internal constant PERIOD = 1 hours;

    function setUp() public {
        vm.warp(1_000_233);
        registry = new StubPolicyRegistry();
        registry.setRegistered(TENANT, POLICY_VER, true);
        acct = new BrainSmartAccount(owner, TENANT, address(registry));
        target = new Target();
        handler = new SessionKeyHandler(acct, address(target), PERIOD);
        vm.deal(address(acct), 100 ether);

        address[] memory targets = new address[](1);
        targets[0] = address(target);
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = Target.ping.selector;

        BrainSmartAccount.SessionKey memory key = BrainSmartAccount.SessionKey({
            holder: address(handler),
            validAfter: block.timestamp,
            validUntil: block.timestamp + 3650 days,
            allowedTargets: targets,
            allowedSelectors: selectors,
            capMode: BrainSmartAccount.CapMode.CALL,
            capToken: address(0),
            allowedRecipients: new address[](0),
            capAmountOffset: 4,
            pinOffset: 0,
            pinValue: bytes32(0),
            maxPerTx: MAX_PER_TX,
            maxPerPeriod: MAX_PER_PERIOD,
            periodSeconds: PERIOD,
            policyVersion: POLICY_VER
        });
        vm.prank(owner);
        acct.grantSessionKey(key);

        targetContract(address(handler));
    }

    /// The cumulative cap is the whole point of a session key: no sequence of
    /// accepted calls may push window spend past maxPerPeriod.
    function invariant_windowSpendNeverExceedsPeriodCap() public view {
        assertLe(acct.spentInCurrentWindow(address(handler)), MAX_PER_PERIOD);
    }

    /// The contract's own accounting must agree with an independent tally of
    /// what it accepted, IN THE CURRENT WINDOW. A divergence means a call moved
    /// value without being metered, or that a window boundary lost or duplicated
    /// spend.
    function invariant_ghostSpendMatchesAccounting() public view {
        assertEq(acct.spentInCurrentWindow(address(handler)), handler.ghostByWindow(handler.currentWindow()));
    }

    /// No accepted call may ever have exceeded the per-tx cap, so the accepted
    /// count can never imply more spend than count * cap.
    function invariant_acceptedCallsRespectPerTxCap() public view {
        assertLe(handler.ghostSpent(), handler.accepted() * MAX_PER_TX);
    }

    /// The target allowlist holds under fuzzed rogue targets. Asserted on its own
    /// counter, so deleting the TargetNotAllowed check turns this red.
    function invariant_noOutOfScopeExecution() public view {
        assertEq(handler.outOfScopeAccepted(), 0);
    }

    /// CALL mode forbids msg.value, so the account's ETH balance is untouched by
    /// any amount of session-key activity — including calls that try to carry
    /// value.
    function invariant_callModeNeverMovesValue() public view {
        assertEq(handler.valueAccepted(), 0);
        assertEq(address(acct).balance, 100 ether);
    }

    /// The nonce is gap-free: it equals exactly the number of accepted executes.
    function invariant_nonceEqualsAcceptedCount() public view {
        assertEq(acct.nonce(address(handler)), handler.accepted());
    }

    /// Everything above is satisfied by a run in which nothing succeeded. Assert
    /// once per run that the account was actually exercised, and that time
    /// actually crossed a window boundary so the period arithmetic was covered.
    function afterInvariant() public view {
        assertGt(handler.accepted(), 0, "no call was ever accepted; the run proved nothing");
        assertGt(handler.currentWindow(), acct.windowAnchor(address(handler)), "no window ever rolled over");
    }
}
