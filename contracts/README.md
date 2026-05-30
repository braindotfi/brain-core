# Brain Smart Contracts

Solidity 0.8.24 on Base L2. Foundry project. Implementation lands in stage-5.

See `Brain_MVP_Architecture.md` §4 for contract interfaces and
`Brain_Engineering_Standards.md` §7.3 / §12.3 for testing and style requirements.

## Local Development

`forge-std` is tracked as a git submodule under `lib/forge-std` (see top-level
`.gitmodules`), pinned to `v1.16.1`. A fresh `git clone --recursive` populates
it. For an existing clone, run `git submodule update --init --recursive` before
the first `forge test`.

```bash
# Install Foundry: https://book.getfoundry.sh/getting-started/installation
git submodule update --init --recursive   # cold-start (or use --recursive on clone)
forge build
forge test -vvv
forge test --gas-report
forge fmt --check
```

## Dependencies

- `foundry-rs/forge-std`. Cheatcodes + assertions. Tracked as a git
  submodule at `lib/forge-std`, pinned to `v1.16.1`.

Other forge-installed dependencies (e.g. OpenZeppelin) are not currently in
scope; if added later they land under `lib/` via `forge install` and are
covered by the `!lib/forge-std` carveout in `contracts/.gitignore`.

See `remappings.txt` for import paths.

## Deployment

Never from this directory during normal development. Deployment targets:

- **Base Sepolia** (staging), via `script/Deploy.s.sol --rpc-url base_sepolia`
- **Base mainnet** (production), only after external audit; deploy via 2-of-3 multi-sig

Environment variables (populated from Azure Key Vault in CI):

- `BASE_SEPOLIA_RPC_URL`, `BASE_MAINNET_RPC_URL`
- `BASESCAN_API_KEY`
- `DEPLOYER_PRIVATE_KEY` (only for non-mainnet; mainnet uses multi-sig)

Per §10.4: never commit secrets, never read them from env files checked into git.
