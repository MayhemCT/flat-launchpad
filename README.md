# RaidPass

An NFT-mint Launcher for [Flap Pool Launch](https://docs.flap.sh/en/flap/v2/developers/pool-launch/basic-and-mechanism) on BNB Chain. Built for the Flap track of BNB Hack Bangkok 2026.

## The mechanism

On Pool Launch there is no bonding curve: the builder decides how the pool's first liquidity is raised. RaidPass raises it with an NFT mint.

1. A creator opens a mint: token name and symbol, a fixed BNB price per pass, the number of passes, and a deadline.
2. Buyers mint RaidPass NFTs. The mint that sells the last pass launches the token in the same transaction: the whole raise and 50% of the supply go into the DEX pool and the LP is burned.
3. Each pass then claims an equal share of the other 50%, once. The pass is not burned by the claim: it stays in the holder's wallet as a membership pass.
4. If the mint does not sell out by the deadline, a pass is burned for its mint price. The refund goes to whoever holds the pass, so passes can change hands before the launch.

What makes it different from a contribution round: the allocation is a transferable NFT rather than a ledger entry, so a position in the presale can be sold before the token exists and the refund right travels with it. Nobody can withdraw the raise. It leaves the Launcher only through the launch or through refunds, and the factory takes no fee or commission.

## What is in this repository

| Path | What it is |
| --- | --- |
| `contracts/src/raidpass/` | `RaidPassLauncher` (ERC-721 mint + Launcher) and `RaidPassLauncherFactory`, built on Flap's `LauncherBase` and `LauncherFactoryBase`. |
| `contracts/test/raidpass/` | Fork tests that run the whole flow against the live Pool Launch Portal. |
| `contracts/script/` | `Deploy.s.sol` (factory) and `CreateLauncher.s.sol` (one Launcher through the Portal). |
| `flap-ui/raidpass-launcher/` | The launch UI in Flap's Launcher UI template format: creation form and mint page. |
| `packages/protocol/`, `scripts/pull-factories.ts`, `data/` | Pool Launch indexing: decodes Portal events and aggregates every factory, Launcher, token and deployer. |
| `apps/worker/` | Cloudflare Worker + D1 indexer and read API for the same data. Written, not yet run. |

## Status

- Contracts: 9 fork tests pass against the live Portal on BNB Chain Testnet, covering create, mint, launch, claim, trading with tax dispatch, burn-to-refund, Guardian recovery and the factory's access rules.
- Launch UI: passes Flap's `launcher:check-source` and a strict TypeScript check. It has not been run inside Flap's host yet.
- Not yet deployed to BNB Chain Testnet. The factory address below is where it will land.

## Contracts

`RaidPassLauncherFactory` has no constructor arguments, owner, pause or fee. It reads the Portal and the Guardian from Flap's chain registry and is deployed with CREATE2, so it has the same address on BNB Chain and BNB Chain Testnet:

```
RaidPassLauncherFactory  0x4F51d78a3Be8093aE11CB026D563C70c1B1e9e69
```

Each Launcher is a beacon proxy that only the Flap Guardian can upgrade. `mint()`, `claim()` and `refund()` take no arguments, because Flap's Launcher UI runtime calls zero-argument methods: `mint()` sells one pass per `mintPrice` sent, and `claim()` and `refund()` act on every pass the caller holds. `claimPasses(ids)` and `refundPasses(ids)` exist for holders with too many passes for one call.

Fixed launch shape: 1,000,000,000 supply, 50% in the pool, 3% buy and 5% sell tax for 30 days, split 75% BNB dividends to holders, 15% liquidity, 10% burn. No commission receiver.

### Run the tests

Requires [Foundry](https://getfoundry.sh).

```sh
git clone --recurse-submodules https://github.com/MayhemCT/flat-launchpad.git
cd flat-launchpad/contracts
BSC_TESTNET_RPC_URL=https://bsc-testnet-rpc.publicnode.com forge test --match-contract RaidPassBSCTestForkTest
```

### Deploy and launch on BNB Chain Testnet

```sh
cd contracts
cast wallet import raidpass --interactive        # once; keeps the key out of files
export BSC_TESTNET_RPC_URL=https://bsc-testnet-rpc.publicnode.com

forge script script/Deploy.s.sol --rpc-url $BSC_TESTNET_RPC_URL --account raidpass --broadcast

export FACTORY=0x4F51d78a3Be8093aE11CB026D563C70c1B1e9e69
export TOKEN_NAME="Raid Example" TOKEN_SYMBOL=RAIDX
export MINT_PRICE=250000000000000000 MAX_PASSES=10 SALE_DURATION=86400
forge script script/CreateLauncher.s.sol --rpc-url $BSC_TESTNET_RPC_URL --account raidpass --broadcast

# mint (repeat until sold out; the last mint launches the token), then claim
cast send <launcher> "mint()" --value 0.25ether --rpc-url $BSC_TESTNET_RPC_URL --account raidpass
cast send <launcher> "claim()" --rpc-url $BSC_TESTNET_RPC_URL --account raidpass
```

The Portal rejects a launch whose pool is below its liquidity floor. With half the supply in the pool the floor is 1,500 USD of BNB at the Portal's configured price (700 USD per BNB when this was written, so about 2.15 BNB), unless Flap sets a lower multiplier for the factory. A mint whose target is below the floor cannot sell out, and its passes are refunded after the deadline.

On BNB Chain Testnet the Portal accepts Launchers from any factory. On BNB Chain a factory must be audited and enabled by Flap first.

## Launch UI

`flap-ui/raidpass-launcher/` holds the three files Flap's Launcher runtime takes: `Component.tsx`, `manifest.json` and `i18n.json` (English, Chinese, Korean). It uses `launcher-config-preview/v1`:

- `LauncherConfig` is the creation form. It encodes `RaidPassConfig`, asks the host for a salt and the creation fee, and submits `Portal.newLauncher`.
- `Launcher` is the mint page: progress, mint with a quantity, and claim or refund when they apply.

Check it from a checkout of [flap-vault-component-template](https://github.com/flap-sh/flap-vault-component-template) (branch `test/pool-launch-developer-preview`):

```sh
yarn launcher:check-source /path/to/flat-launchpad/flap-ui/raidpass-launcher
```

## Pool Launch indexer

```sh
npm install
npm run pull          # writes data/bsc.json and data/bscTestnet.json
```

`npm run pull` reads the Portal's events over public RPC endpoints and writes every Launcher factory, vault factory, Launcher, token and deployer it finds. Public BNB Chain endpoints keep about 31 days of logs; the Portal's first event is recent enough that the full history is still available.

## Credits

`contracts/src/flap/`, `contracts/test/ForkBase.sol` and `contracts/test/ForkAddresses.sol` are from Flap's [FlapPoolLaunchVaultExample](https://github.com/flap-sh/FlapPoolLaunchVaultExample). The Solidity sources carry MIT SPDX identifiers.
