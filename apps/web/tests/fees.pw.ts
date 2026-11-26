import { expect, test, type Page } from "@playwright/test";
import { encodeFunctionData, parseAbi } from "viem";
import deployment from "../src/callz-deployment.json" with { type: "json" };

/**
 * CallZ's fees end to end, through the pages, on a local fork of BNB Chain: the 2% trading fee reaching the
 * vault and the team wallet, a callout going from posted (with the wallet's holdings and the market cap recorded),
 * to approved by the reviewer wallet, to recorded in the vault with its snapshot, and the single claim that pays
 * it out once the round has ended. Nothing is staked anywhere.
 *
 * The contracts are deployed on the fork with the very transactions the site's Deploy button sends. PancakeSwap,
 * the Flap token and the pages are the real ones; the fork's own unlocked account stands in for a browser
 * wallet. So that it can also review, the test makes it the vault's attester, acting as the guardian on the fork,
 * and the local API has to be told the same:
 *
 *   anvil --fork-url https://bsc-rpc.publicnode.com --port 8548
 *   npx wrangler d1 migrations apply raidpass-index --local
 *   npx wrangler dev --port 8788 --var CALLOUT_ATTESTER:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --var BSC_RPC_URL:http://127.0.0.1:8548 --var RELAYER_PRIVATE_KEY:<anvil's second development key>
 *   (the relayer key only pays gas: anvil's published second key does that on the fork)
 *   (the API reads the poster's holdings from the chain, so it has to read the fork too)
 *   VITE_BSC_RPC_URL=http://127.0.0.1:8548 TRADE_RPC_URL=http://127.0.0.1:8548 API_ORIGIN=http://localhost:8788 npx playwright test tests/fees.pw.ts --workers=1
 */
const RPC = process.env.TRADE_RPC_URL;
// anvil's first development account.
const ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
// A token launched through Flap's Pool Launch, pooled against BNB.
const TOKEN = "0x7c45614b3449cf2603262b3854c75a67d1517777";
// A token that graduated on Pool Launch: its pool is deep enough to buy a holder's worth (0.01% of the supply) of.
const GRADUATED = "0xc6d357ac5316160c23c02ad0b87357719b8c7777";
const VAULT = deployment.vault.address;

test.skip(!RPC, "set TRADE_RPC_URL to a local fork of BNB Chain");
test.setTimeout(240_000);
test.describe.configure({ mode: "serial" });

let rpcId = 0;
async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(RPC!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

async function mined(hash: string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const receipt = await rpc<{ status: string } | null>("eth_getTransactionReceipt", [hash]);
    if (receipt) {
      expect(receipt.status, `transaction ${hash}`).toBe("0x1");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`transaction ${hash} was not mined`);
}

const balanceOf = async (address: string) => BigInt(await rpc<string>("eth_getBalance", [address, "latest"]));

test.beforeAll(async () => {
  if (!RPC) return;
  // The same three transactions the Launch page's Deploy button sends, for whatever is not on the fork yet.
  for (const contract of [deployment.vault, deployment.router, deployment.factory]) {
    if ((await rpc<string>("eth_getCode", [contract.address, "latest"])) !== "0x") continue;
    await mined(await rpc<string>("eth_sendTransaction", [{ from: ACCOUNT, to: deployment.deployer, data: `${contract.salt}${contract.initCode.slice(2)}`, gas: "0x989680" }]));
  }
  // The guardian (the team wallet) makes the fork's account the attester, so this test can review.
  await rpc("anvil_impersonateAccount", [deployment.team]);
  await rpc("anvil_setBalance", [deployment.team, "0xde0b6b3a7640000"]);
  const data = encodeFunctionData({ abi: parseAbi(["function setAttester(address attester)"]), functionName: "setAttester", args: [ACCOUNT] });
  await mined(await rpc<string>("eth_sendTransaction", [{ from: deployment.team, to: VAULT, data }]));
  await rpc("anvil_stopImpersonatingAccount", [deployment.team]);
});

/** A minimal EIP-1193 provider that hands every request to the fork, which signs for its own account. */
async function useForkWallet(page: Page) {
  await page.addInitScript(
    ({ rpc, account }) => {
      let id = 0;
      (window as unknown as { ethereum: unknown }).ethereum = {
        async request({ method, params }: { method: string; params?: unknown[] }) {
          if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
          if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
          const response = await fetch(rpc, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }),
          });
          const body = await response.json();
          if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
          return body.result;
        },
        on() {},
        removeListener() {},
      };
    },
    { rpc: RPC!, account: ACCOUNT },
  );
}

test("a buy and a sell through the token page each pay 2% of the BNB to the vault and the team wallet", async ({ page }) => {
  await useForkWallet(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const before = await balanceOf(VAULT);
  const teamBefore = await balanceOf(deployment.team);

  await page.goto(`/#/token/${TOKEN}`);
  const panel = page.getByTestId("trade-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await panel.locator("input[name=amount]").fill("0.5");
  // The quote names the fee before the wallet opens: 2% of 0.5 BNB.
  await expect(panel.getByTestId("trade-fee")).toContainText("2% · 0.01 BNB", { timeout: 30_000 });
  await panel.locator("button.trade-go").click();
  await expect(panel.getByText("Bought.")).toBeVisible({ timeout: 90_000 });
  // 0.01 BNB of fee: three quarters stay in the vault for holders and callers, and the platform's quarter is
  // already in the team wallet, without the team sending anything.
  const afterBuy = await balanceOf(VAULT);
  expect(afterBuy - before).toBe(7_500_000_000_000_000n);
  expect((await balanceOf(deployment.team)) - teamBefore).toBe(2_500_000_000_000_000n);

  // Sell half: the page approves the CallZ router for exactly that amount, and the fee comes out of the BNB returned.
  await panel.getByRole("button", { name: "Sell", exact: true }).click();
  await panel.getByRole("button", { name: "50%" }).click();
  await expect(panel.getByTestId("trade-fee")).toContainText("2% ·", { timeout: 30_000 });
  await panel.locator("button.trade-go").click();
  await expect(panel.getByText("Sold.")).toBeVisible({ timeout: 120_000 });
  expect(await balanceOf(VAULT)).toBeGreaterThan(afterBuy);

  // The rewards panel shows what those fees put into this token's round.
  const rewards = page.getByTestId("rewards-panel");
  await expect(rewards.getByTestId("rewards-round")).toContainText("Round ends in", { timeout: 60_000 });
  await expect(rewards.getByTestId("rewards-round-book")).not.toContainText("0 BNB · 0 verified");
  expect(errors).toEqual([]);
});

test("a callout for another contract is refused; a real one is posted, approved, and recorded in the vault", async ({ page }) => {
  await useForkWallet(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Callouts count for holders, so buy some of the token first.
  await page.goto(`/#/token/${GRADUATED}`);
  const panel = page.getByTestId("trade-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await panel.locator("input[name=amount]").fill("0.2");
  await expect(panel.getByTestId("trade-fee")).toContainText("2% ·", { timeout: 30_000 });
  await panel.locator("button.trade-go").click();
  await expect(panel.getByText("Bought.")).toBeVisible({ timeout: 90_000 });
  const feed = page.getByTestId("token-callouts");
  await expect(feed).toBeVisible({ timeout: 30_000 });

  // A pump.fun callout carries its contract: one for a different token cannot be posted here.
  await feed.locator("input[name=callout-link]").fill("https://pump.fun/callouts/0xFe189E97832DA1573e4e4Ff034F4fFC3a15c7777/7f179b33-b00a-4c2e-a119-153b48b7f9d6?share");
  await feed.getByRole("button", { name: "Post" }).click();
  await expect(feed.getByRole("alert")).toContainText("different contract");

  // An X post. The id is new on every run: a link can be posted once, ever.
  const link = `https://x.com/CallzForkTest/status/${Date.now()}`;
  await feed.locator("input[name=callout-link]").fill(link);
  await feed.locator("input[name=callout-note]").fill("fork test callout");
  await feed.getByRole("button", { name: "Post" }).click();
  const card = feed.locator(".callout-card").filter({ hasText: "fork test callout" }).first();
  await expect(card).toContainText("Awaiting review", { timeout: 30_000 });

  // The reviewer wallet approves it: an EIP-712 signature for the running round, checked by the API.
  await page.goto("/#/review");
  const review = page.getByTestId("review-page");
  const waiting = review.locator(".callout-card").filter({ hasText: link.toLowerCase() }).first();
  await expect(waiting).toBeVisible({ timeout: 30_000 });
  await waiting.getByRole("button", { name: "Approve" }).click();
  await expect(waiting).toHaveCount(0, { timeout: 30_000 });

  // Back on the token page the post is verified, and its author records it in the vault.
  await page.goto(`/#/token/${GRADUATED}`);
  const verified = page.getByTestId("token-callouts").locator(".callout-card").filter({ hasText: "fork test callout" }).first();
  // Nobody records it by hand: the API relayed the approval to the vault, which took the snapshot.
  await expect(verified).toContainText("Counted on-chain", { timeout: 120_000 });
  // It counts toward this round, and the vault has taken this wallet's snapshot. The tokens never left the wallet.
  // (One on a fresh fork; a fork this test already ran on today has counted the earlier ones too.)
  await expect(page.getByTestId("rewards-mine")).toContainText(/[1-3] of 3/, { timeout: 60_000 });
  await expect(page.getByTestId("rewards-snapshot")).toContainText("still holding");
  // The feed shows the market cap the call was made at.
  await expect(verified).toContainText("Called at $");
  expect(errors).toEqual([]);
});

test("after the round ends, one claim pays the callout rewards", async ({ page }) => {
  // Move the fork to ten minutes into the next UTC day, and put it back afterwards.
  const snapshot = await rpc<string>("evm_snapshot");
  try {
    const block = await rpc<{ timestamp: string }>("eth_getBlockByNumber", ["latest", false]);
    const nextDay = (Math.floor(Number(block.timestamp) / 86_400) + 1) * 86_400 + 600;
    await rpc("evm_setNextBlockTimestamp", [nextDay]);
    await rpc("evm_mine");

    await useForkWallet(page);
    await page.goto(`/#/token/${GRADUATED}`);
    const rewards = page.getByTestId("rewards-panel");
    // The round the callout was recorded in has ended: its rewards are claimable for 24 hours.
    await expect(rewards.getByTestId("rewards-finished")).toContainText("claim within", { timeout: 60_000 });
    // The wallet menu lists the reward too, and claims it in one transaction.
    const before = await balanceOf(VAULT);
    await page.getByTestId("wallet").click();
    const menu = page.getByTestId("wallet-rewards");
    await expect(menu).toContainText("Callout rewards", { timeout: 60_000 });
    await page.getByTestId("wallet-rewards-claim").click();
    await expect(menu).toContainText("Claimed.", { timeout: 120_000 });
    expect(await balanceOf(VAULT)).toBeLessThan(before);
    await page.keyboard.press("Escape");
    await expect(rewards.getByTestId("rewards-finished")).toHaveCount(0, { timeout: 60_000 });
  } finally {
    await rpc("evm_revert", [snapshot]);
  }
});
