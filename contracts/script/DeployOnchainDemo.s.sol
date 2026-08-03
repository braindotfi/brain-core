// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import {BrainSmartAccount} from "../src/BrainSmartAccount.sol";
import {BrainPolicyRegistry} from "../src/BrainPolicyRegistry.sol";

/// @notice Deploy the demo on-chain stack: a BrainPolicyRegistry with the demo
///         policy registered, a BrainSmartAccount for the demo tenant, the Brain
///         agent session key, and ETH funding for testnet runs.
///
/// Usage (from repo root):
///   DEPLOYER_PRIVATE_KEY=0x<64-hex-key> \
///   BRAIN_TENANT_ID=tnt_00000000010000000000000000 \
///   ONCHAIN_RECIPIENT=0x<40-hex-address> \
///   forge script contracts/script/DeployOnchainDemo.s.sol \
///     --rpc-url https://sepolia.base.org --broadcast
///
/// Simplest topology: set DEPLOYER_PRIVATE_KEY == BRAIN_SESSION_KEY and
/// ONCHAIN_RECIPIENT == the EOA address for that key. The smart account
/// will send ETH to itself, which is fine on testnet and avoids losing funds.
///
/// Why a policy registry is deployed here: BrainSmartAccount.grantSessionKey now
/// VERIFIES that a key's policyVersion is a policy hash the tenant actually
/// registered. The registry address used to be passed as address(0) and never
/// read, so the "policy-version binding" the architecture documents claim was an
/// unread field. Deploy order is therefore registry first, policy registered,
/// then the account.
///
/// After broadcast, copy the logged BRAIN_ONCHAIN_SMART_ACCOUNT and
/// POLICY_REGISTRY_ADDRESS into brain-core/.env, then restart the API server.
contract DeployOnchainDemo is Script {
    bytes32 private constant _SIGNER_TYPEHASH =
        keccak256("TenantSignerChange(bytes32 tenantId,address signer,bool allowed,uint256 nonce)");
    bytes32 private constant _POLICY_TYPEHASH =
        keccak256("PolicyRegistration(bytes32 tenantId,uint256 version,bytes32 policyHash)");

    /// @dev bytes32(uint256(1)) matches BRAIN_ONCHAIN_POLICY_VERSION=0x000...001.
    bytes32 private constant _DEMO_POLICY_HASH = bytes32(uint256(1));

    function _sign(uint256 pk, bytes32 domain, bytes32 structHash) private pure returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", domain, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Deploy the registry, bootstrap the deployer as a tenant signer, and
    ///      register the demo policy so a session key can bind to it.
    function _deployRegistry(uint256 pk, address deployer, bytes32 tenantIdHash)
        private
        returns (BrainPolicyRegistry registry)
    {
        registry = new BrainPolicyRegistry(deployer);
        bytes32 domain = registry.domainSeparator();

        registry.setTenantSigner(
            tenantIdHash,
            deployer,
            true,
            deployer,
            _sign(pk, domain, keccak256(abi.encode(_SIGNER_TYPEHASH, tenantIdHash, deployer, true, uint256(0))))
        );

        address[] memory policySigners = new address[](1);
        policySigners[0] = deployer;
        bytes[] memory policySignatures = new bytes[](1);
        policySignatures[0] =
            _sign(pk, domain, keccak256(abi.encode(_POLICY_TYPEHASH, tenantIdHash, uint256(1), _DEMO_POLICY_HASH)));
        registry.registerPolicy(tenantIdHash, 1, _DEMO_POLICY_HASH, policySigners, policySignatures);
    }

    /// @dev NATIVE-mode key: value-only transfers to `recipient`. The selector
    ///      and recipient allowlists are empty because NATIVE mode forbids
    ///      calldata outright.
    function _nativeKey(address holder, address recipient) private view returns (BrainSmartAccount.SessionKey memory) {
        address[] memory targets = new address[](1);
        targets[0] = recipient;
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
            maxPerTx: 0.05 ether,
            maxPerPeriod: 0.5 ether,
            periodSeconds: 86_400,
            policyVersion: _DEMO_POLICY_HASH
        });
    }

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        bytes32 tenantIdHash = keccak256(bytes(vm.envString("BRAIN_TENANT_ID")));
        address recipient = vm.envAddress("ONCHAIN_RECIPIENT");

        vm.startBroadcast(deployerKey);

        BrainPolicyRegistry registry = _deployRegistry(deployerKey, deployer, tenantIdHash);
        BrainSmartAccount account = new BrainSmartAccount(deployer, tenantIdHash, address(registry));
        account.grantSessionKey(_nativeKey(deployer, recipient));

        // Fund the smart account so it can forward value to the target.
        payable(address(account)).transfer(0.1 ether);

        vm.stopBroadcast();

        console2.log("=== DeployOnchainDemo results ===");
        console2.log("BrainPolicyRegistry  :", address(registry));
        console2.log("BrainSmartAccount    :", address(account));
        console2.log("Owner / SessionHolder:", deployer);
        console2.log("AllowedTarget        :", recipient);
        console2.log("Funded with ETH      : 0.1");
        console2.log("");
        console2.log("Add to brain-core/.env:");
        console2.log("  BRAIN_ONCHAIN_SMART_ACCOUNT=", vm.toString(address(account)));
        console2.log("  POLICY_REGISTRY_ADDRESS=", vm.toString(address(registry)));
        console2.log(
            "  BRAIN_ONCHAIN_POLICY_VERSION=0x0000000000000000000000000000000000000000000000000000000000000001"
        );
    }
}
