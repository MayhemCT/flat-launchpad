# RaidPass

An NFT mint that launches a token on [Flap](https://docs.flap.sh) on BNB Chain. Built for BNB Hack Bangkok 2026.

## The mechanism

The NFT mint replaces the bonding curve as the way a launch raises its first liquidity.

1. A creator opens a mint: token name and symbol, a flat BNB price per NFT, a raise cap, and a deadline. The cap is at most 10 BNB and an exact multiple of the price, so `cap / price` NFTs are for sale.
2. Buyers mint RaidPass NFTs. Every NFT costs the same. A buyer who sends more than the NFTs left gets what is left and the rest of the BNB back.
3. The mint that brings the raise to its cap launches the token in the same transaction.
4. Every NFT then claims an equal share of the tokens, once. The NFT is not burned by the claim: it stays in the holder's wallet as a membership pass.
5. If the cap is not reached by the deadline, an NFT is burned for its price. The refund goes to whoever holds the NFT, so NFTs can change hands before the launch.

Nobody can withdraw the raise. It leaves the mint only through the launch or through refunds. There is no mint fee, no commission receiver and no royalty.

## Two launch paths

| | What the launch does with the raise | Network | Permission |
| --- | --- | --- | --- |
| `RaidPassLauncher` | Flap Pool Launch: the raise and the pool share of the supply go straight into a DEX pool, LP burned. The NFTs share the rest of the supply. | BNB Chain Testnet today | On BNB Chain, Flap must audit and enable the factory |
| `RaidPassCurve` | Flap bonding curve: the raise is the launch's first buy. The NFTs share the tokens bought. | BNB Chain | None. The bonding curve Portal is permissionless |

Both are the same mint with the same rules. `RaidPassLauncher` is the design the Flap track asks for. `RaidPassCurve` exists because Pool Launch is permissioned on BNB Chain: it is the way to run the mint live on mainnet without waiting for an audit.

```
RaidPassLauncherFactory  0xFb25C1B10ADE658D9c547D1d9A2eDcd6F00147E5   (CREATE2: same on BNB Chain and Testnet)
RaidPassCurveFactory     0xAF9cfB507271D8bFD3A8284555C7C54026Fe3FB4   (CREATE2: BNB Chain)
```

Neither is deployed yet. Each address depends only on the contract bytecode, so it is known before deployment and changes if the contracts change.

## Status

- `RaidPassLauncher`: 15 fork tests pass against the live Pool Launch Portal on BNB Chain Testnet and against a fork of BNB Chain.
- `RaidPassCurve`: 7 fork tests pass against Flap's bonding curve Portal on a fork of BNB Chain, with nothing impersonated. The deploy, create, mint and claim commands below were rehearsed end to end on a local fork.
- Launch UI: passes Flap's `launcher:check-source` and a strict TypeScript check. It has not been run inside Flap's host.
- The contracts are not audited.

## What is in this repository

| Path | What it is |
| --- | --- |
| `contracts/src/raidpass/` | `RaidPassLauncher` and `RaidPassLauncherFactory` (Pool Launch, on Flap's `LauncherBase` and `LauncherFactoryBase`), and `RaidPassCurve` and `RaidPassCurveFactory` (bonding curve). |
| `contracts/test/raidpass/` | Fork tests that run the whole flow against Flap's live contracts. |
| `contracts/script/` | Deploy and create scripts for both paths. |
| `flap-ui/raidpass-launcher/` | The launch UI in Flap's Launcher UI template format: creation form and mint page. |
| `apps/web/` | A site that hosts the launch UI package against the chain with a browser wallet. |
| `packages/protocol/`, `scripts/pull-factories.ts`, `data/` | Pool Launch indexing: decodes Portal events and aggregates every factory, Launcher, token and deployer. |
| `apps/worker/` | Cloudflare Worker + D1 indexer and read API for the same data. Written, not yet run. |

## Contract rules

| Rule | `RaidPassLauncher` | `RaidPassCurve` |
| --- | --- | --- |
| Price | Flat `nftPrice` | Flat `nftPrice` |
| Cap | At most 10 BNB, exact multiple of the price | Same |
| NFTs | `cap / nftPrice`, at most 10,000; 50 per `mint()` call | Same |
| Name, symbol, metadata CID | At most 64, 32 and 128 bytes | Same |
| Supply | 1,000,000,000 | 1,000,000,000 (Flap's curve) |
| Pool share | `poolShareBps`, 1000 to 9000 | Not applicable: the raise buys on the curve |
| Tax | `buyTaxBps`, `sellTaxBps`, each at most 1000, for 30 days | Each 100 to 1000 (Flap's range on the curve), for 30 days |
| Tax split | 75% BNB dividends to holders, 15% liquidity, 10% burn | Same |
| Per NFT | `(supply - pool share) / NFTs` | `tokens bought on the curve / NFTs` |
| Upgrades | Beacon proxy, Flap Guardian only | None: immutable clone, no owner |

`mint()`, `claim()` and `refund()` take no arguments, because Flap's Launcher UI runtime only calls zero-argument methods: `mint()` sells one NFT per `nftPrice` sent, and `claim()` and `refund()` act on every NFT the caller holds. `claimNFTs(ids)` and `refundNFTs(ids)` take token ids, for holders with too many NFTs for one call.

Events: `Minted(to, firstId, qty, paid)`, `Launched(...)`, `Claimed(tokenId, to, amount)`, `Refunded(tokenId, to, amount)`.

## Keys and secrets

This repository is public. No key, keystore, mnemonic or password belongs in it, and none is needed in any file.

- **Where the deployer key lives.** In Foundry's encrypted keystore, outside this repository: `~/.foundry/keystores/<name>` (on Windows, `C:\Users\<you>\.foundry\keystores\<name>`). The file holds the key encrypted with your password (scrypt + AES-128-CTR); it never holds the key in plain text.
- **Use a fresh deployer wallet.** `cast wallet new ~/.foundry/keystores raidpass` creates a new key straight into the keystore and prints only its address. The private key is never shown, typed or copied. Fund that address with what the deployment needs and nothing more. Do not import an operating key.
- **Never pass a key on the command line.** `--private-key` puts the key in your shell history. The commands here use `--account raidpass`, which asks for the keystore password each time.
- **Commit guard.** `.githooks/pre-commit` refuses commits that add a private key, a keystore, a mnemonic or an env file. Enable it once per clone:

  ```sh
  git config core.hooksPath .githooks
  ```

- `contracts/broadcast/` (Foundry's transaction logs) and `.env` files are git-ignored.

## Run the tests

Requires [Foundry](https://getfoundry.sh).

```sh
git clone --recurse-submodules https://github.com/MayhemCT/flat-launchpad.git
cd flat-launchpad/contracts
BSC_RPC_URL=https://bsc-rpc.publicnode.com forge test --match-contract RaidPassCurveBSCForkTest --isolate
BSC_TESTNET_RPC_URL=https://bsc-testnet-rpc.publicnode.com forge test --match-contract RaidPassBSCTestForkTest --isolate
```

## Launch on BNB Chain (`RaidPassCurve`)

```sh
cd contracts
cast wallet new ~/.foundry/keystores raidpass      # prints the new address; fund it
forge script script/DeployCurve.s.sol --rpc-url https://bsc-rpc.publicnode.com --account raidpass --broadcast --legacy

export CURVE_FACTORY=0xAF9cfB507271D8bFD3A8284555C7C54026Fe3FB4
export TOKEN_NAME="RaidPass" TOKEN_SYMBOL=RAID
export NFT_PRICE=10000000000000000 CAP=50000000000000000 SALE_DURATION=3600   # 0.01 BNB x 5 NFTs, 1 hour
forge script script/CreateCurveMint.s.sol --rpc-url https://bsc-rpc.publicnode.com --account raidpass --broadcast --legacy

cast send <mint> "mint()" --value 0.05ether --rpc-url https://bsc-rpc.publicnode.com --account raidpass --legacy
cast send <mint> "claim()" --rpc-url https://bsc-rpc.publicnode.com --account raidpass --legacy
```

Creating a mint costs the Portal's salt-lock fee (0.01 BNB) plus gas. `BUY_TAX_BPS` and `SELL_TAX_BPS` default to 300 and 500. There is no liquidity floor on the curve, so a mint can be small.

## Launch on BNB Chain Testnet (`RaidPassLauncher`)

```sh
cd contracts
export BSC_TESTNET_RPC_URL=https://bsc-testnet-rpc.publicnode.com
forge script script/Deploy.s.sol --rpc-url $BSC_TESTNET_RPC_URL --account raidpass --broadcast --legacy

export FACTORY=0xFb25C1B10ADE658D9c547D1d9A2eDcd6F00147E5
export TOKEN_NAME="Raid Example" TOKEN_SYMBOL=RAIDX
export NFT_PRICE=250000000000000000 CAP=2500000000000000000 SALE_DURATION=86400   # 0.25 tBNB x 10 NFTs
forge script script/CreateLauncher.s.sol --rpc-url $BSC_TESTNET_RPC_URL --account raidpass --broadcast --legacy

cast send <launcher> "mint()" --value 0.25ether --rpc-url $BSC_TESTNET_RPC_URL --account raidpass --legacy
cast send <launcher> "claim()" --rpc-url $BSC_TESTNET_RPC_URL --account raidpass --legacy
```

`POOL_SHARE_BPS`, `BUY_TAX_BPS` and `SELL_TAX_BPS` default to 5000, 300 and 500.

The Portal rejects a launch whose pool is below its liquidity floor: 750 USD of BNB divided by the pool share, at the Portal's configured BNB price (700 USD when this was written). At a 50% pool share that is 1,500 USD, about 2.15 BNB, unless Flap sets a lower multiplier for the factory. A mint whose cap is below the floor cannot launch, and its NFTs are refunded after the deadline.

On BNB Chain Testnet the Portal accepts Launchers from any factory. On BNB Chain, Pool Launch is permissioned: token creation is paused and `Portal.newLauncher` reverts for any factory Flap has not audited and enabled.

## BNB Chain transaction rules this was checked against

- **Send with `--legacy`.** BNB Chain's base fee is 0, and Foundry's EIP-1559 estimate on BNB Chain Testnet comes out at 1 wei, far below the node's quoted gas price. With `--legacy` Foundry uses the node's gas price (0.05 gwei on BNB Chain, the network minimum, and 0.1 gwei on Testnet when this was written).
- **Per-transaction gas cap: 16,777,216** (BEP-652, live since the Mendel upgrade). The heaviest RaidPass transaction, a mint of the 50-NFT per-call maximum that also runs the launch, uses about 9.3M gas on either path. Each suite asserts the margin.
- **Large holders.** `claim()` costs about 30,000 gas per NFT, so one call covers roughly 500 NFTs; a wallet holding more uses `claimNFTs(ids)` in batches. The same applies to `refund()` and `refundNFTs(ids)`.
- **Contract size.** `RaidPassLauncher` is 23.0 KB of runtime code and `RaidPassCurve` 18.6 KB, under the 24,576-byte limit.
- **Launcher description.** The Pool Launch Portal reads at most 4,096 bytes of a Launcher's `description()` with at most 200,000 gas, and stores an empty description past either limit. With the longest name and symbol the Launcher accepts, the description is 1,449 bytes and costs about 53,000 gas; `test_13` asserts it.

## Launch UI

`flap-ui/raidpass-launcher/` holds the three files Flap's Launcher runtime takes: `Component.tsx`, `manifest.json` and `i18n.json` (English, Chinese, Korean). It targets `RaidPassLauncher` and uses `launcher-config-preview/v1`:

- `LauncherConfig` is the creation form: price, cap, mint window, pool share and taxes. It encodes `RaidPassConfig`, asks the host for a salt and the creation fee, and submits `Portal.newLauncher`.
- `Launcher` is the mint page: progress, mint with a quantity, and claim or refund when they apply.

Check it from a checkout of [flap-vault-component-template](https://github.com/flap-sh/flap-vault-component-template) (branch `test/pool-launch-developer-preview`):

```sh
yarn launcher:check-source /path/to/flat-launchpad/flap-ui/raidpass-launcher
```

## Web app

`apps/web` is a site that runs the launch UI package against the chain directly. Flap's site runs a Launcher UI package inside its own host, which reads the contract and sends every transaction. `apps/web/src/host.ts` implements that same host contract with a browser wallet, so the exact files in `flap-ui/raidpass-launcher/` run here unchanged: the creation form, the mint page, claim and refund.

```sh
npm install
npm run dev --workspace @flat/web          # http://localhost:5173
npm run test:viewport --workspace @flat/web
npx vitest run apps/web/tests/salt.test.ts
```

- **Network and factory** come from the package's `manifest.json` (BNB Chain Testnet).
- **Launches** are listed from the factory's own `launchers` array, so no indexer is needed.
- **Background.** The BNB mark in three.js, loaded after first paint. It drifts when idle and leans toward the pointer; with reduced motion it renders once and stays still.
- **Phone layout.** Under 768 px the page renders a separate shell: compact top bar, cards in place of the table, and a tab bar at the bottom.
- **Viewport tests.** 30 Playwright checks across ten screen sizes, from a folded Galaxy Fold to an ultrawide monitor, on every page: no sideways scroll, the right shell for the size, the canvas covering the viewport, every control on-screen and at least 44 px tall on touch screens, and the tab bar never covering content. They run in the Edge or Chrome already installed.
- **Salt test.** The token-address prediction is checked against every salt the live Portal has locked.

## Pool Launch indexer

```sh
npm install
npm run pull          # writes data/bsc.json and data/bscTestnet.json
```

`npm run pull` reads the Pool Launch Portal's events over public RPC endpoints and writes every Launcher factory, vault factory, Launcher, token and deployer it finds. Public BNB Chain endpoints keep about 31 days of logs; the Portal's first event is recent enough that the full history is still available.

## Credits

`contracts/src/flap/`, `contracts/test/ForkBase.sol` and `contracts/test/ForkAddresses.sol` are from Flap's [FlapPoolLaunchVaultExample](https://github.com/flap-sh/FlapPoolLaunchVaultExample). The Solidity sources carry MIT SPDX identifiers.
