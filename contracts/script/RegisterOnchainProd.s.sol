// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import {BrainPolicyRegistry} from "../src/BrainPolicyRegistry.sol";
import {BrainMCPAgentRegistry} from "../src/BrainMCPAgentRegistry.sol";
import {BrainSmartAccount} from "../src/BrainSmartAccount.sol";

/// @notice Replay the production on-chain registration onto the ALREADY DEPLOYED
///         post-#449 contracts, then grant the native session key and fund the
///         account.
///
/// Unlike DeployOnchainDemo.s.sol this deploys NOTHING: every address is read
/// from the environment, so it can be pointed at the contracts that were
/// deployed by hand on 2026-08-05.
///
/// Required env:
///   DEPLOYER_PRIVATE_KEY        key for 0x41D4ce9D (registry admin + account owner)
///   POLICY_REGISTRY_ADDRESS     new BrainPolicyRegistry
///   MCP_AGENT_REGISTRY_ADDRESS  new BrainMCPAgentRegistry
///   BRAIN_ONCHAIN_SMART_ACCOUNT new BrainSmartAccount
///   BRAIN_DEMO_ONCHAIN_RECIPIENT allowed native recipient
///
/// Dry run (simulate, no broadcast):
///   forge script script/RegisterOnchainProd.s.sol --rpc-url $BASE_RPC_URL
/// Execute:
///   ... --broadcast
contract RegisterOnchainProd is Script {
    bytes32 private constant _SIGNER_TYPEHASH =
        keccak256("TenantSignerChange(bytes32 tenantId,address signer,bool allowed,uint256 nonce)");
    bytes32 private constant _POLICY_TYPEHASH =
        keccak256("PolicyRegistration(bytes32 tenantId,uint256 version,bytes32 policyHash)");
    bytes32 private constant _REGISTER_TYPEHASH = keccak256(
        "AgentRegistration(bytes32 agentId,address agentAddress,bytes32 tenantId,bytes32 scopeHash,bytes32 behaviorHash)"
    );

    // Replayed from the OLD registries, read on chain 2026-08-06.
    bytes32 private constant _GOLDEN_TENANT = keccak256(bytes("tnt_00000000010000000000000000"));
    bytes32 private constant _GOLDEN_POLICY_HASH = 0xc65cd17b92c5f2b8287eef8db76b89f82d5ce969477260a215c98e51e963fec9;
    /// @dev Old registry latestVersion(golden) == 10 and every version 1..10 carries
    ///      the same hash. Registering AT 10 preserves the counter, so the running
    ///      policyRegistrar keeps advancing from where it left off.
    uint256 private constant _GOLDEN_POLICY_VERSION = 10;

    bytes32 private constant _AGENT_ID = keccak256(bytes("agent_01KTB9KXM267ZEEBAMYMNSYE6X"));
    bytes32 private constant _AGENT_SCOPE_HASH = 0x4df1ab107b5f1c603c39b60466c8187018fbb88e8d659bcb3f2246b1eb182745;
    bytes32 private constant _AGENT_BEHAVIOR_HASH = bytes32(0);

    /// @dev Matches BRAIN_ONCHAIN_POLICY_VERSION=0x000...001, the digest the
    ///      session key binds to. Must be a REGISTERED hash for the account's
    ///      own tenant or grantSessionKey reverts.
    bytes32 private constant _DEMO_POLICY_HASH = bytes32(uint256(1));

    uint256 private constant _FUND_WEI = 0.1 ether;

    function _sign(uint256 pk, bytes32 domain, bytes32 structHash) private pure returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", domain, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _bootstrapPolicySigner(BrainPolicyRegistry registry, uint256 pk, address deployer, bytes32 tenantId)
        private
    {
        if (registry.isTenantSigner(tenantId, deployer)) {
            console2.log("  policy signer already set, skipping");
            return;
        }
        uint256 nonce = registry.tenantSignerNonce(tenantId);
        registry.setTenantSigner(
            tenantId,
            deployer,
            true,
            deployer,
            _sign(
                pk, registry.domainSeparator(), keccak256(abi.encode(_SIGNER_TYPEHASH, tenantId, deployer, true, nonce))
            )
        );
    }

    function _registerPolicy(
        BrainPolicyRegistry registry,
        uint256 pk,
        address deployer,
        bytes32 tenantId,
        uint256 version,
        bytes32 policyHash
    ) private {
        if (registry.isRegisteredHash(tenantId, policyHash)) {
            console2.log("  policy hash already registered, skipping");
            return;
        }
        address[] memory signers = new address[](1);
        signers[0] = deployer;
        bytes[] memory signatures = new bytes[](1);
        signatures[0] = _sign(
            pk, registry.domainSeparator(), keccak256(abi.encode(_POLICY_TYPEHASH, tenantId, version, policyHash))
        );
        registry.registerPolicy(tenantId, version, policyHash, signers, signatures);
    }

    function _bootstrapMcpSigner(BrainMCPAgentRegistry registry, uint256 pk, address deployer, bytes32 tenantId)
        private
    {
        if (registry.isTenantSigner(tenantId, deployer)) {
            console2.log("  mcp signer already set, skipping");
            return;
        }
        uint256 nonce = registry.signerNonce(tenantId);
        registry.setTenantSigner(
            tenantId,
            deployer,
            true,
            deployer,
            _sign(
                pk, registry.domainSeparator(), keccak256(abi.encode(_SIGNER_TYPEHASH, tenantId, deployer, true, nonce))
            )
        );
    }

    function _registerAgent(BrainMCPAgentRegistry registry, uint256 pk, address deployer, address agentAddress)
        private
    {
        // agentAddress moves to the new smart account. The section 6 gate calls
        // isAuthorized(agentId, tenantId) and does not check agentAddress, so
        // this is safe and keeps the record truthful.
        registry.registerAgent(
            _AGENT_ID,
            agentAddress,
            _GOLDEN_TENANT,
            _AGENT_SCOPE_HASH,
            _AGENT_BEHAVIOR_HASH,
            deployer,
            _sign(
                pk,
                registry.domainSeparator(),
                keccak256(
                    abi.encode(
                        _REGISTER_TYPEHASH,
                        _AGENT_ID,
                        agentAddress,
                        _GOLDEN_TENANT,
                        _AGENT_SCOPE_HASH,
                        _AGENT_BEHAVIOR_HASH
                    )
                )
            )
        );
    }

    function _nativeKey(address holder, address recipient) private view returns (BrainSmartAccount.SessionKey memory) {
        address[] memory targets = new address[](1);
        targets[0] = recipient;
        // Mirrors the OLD account's key exactly: NATIVE, 0.001 per tx,
        // 0.01 per rolling day. NATIVE forbids calldata, so the selector and
        // recipient allowlists MUST stay empty.
        return BrainSmartAccount.SessionKey({
            holder: holder,
            validAfter: block.timestamp,
            validUntil: block.timestamp + 30 days,
            allowedTargets: targets,
            allowedSelectors: new bytes4[](0),
            capMode: BrainSmartAccount.CapMode.NATIVE,
            capToken: address(0),
            allowedRecipients: new address[](0),
            capAmountOffset: 0,
            pinOffset: 0,
            pinValue: bytes32(0),
            maxPerTx: 0.001 ether,
            maxPerPeriod: 0.01 ether,
            periodSeconds: 86_400,
            policyVersion: _DEMO_POLICY_HASH
        });
    }

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);

        BrainPolicyRegistry policy = BrainPolicyRegistry(vm.envAddress("POLICY_REGISTRY_ADDRESS"));
        BrainMCPAgentRegistry mcp = BrainMCPAgentRegistry(vm.envAddress("MCP_AGENT_REGISTRY_ADDRESS"));
        BrainSmartAccount account = BrainSmartAccount(payable(vm.envAddress("BRAIN_ONCHAIN_SMART_ACCOUNT")));
        address recipient = vm.envAddress("BRAIN_DEMO_ONCHAIN_RECIPIENT");

        // The account's tenant is immutable and is NOT the golden tenant. The
        // session key's policyVersion is checked against THIS id, so it needs
        // its own registration.
        bytes32 accountTenant = account.tenantId();

        console2.log("deployer        ", deployer);
        console2.log("policy registry ", address(policy));
        console2.log("mcp registry    ", address(mcp));
        console2.log("smart account   ", address(account));
        console2.log("account tenant  ", vm.toString(accountTenant));
        console2.log("golden tenant   ", vm.toString(_GOLDEN_TENANT));
        console2.log("account balance ", address(account).balance);

        require(policy.initialAdmin() == deployer, "deployer is not the policy registry admin");
        require(mcp.initialAdmin() == deployer, "deployer is not the mcp registry admin");
        require(account.owner() == deployer, "deployer does not own the smart account");
        require(account.policyRegistry() == address(policy), "account is bound to a different policy registry");

        vm.startBroadcast(pk);

        console2.log("1/7 policy registry: bootstrap signer for the golden tenant");
        _bootstrapPolicySigner(policy, pk, deployer, _GOLDEN_TENANT);

        console2.log("2/7 policy registry: replay golden policy at version 10");
        _registerPolicy(policy, pk, deployer, _GOLDEN_TENANT, _GOLDEN_POLICY_VERSION, _GOLDEN_POLICY_HASH);

        console2.log("3/7 policy registry: bootstrap signer for the account tenant");
        _bootstrapPolicySigner(policy, pk, deployer, accountTenant);

        console2.log("4/7 policy registry: register the session-key policy digest");
        _registerPolicy(policy, pk, deployer, accountTenant, 1, _DEMO_POLICY_HASH);

        console2.log("5/7 mcp registry: bootstrap signer for the golden tenant");
        _bootstrapMcpSigner(mcp, pk, deployer, _GOLDEN_TENANT);

        console2.log("6/7 mcp registry: re-register the payment agent against the NEW account");
        _registerAgent(mcp, pk, deployer, address(account));

        console2.log("7/7 smart account: grant the native session key and fund");
        account.grantSessionKey(_nativeKey(deployer, recipient));

        if (address(account).balance < _FUND_WEI) {
            (bool ok,) = payable(address(account)).call{value: _FUND_WEI - address(account).balance}("");
            require(ok, "funding the smart account failed");
        }

        vm.stopBroadcast();

        console2.log("done. account balance now", address(account).balance);
    }
}
