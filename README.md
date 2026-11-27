# CallZ

Mint the pass. Make the call.

A board for every launch on [Flap](https://docs.flap.sh) Pool Launch with charts, trading and chat, and a launchpad where the presale is an NFT pass mint that funds a token's first liquidity pool. On BNB Chain. Built for BNB Hack Bangkok 2026.

Live: https://callz.fun · X: [@callzfun](https://x.com/callzfun)

- **Memescope.** Every launchpad built on Pool Launch on one live board, in three columns a launch crosses as it fills: New, Final stretch, Launched. Raises are ranked by how much of their target they hold, launchpads are named and colour-coded, and launched tokens show their own pictures.
- **Token pages.** For every launched token on BNB Chain: the DexScreener chart with the pool's trades under it, price, market cap, liquidity and volume, the token's own taxes, whether its DexScreener profile is paid, and its description and links from its own metadata and from DexScreener.
- **Trading.** Buy and sell through PancakeSwap's router straight from the visitor's wallet, on the token page, with one click from the board, or from the wallet menu, which lists the positions a wallet holds and sells them. Trades go through the CallZ router, which takes a 2% fee on the BNB side and pays it to the rewards vault in the same transaction; the fee is shown in every quote before the wallet opens. CallZ never holds funds.
- **Pools.** The PancakeSwap pools of the tokens that graduated on Flap, and PancakeSwap's major pairs, with adding and removing liquidity through PancakeSwap's router. Liquidity can be added only to a pool that passes the checks on its page: either a graduated Pool Launch pool that is PancakeSwap's own pair with at least 90% of its LP burned, or a pool between BNB and the assets on PancakeSwap's own default token list with at least 50 BNB's worth on its quote side. Taking liquidity out is never blocked.
- **Pop-out windows.** A small window per token with the chart on top and the chat under it; several can be open at once.
- **Chat and holder room.** One public room per token, and a holder room where only wallets that hold the token can post. Messages are signed by the wallet that wrote them; text only, no links.
- **Callouts.** Under the chat, a feed of the callouts people posted for the token: links to their X posts, pump.fun callouts and fomo.family trades. A pump.fun or fomo.family link carries its contract address, and one for a different contract is refused. Each link can be posted once. Each callout records the wallet's holdings and the market cap when it was posted, and shows when the wallet has sold and at what market cap. A reviewer wallet approves a callout by signing it; the author then records it in the vault, where it earns.
- **Callout rewards.** Every CallZ fee on a token goes to a vault that pays the people who call the token out: more for calling early, at a lower market cap, with more of the token, and for holding. Nothing is staked. See "Fees and the vault" below.
- **Launchpad.** NFT pass mints that launch a token: straight into a PancakeSwap pool on BNB Chain (`CallZPancake`), and through Flap Pool Launch on BNB Chain Testnet (`CallZLauncher`).
- **Aggregator.** Every Launcher, launched token, factory and deployer on Pool Launch, on BNB Chain and BNB Chain Testnet.


## The mechanism

The NFT mint replaces the bonding curve as the way a launch raises its first liquidity.

1. A creator opens a mint: token name and symbol, a flat BNB price per NFT, a raise cap, and a deadline. The cap is at most 10 BNB and an exact multiple of the price, so `cap / price` NFTs are for sale.
2. Buyers mint CallZ NFTs. Every NFT costs the same. A buyer who sends more than the NFTs left gets what is left and the rest of the BNB back.
3. The mint that brings the raise to its cap launches the token in the same transaction.
4. Every NFT then claims an equal share of the tokens, once. The NFT is not burned by the claim: it stays in the holder's wallet as a membership pass.
5. If the cap is not reached by the deadline, an NFT is burned for its price. The refund goes to whoever holds the NFT, so NFTs can change hands before the launch.

Nobody can withdraw the raise. It leaves the mint only through the launch or through refunds. On the mainnet path (`CallZPancake`) a launch pays a launch fee, 10% of the raise, to the CallZ vault; it is taken only if the mint launches, so a refund returns the full price. The Flap Pool Launch path has no commission receiver and no royalty.

## Three launch paths

| | What the launch does with the raise | Network | Permission |
| --- | --- | --- | --- |
| `CallZLauncher` | Flap Pool Launch: the raise and the pool share of the supply go straight into a DEX pool, LP burned. The NFTs share the rest of the supply. | BNB Chain Testnet today | On BNB Chain, Flap must audit and enable the factory |
| `CallZCurve` | Flap bonding curve: the raise is the launch's first buy. The NFTs share the tokens bought. | BNB Chain | None. The bonding curve Portal is permissionless |
| `CallZPancake` | PancakeSwap directly: the mint creates a plain token, pays the 10% launch fee to the CallZ vault and puts the rest of the raise, with the pool share of the supply, into a PancakeSwap V2 pool. LP burned. The NFTs share the rest of the supply. | BNB Chain | None |

All three are the same mint with the same rules. `CallZLauncher` is the design the Flap track asks for. Pool Launch is permissioned on BNB Chain, so the other two are the ways to run the mint on mainnet without waiting for an audit: `CallZPancake` is the one the site's launchpad uses, because it does what Pool Launch does (the raise funds the pool) with PancakeSwap alone.

`CallZPancake` adds liquidity by sending both assets to the pair and calling `mint` on it, not through the router: the token address is predictable, so anyone can create the pair first, and the router's `addLiquidityETH` cannot be relied on in every state such a pair can be in. The token is a plain ERC-20: fixed supply, no owner, no tax.

```
The code in this repository (what the site points at; each is deployed from the site by one transaction)
CallZLauncherFactory     0x1C43a0bBf01034c30c9d30F23C00E7F3019E678c   (CREATE2: same on BNB Chain and Testnet)
CallZCurveFactory        0xCe3e30FC569C7931eB4F366c9F2EE5287D3637Ca   (CREATE2: BNB Chain; not deployed)
CallZVault               0x78578cB78c57354E4ecaAF8033646aabC49b8902   (BNB Chain; holds and pays every fee)
CallZRouter              0x09BF2F6c6988C12b82BeBA3936e7b3A602a1dc57   (BNB Chain; takes the trading fee)
CallZPancakeFactory      0xfFe694AC904B2FC664cd8f0D83AEA156EeBB321f   (BNB Chain; takes the launch fee)

Earlier deployments (code as of commit cd84ceb, before the review fixes)
CallZLauncherFactory     0x873040D38Bd73eF1cE7d8D814278605CF6b697b3   (BNB Chain Testnet; its mints are still listed and usable on the site)
CallZVault               0x68459955E16EDd44319218101f60aD2b379401b6   (BNB Chain; never received a fee)
CallZRouter              0x1439694F14999D5999b1735bC67e70260CAce10C   (BNB Chain)
CallZPancakeFactory      0x28507071955b19E99C5DDa572fc690b8856f65D0   (BNB Chain; created no mint)
CallZPancakeFactory v1   0xf4Ce206dFEDFadc826DC355097648Fd3Df9a4fB3   (BNB Chain; no fee; its mints still list)
```

The three CallZ fee contracts listed first are deployed from the site's Launch page, one transaction each, and the site trades and launches through them once they have code on BNB Chain. The earlier three were deployed on 27 Nov 2026 and are no longer used. Once the current ones are deployed their sources must not change: a change would move their addresses. `CallZLauncherFactory` deploys with one transaction from the testnet launch page, and on BNB Chain from the Launch page, to the same address on both. Each address depends only on the contract bytecode, so it is known before deployment and changes if the contracts change. `scripts/flap-deployment.mjs` computes the two Flap factory addresses and `scripts/callz-deployment.mjs` the three CallZ ones.

## Fees and the vault

CallZ collects two fees, both in BNB, both paid straight into `CallZVault` by the contract that takes them:

- **Launch fee:** 10% of the raise of every `CallZPancake` mint that launches (`CallZPancakeFactory.launchFeeBps`, fixed into each mint when it is created, at most 10%).
- **Trading fee:** 2% of the BNB side of every buy and sell made through the site (`CallZRouter.feeBps`, at most 2%). The router swaps on PancakeSwap V2 and keeps nothing.

The vault is a callout reward system. It keeps a separate book per token and splits every deposit on arrival:

| Share | Who gets it | How |
| --- | --- | --- |
| 45% | Holder share | Shared between the holders whose callouts are already recorded in the round when the fee arrives, by weight. |
| 30% | Callout pool | Split equally per verified callout of the round. |
| 25% | Platform | Sent to the team wallet inside the deposit that pays the fee. |

**No staking.** The vault never holds anyone's tokens. A holder's tokens stay in their wallet; when their callout is recorded, the vault reads the wallet's balance (the snapshot), and never counts more than the wallet held when the callout was posted, which the attestation carries. A caller's weight is that snapshot divided by the token's market cap when they posted the callout, so the same holdings called at half the market cap weigh twice as much: the weight follows the gain since the call. A fee is shared only between the callers already in the round, so a caller earns from the trading that comes after their callout: the earlier the call, the more volume it earns from. A fee that arrives before the round has any caller goes to its callout pool.

**The checkpoint.** After a round ends, the balances of all its callers are read together in one transaction (`checkpoint`, taken by the round's first claim, or by anyone). Each caller's weight is cut down to the part of their snapshot they still hold, and the holder share is worked out on those weights: every fee is shared between the callers who were already in the round when it arrived. A caller who holds half of their snapshot weighs half; one who holds nothing weighs nothing. What they give up goes to the callers who still hold, not to the team wallet. Tokens passed from one caller's wallet to another's count once, in the wallet that holds them at the checkpoint, and take nothing from the other callers. A fee whose callers all hold nothing by then is owed to nobody and is swept with the round. A round's holder share takes at most 256 holders per token, so the checkpoint fits in one transaction; a callout recorded after that still earns from the callout pool. The balance is read at one moment, so a caller who sold can hold the tokens again for that moment at the cost of buying them back: the vault does not lock tokens and cannot rule that out.

**The feed shows the position.** Each callout is stored with the wallet's holdings and the market cap at the moment it was posted, and shows "Called at $X market cap". The indexer re-reads the wallet's balance, and when it has sold, the callout shows the position as closed and the market cap it was closed at.

A round is one UTC day. Its rewards can be claimed during the 24 hours after it ends; whatever is not claimed by then goes to the team wallet. A callout counts when the attester signed it (EIP-712 `Submission`, which carries the market cap) for the running round and it is recorded in the vault before the round ends; a holder can record at most 3 a round and must hold at least 0.01% of the token's supply. Every recorded link is emitted in full.

Nobody signs per payout. A holder's single `claim(token, rounds)` pays everything the token owes them, and `claimMany(tokens, rounds)` does it across tokens: the wallet menu lists a wallet's callout rewards and claims them in one transaction. A caller does not record their own callout either: once it is approved, the Worker relays the reviewer's signed approval to the vault with a key that only pays gas (`RELAYER_PRIVATE_KEY`, a Worker secret; it can approve nothing and holds no funds beyond gas). Without that secret, the author records it from the feed. The team sends nothing to be paid: the platform share is forwarded on every deposit, and every deposit also sweeps up to two finished rounds, so rounds are settled by the fees that keep arriving. `collect(maxRounds)`, callable by anyone, does the same when fees have stopped arriving or the team wallet could not be paid inside a deposit (it gets 30,000 gas there; a wallet that needs more is paid by `collect`).

**Solvency.** Each token has a ledger of what its fees brought in for its callers and what has been paid out of it. A payout that would take a token past what it produced reverts (`Insolvent`), so one token's rewards are never paid with another's fees. `ledgerOf(token)` shows both numbers.

**Roles and keys.** The team wallet is the guardian of the vault, the router and the factory, the receiver of the platform share, and the first attester. The guardian can change the two fee rates (within their caps). In the vault it can replace the attester, replace the team wallet, move the split (the platform share can never exceed 25%) and change the round rules, but none of these at once: each is scheduled in public (`scheduleAttester`, `scheduleTeamWallet`, `scheduleSplit`, `scheduleRules`), waits two days, and is then put in place by anyone (`applyAttester` and so on). The one thing it can do at once is stop callouts from being recorded (`setSubmissionsPaused`), which is the answer to an attester key that has leaked. It cannot touch amounts already owed. A caller's weight comes from what the attester signs (the market cap and the holdings when the callout was posted), so the attester is trusted for that; it can be a separate key from the guardian, or a multisig (the vault accepts ERC-1271 signatures), and is replaced through the same two-day schedule. No server key can move funds or approve anything: fees are split by the contracts, and callouts are approved by the attester wallet signing in the browser at `#/review`. The Worker's configuration holds two public addresses (`CALLOUT_ATTESTER`, `CALLZ_VAULT`). Its one optional secret is the gas-only relayer key above.

Not built from the vault passdown: the Flap tax-slot variant (`DIVIDEND` + `VAULT` slots on a Flap tax token, behind `DirectLaunchVaultFactoryBase`), X proofs through Flap's `XGeneralVerifier` (X posts go through the same review as the other sites), and the Trigger Service auto-sweep (finished rounds are swept by the next fee instead). The passdown's ungated holder dividend became the holder share above: without staking, a vault cannot weigh holders of a token it does not control except at the moment they act.

## Status

- **Pre-audit, 27 Nov 2026: `CallZLauncher` 1.1.0 and `CallZLauncherFactory` passed** (0 critical, 0 high, 3 disclosure
  notes), on forks of BNB Chain and BNB Chain Testnet against the live Portal. The fixed factory is deployed on BNB
  Chain Testnet at `0x1C43a0bBf01034c30c9d30F23C00E7F3019E678c`; on BNB Chain it is deployed from the Launch page, to
  the same address, and launches nothing until Flap enables it. The vault, router, PancakeSwap path and curve path
  are outside that review. The three notes, which the site states where they apply:
  - A low pool share cannot launch: the Portal's floor rises as the share falls, and at its standard floor a share
    under about 11% is over the 10 BNB cap, so its mint is refused at creation. The create page shows the smallest
    share that can launch, read from the Portal.
  - NFTs that have not claimed earn no dividends on this path, because the Portal excludes the Launcher from them.
    Holders should claim early.
  - Flap's Guardian can call `openRefunds` on any mint that has not launched. It is the recovery path.
- **Changes made in review on 27 Nov 2026 moved the contracts to new addresses, the vault and what names it twice.** The site points at the
  new ones, listed first above. Until each is deployed (one transaction each from the site: the Launcher Factory
  from the testnet launch page, the vault, router and mint factory from the Launch page), the site shows it as
  not deployed, trades go straight through PancakeSwap's router with no CallZ fee, and callouts cannot be
  recorded. Whether they are deployed is read from the chain, not from this file. The earlier vault never
  received a fee and the earlier fee factory created no mint, so nothing is left behind in them.
  - `CallZLauncher`: a mint whose token name or symbol Flap's anti-scam module flags is refused when it is
    created. With the check the contract passed the 24,576-byte size limit at 99,999 optimizer runs, so
    `foundry.toml` compiles it, its factory and its tests at 2,000 runs. Build from a clean `out/`.
  - `CallZVault`: replacing the attester or the team wallet, changing the split and changing the round rules
    are each scheduled and take effect two days later (`scheduleAttester`, `scheduleTeamWallet`,
    `scheduleSplit`, `scheduleRules` and their `apply…` and `cancel…`), and the guardian can stop callouts
    being recorded at once (`setSubmissionsPaused`). After a round ends, the balances of all its callers are
    read together in one transaction (`checkpoint`, taken by the round's first claim), and the holder share is
    worked out on what each still holds, so tokens passed between callers' wallets count once and take nothing
    from the other callers. A round's holder share takes at most 256 holders per token. "Fees and the vault"
    above describes these sources.
  - `CallZCurve` (never deployed): the mint earned BNB dividends on the tokens of unclaimed NFTs and nothing
    could withdraw them. An NFT is now paid its part of them, in BNB, when it claims.
  - Tests on these sources: 84 of 84 pass (`CallZLauncher` 18 on BNB Chain Testnet and 18 on a fork of BNB
    Chain, vault and fees 22, `CallZPancake` 16, `CallZCurve` 10). The counts in the lines below are for the
    deployed code.

- `CallZVault`, `CallZRouter` and the launch fee: 16 fork tests pass on a fork of BNB Chain (`test/callz/CallZFees.BSC.fork.t.sol`), against the real PancakeSwap and two live Flap tax tokens, one pooled against BNB and one against USDT: the split to the wei, the snapshot (nothing leaves the wallet), weighting by market cap and by the volume after the call, selling cutting the payout, refusals, the 24-hour window, the team wallet being paid by the next fee, a team wallet that refuses BNB, the fee caps, an attester wallet with delegated code (EIP-7702), and the per-token solvency ledger. `apps/web/tests/fees.pw.ts` drives a buy, a sell, a callout (posted, approved, recorded) and the claim after the round ends through the pages on a local fork.

- `CallZLauncher`: 17 fork tests pass against the live Pool Launch Portal on BNB Chain Testnet and against a fork of BNB Chain.
- `CallZLauncher`, live on BNB Chain Testnet through Flap Pool Launch, from the site's own launch page: Launcher and pass NFT [`0x86A22874083777D066359D6ef3661C6D8f186E90`](https://testnet.bscscan.com/address/0x86A22874083777D066359D6ef3661C6D8f186E90) ([its page](https://callz.fun/#/launcher/0x86a22874083777d066359d6ef3661c6d8f186e90)) sold 16 passes at 0.1 tBNB. The [mint that reached the 1.6 tBNB cap](https://testnet.bscscan.com/tx/0xf61c38701bd424d60b316d0578b3fd2f778372385b9e95b6a5c529fd29fc26fa) launched the token CZTEST [`0xF53F1C30ac65095f04845F10E1E1935702387777`](https://testnet.bscscan.com/address/0xF53F1C30ac65095f04845F10E1E1935702387777) in the same transaction: pool [`0xB9E05D4a0B7DC8fB98BdCC12CeD52D107Ef6Ac2d`](https://testnet.bscscan.com/address/0xB9E05D4a0B7DC8fB98BdCC12CeD52D107Ef6Ac2d) holds the whole raise and 75% of the supply, and all of its LP is burned.
- `CallZCurve`: 7 fork tests pass against Flap's bonding curve Portal on a fork of BNB Chain, with nothing impersonated. The deploy, create, mint and claim commands below were rehearsed end to end on a local fork.
- Launch UI: passes Flap's `launcher:check-source` and a strict TypeScript check. In `apps/web` it has created a Launcher, minted to the cap, launched and claimed on a local fork of BNB Chain Testnet. It has not been run inside Flap's own host.
- `CallZPancake`: 16 fork tests pass against PancakeSwap on a fork of BNB Chain, including a pair created and funded by someone else before the launch, re-entry during the launch and payments, and the heaviest launch (7.8M gas, under the 16.7M cap).
- Site: `apps/web/tests/trade.pw.ts` drives buys, sells, a wallet-menu sale, one-click buys, adding and removing liquidity, the trades table, the pop-out and a signed chat post through the page, and `tests/launch.pw.ts` drives the whole mainnet launch (deploy the factory, create, mint to the cap, launch, claim, buy the new token), both on a local fork of BNB Chain against the real PancakeSwap contracts.
- The contracts are not audited.

## What is in this repository

| Path | What it is |
| --- | --- |
| `contracts/src/callz/` | `CallZLauncher` and `CallZLauncherFactory` (Pool Launch, on Flap's `LauncherBase` and `LauncherFactoryBase`), `CallZCurve` and `CallZCurveFactory` (bonding curve), and `CallZPancake`, `CallZPancakeFactory` and `CallZToken`: the pass mint that launches into PancakeSwap. |
| `contracts/test/callz/` | Fork tests that run the whole flow against Flap's and PancakeSwap's live contracts. |
| `contracts/script/` | Deploy and create scripts for both paths. |
| `flap-ui/callz-launcher/` | The launch UI in Flap's Launcher UI template format: creation form and mint page. |
| `apps/web/` | The site: the aggregator pages and the CallZ launchpad, which hosts the launch UI package against the chain with a browser wallet. |
| `packages/protocol/`, `scripts/pull-factories.ts`, `data/` | Pool Launch indexing: decodes Portal events and aggregates every factory, Launcher, token and deployer. |
| `apps/worker/` | The Worker behind the site: the Pool Launch indexer (cron + D1) and its read API. |

## Contract rules

| Rule | `CallZLauncher` | `CallZCurve` |
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
- **Use a fresh deployer wallet.** `cast wallet new ~/.foundry/keystores callz` creates a new key straight into the keystore and prints only its address. The private key is never shown, typed or copied. Fund that address with what the deployment needs and nothing more. Do not import an operating key.
- **Never pass a key on the command line.** `--private-key` puts the key in your shell history. The commands here use `--account callz`, which asks for the keystore password each time.
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
BSC_RPC_URL=https://bsc-rpc.publicnode.com forge test --match-contract CallZCurveBSCForkTest --isolate
BSC_TESTNET_RPC_URL=https://bsc-testnet-rpc.publicnode.com forge test --match-contract CallZLauncherBSCTestForkTest --isolate
```

## Launch on BNB Chain (`CallZCurve`)

```sh
cd contracts
cast wallet new ~/.foundry/keystores callz      # prints the new address; fund it
forge script script/DeployCurve.s.sol --rpc-url https://bsc-rpc.publicnode.com --account callz --broadcast --legacy

export CURVE_FACTORY=0xCe3e30FC569C7931eB4F366c9F2EE5287D3637Ca
export TOKEN_NAME="CallZ" TOKEN_SYMBOL=CALLZ
export NFT_PRICE=10000000000000000 CAP=50000000000000000 SALE_DURATION=3600   # 0.01 BNB x 5 NFTs, 1 hour
forge script script/CreateCurveMint.s.sol --rpc-url https://bsc-rpc.publicnode.com --account callz --broadcast --legacy

cast send <mint> "mint()" --value 0.05ether --rpc-url https://bsc-rpc.publicnode.com --account callz --legacy
cast send <mint> "claim()" --rpc-url https://bsc-rpc.publicnode.com --account callz --legacy
```

Creating a mint costs the Portal's salt-lock fee (0.01 BNB) plus gas. `BUY_TAX_BPS` and `SELL_TAX_BPS` default to 300 and 500. There is no liquidity floor on the curve, so a mint can be small.

## Launch on BNB Chain Testnet (`CallZLauncher`)

```sh
cd contracts
export BSC_TESTNET_RPC_URL=https://bsc-testnet-rpc.publicnode.com
forge script script/Deploy.s.sol --rpc-url $BSC_TESTNET_RPC_URL --account callz --broadcast --legacy

export FACTORY=0x1C43a0bBf01034c30c9d30F23C00E7F3019E678c
export TOKEN_NAME="Raid Example" TOKEN_SYMBOL=RAIDX
export NFT_PRICE=250000000000000000 CAP=2500000000000000000 SALE_DURATION=86400   # 0.25 tBNB x 10 NFTs
forge script script/CreateLauncher.s.sol --rpc-url $BSC_TESTNET_RPC_URL --account callz --broadcast --legacy

cast send <launcher> "mint()" --value 0.25ether --rpc-url $BSC_TESTNET_RPC_URL --account callz --legacy
cast send <launcher> "claim()" --rpc-url $BSC_TESTNET_RPC_URL --account callz --legacy
```

`POOL_SHARE_BPS`, `BUY_TAX_BPS` and `SELL_TAX_BPS` default to 5000, 300 and 500.

The Portal rejects a launch whose pool is below its liquidity floor: 750 USD of BNB divided by the pool share, at the Portal's configured BNB price (700 USD when this was written). At a 50% pool share that is 1,500 USD, about 2.15 BNB, unless Flap sets a lower multiplier for the factory. A mint whose cap is below the floor cannot launch, and its NFTs are refunded after the deadline.

On BNB Chain Testnet the Portal accepts Launchers from any factory. On BNB Chain, Pool Launch is permissioned: token creation is paused and `Portal.newLauncher` reverts for any factory Flap has not audited and enabled.

## BNB Chain transaction rules this was checked against

- **Send with `--legacy`.** BNB Chain's base fee is 0, and Foundry's EIP-1559 estimate on BNB Chain Testnet comes out at 1 wei, far below the node's quoted gas price. With `--legacy` Foundry uses the node's gas price (0.05 gwei on BNB Chain, the network minimum, and 0.1 gwei on Testnet when this was written).
- **Per-transaction gas cap: 16,777,216** (BEP-652, live since the Mendel upgrade). The heaviest `CallZLauncher` or `CallZCurve` transaction, a mint of the 50-NFT per-call maximum that also runs the launch, uses about 9.3M gas on either path. Each suite asserts the margin.
- **Large holders.** `claim()` costs about 30,000 gas per NFT, so one call covers roughly 500 NFTs; a wallet holding more uses `claimNFTs(ids)` in batches. The same applies to `refund()` and `refundNFTs(ids)`.
- **Contract size.** `CallZLauncher` is 23.0 KB of runtime code and `CallZCurve` 18.6 KB, under the 24,576-byte limit.
- **Launcher description.** The Pool Launch Portal reads at most 4,096 bytes of a Launcher's `description()` with at most 200,000 gas, and stores an empty description past either limit. With the longest name and symbol the Launcher accepts, the description is 1,449 bytes and costs about 53,000 gas; `test_13` asserts it.

## Launch UI

`flap-ui/callz-launcher/` holds the three files Flap's Launcher runtime takes: `Component.tsx`, `manifest.json` and `i18n.json` (English, Chinese, Korean). It targets `CallZLauncher` and uses `launcher-config-preview/v1`:

- `LauncherConfig` is the creation form: price, cap, mint window, pool share and taxes. It encodes `CallZConfig`, asks the host for a salt and the creation fee, and submits `Portal.newLauncher`.
- `Launcher` is the mint page: progress, mint with a quantity, and claim or refund when they apply.

Check it from a checkout of [flap-vault-component-template](https://github.com/flap-sh/flap-vault-component-template) (branch `test/pool-launch-developer-preview`):

```sh
yarn launcher:check-source /path/to/flat-launchpad/flap-ui/callz-launcher
```

## Web app

`apps/web` is a site that runs the launch UI package against the chain directly. Flap's site runs a Launcher UI package inside its own host, which reads the contract and sends every transaction. `apps/web/src/host.ts` implements that same host contract with a browser wallet, so the exact files in `flap-ui/callz-launcher/` run here unchanged: the creation form, the mint page, claim and refund.

```sh
npm install
npm run dev --workspace @flat/web          # http://localhost:5173
npm run test:viewport --workspace @flat/web
npx vitest run apps/web/tests/salt.test.ts
```

- **Live:** https://callz.fun, served by Cloudflare as static files (`apps/web/wrangler.jsonc`). Cloudflare builds and deploys it from this repository on every push to `main`, so going live does not depend on any one machine or stored token. There is no server code and nothing secret on the site: visitors sign with their own wallets, and the page reads public chain data.
- **No key needed to deploy the factory.** While the factory has no code on the network, the page offers a "Deploy the factory" button: one transaction from any browser wallet, through the deterministic CREATE2 deployer, to the same address `Deploy.s.sol` produces.
- **Security headers** (`apps/web/public/_headers`): a Content-Security-Policy that allows only the page's own scripts and the one RPC endpoint it reads from, no framing by other sites, HSTS, and no referrer or content-type leaks.
- **Floor check.** A mint whose cap is under the Portal's liquidity floor can never launch. The Create page reads the floor from the Portal and shows the smallest cap that can launch for three pool shares, and a mint page warns when its mint cannot launch (`apps/web/src/floor.ts`).
- **Network and factory** come from the package's `manifest.json` (BNB Chain Testnet).
- **Launches** are listed from the factory's own `launchers` array, so no indexer is needed.
- **Background.** The BNB mark in about 9,000 gold particles (three.js, loaded after first paint). They fly in to form it; left alone it breathes, sways and catches a passing light; particles move out of the pointer's way and close in behind it. Around it a field of motes floats across the whole screen and parts in the pointer's wake. All motion runs in the vertex shaders, two draw calls per frame. It moves for every visitor: with the system's "reduce motion" setting on, only the opening fly-in is skipped.
- **Phone and tablet layout.** Under 1024 px the page renders a separate shell: compact top bar, cards in place of tables, and a tab bar at the bottom.
- **Viewport tests.** 90 Playwright checks, nine pages at ten screen sizes from a folded Galaxy Fold to an ultrawide monitor, with live index data in them: no sideways scroll, the right shell for the size, the canvas covering the viewport, every control on-screen and at least 44 px tall on touch screens, and the tab bar never covering content. They run in the Edge or Chrome already installed.
- **Salt test.** The token-address prediction is checked against every salt the live Portal has locked.
- **Flow test.** `tests/flow.pw.ts` drives the whole launch through the page on a local fork of BNB Chain Testnet: deploy the factory, create a Launcher, mint every NFT, launch, claim. The contracts, the Portal and the page are the real ones; the fork's own account stands in for the wallet. The steps to run it are at the top of the file.
- **Endpoint.** `VITE_RPC_URL` points the page at another RPC endpoint.

## Aggregator and indexer

The site and its indexer are one Cloudflare Worker (`apps/web/wrangler.jsonc`, code in `apps/worker/`):

- **Pages.** Static files. `/`, `/scope` (Memescope), `/launches`, `/tokens`, `/factories` and `/deployers` read the index; `/launch/testnet`, `/create` and `/launcher/<address>` are the launchpad and talk to the chain and the visitor's wallet.
- **`/api/<chain>/<resource>`.** Read-only JSON: `overview`, `scope`, `launchers`, `tokens`, `factories`, `deployers`, for `bsc` and `bscTestnet`.
- **`/api/chat/<chain>/<token>`.** A token's chat room (`apps/worker/src/chat.ts`). A message is stored when its author's wallet signed its exact text within the last five minutes and that signature has not been used before. Every value reaches the database as a bound parameter of a prepared statement. Messages are plain text with control and invisible characters removed, links are refused, and the page shows them as text nodes. Rate limited per wallet inside the insert itself.
- **`/api/meta/<ipfs path>`.** A token's own description and links, from the metadata its creator pinned at launch.
- **`/api/image/<ipfs path>?w=64|128|256`.** A token's picture as a small thumbnail, so the page loads pictures from its own origin and its content policy stays `img-src 'self'`. Only IPFS paths are accepted, only raster images are passed on, nothing over 2 MB.
- **Cron, every minute.** Reads new Pool Launch Portal events into a D1 database (`apps/worker/migrations/`). It follows the head in steps of at most 2,000 blocks, stays 20 blocks behind it, and records its last error where `overview` shows it. Each run also reads, in one Multicall3 call per chain, the quote balance every open Launcher holds (its raise progress), and resolves a few tokens' pictures from their metadata on IPFS (`apps/worker/src/enrich.ts`).
- **Launchpad names.** A Launcher Factory is named by the title most of its Launchers carry in their own on-chain description. A factory whose Launchers each carry a different title is shown by its address.
- **No secrets.** The Worker holds no keys. Visitors sign with their own wallets.

History is loaded once with `scripts/backfill-d1.ts`, from a machine whose RPC endpoint serves the whole log range, because public endpoints answer large history queries unreliably from Cloudflare's network (timeouts on BNB Chain, silently shortened results on Testnet). The script writes the same idempotent statements the Worker runs:

```sh
npx tsx scripts/backfill-d1.ts > backfill.sql
npx wrangler d1 execute raidpass-index --remote --file backfill.sql --config apps/web/wrangler.jsonc
```

For production, point the Worker at a private RPC endpoint: add `BSC_RPC_URL` and `BSC_TESTNET_RPC_URL` as Worker secrets in the Cloudflare dashboard. Nothing else changes.

`npm run pull` is the same scan as a local command: it writes `data/bsc.json` and `data/bscTestnet.json`.

**Loading.** The first page loads 79 KB of script (gzip). The launchpad's chain library (110 KB) and the three.js scene (133 KB) load only when they are needed.

## Team

CallZ is built by [Liquid Labs](https://liquidlabs.io), the studio behind Top Blasters, a 128-player browser game on its own engine and netcode, and the brand and go-to-market work behind SPX6900 and MOG.

## Credits

`contracts/src/flap/`, `contracts/test/ForkBase.sol` and `contracts/test/ForkAddresses.sol` are from Flap's [FlapPoolLaunchVaultExample](https://github.com/flap-sh/FlapPoolLaunchVaultExample). The Solidity sources carry MIT SPDX identifiers.
