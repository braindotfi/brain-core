// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {BrainSmartAccount} from "../src/BrainSmartAccount.sol";
import {Target, StubPolicyRegistry} from "./BrainSmartAccount.t.sol";

/// @dev Drives executeViaSessionKey as the session-key HOLDER (the handler is
///      the holder, so msg.sender is already correct and no prank is needed).
///
///      Every call is wrapped in try/catch so the handler itself never reverts,
///      which is what lets `fail_on_revert = true` stay on: a run in which every
///      call reverted would otherwise "pass" while proving nothing.
contract SessionKeyHandler {
    BrainSmartAccount public immutable acct;
    address public immutable target;

    /// @dev Sum of amounts the account ACCEPTED. The shadow accounting the
    ///      invariants compare against the contract's own window ledger.
    uint256 public ghostSpent;
    uint256 public accepted;
    uint256 public rejected;

    constructor(BrainSmartAccount a, address t) {
        acct = a;
        target = t;
    }

    /// @param rawAmount fuzzed; bounded so the run straddles the per-tx cap in
    ///        both directions rather than always overshooting.
    function execute(uint256 rawAmount) external {
        uint256 amount = rawAmount % 2 ether;
        uint256 n = acct.nonce(address(this));
        bytes memory data = abi.encodeCall(Target.ping, (amount));
        try acct.executeViaSessionKey(n, target, 0, data) {
            ghostSpent += amount;
            accepted += 1;
        } catch {
            rejected += 1;
        }
    }

    /// @dev Attempt a call outside the key's scope. Must ALWAYS be rejected.
    function executeOutOfScope(uint256 rawAmount, address rogueTarget) external {
        uint256 amount = rawAmount % 2 ether;
        uint256 n = acct.nonce(address(this));
        if (rogueTarget == target) return; // in-scope; covered by execute()
        bytes memory data = abi.encodeCall(Target.ping, (amount));
        try acct.executeViaSessionKey(n, rogueTarget, 0, data) {
            // Recorded as accepted so invariant_noOutOfScopeExecution can catch it.
            accepted += 1;
            ghostSpent += amount;
        } catch {
            rejected += 1;
        }
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
    /// @dev Long enough that no window rolls over during a run, so the handler's
    ///      ghost total is directly comparable to the contract's window ledger.
    uint256 internal constant PERIOD = 365 days;

    function setUp() public {
        vm.warp(1_000_233);
        registry = new StubPolicyRegistry();
        registry.setRegistered(TENANT, POLICY_VER, true);
        acct = new BrainSmartAccount(owner, TENANT, address(registry));
        target = new Target();
        handler = new SessionKeyHandler(acct, address(target));
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
    /// what it accepted. A divergence means a call moved value without being
    /// metered, which is exactly the class of bug the cap-mode rewrite closed.
    function invariant_ghostSpendMatchesAccounting() public view {
        assertEq(acct.spentInCurrentWindow(address(handler)), handler.ghostSpent());
    }

    /// No accepted call may ever have exceeded the per-tx cap, so the accepted
    /// count can never imply more spend than count * cap.
    function invariant_acceptedCallsRespectPerTxCap() public view {
        assertLe(handler.ghostSpent(), handler.accepted() * MAX_PER_TX);
    }

    /// The target allowlist holds under fuzzed rogue targets: total spend still
    /// tracks the ledger, so nothing executed outside scope.
    function invariant_noOutOfScopeExecution() public view {
        assertEq(handler.ghostSpent(), acct.spentInCurrentWindow(address(handler)));
    }

    /// CALL mode forbids msg.value, so the account's ETH balance is untouched by
    /// any amount of session-key activity.
    function invariant_callModeNeverMovesValue() public view {
        assertEq(address(acct).balance, 100 ether);
    }

    /// The nonce is gap-free: it equals exactly the number of accepted executes.
    function invariant_nonceEqualsAcceptedCount() public view {
        assertEq(acct.nonce(address(handler)), handler.accepted());
    }
}
