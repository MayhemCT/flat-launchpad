import { expect, test, type Page } from "@playwright/test";

/**
 * Buying and selling through the token page, against the real PancakeSwap router and real Flap tax tokens.
 *
 * It runs on a local fork of BNB Chain, where the fork's own unlocked account stands in for a browser wallet.
 * The router, the pools, the tokens and the page are the real ones; only the signer is the fork's.
 *
 *   anvil --fork-url https://bsc-rpc.publicnode.com --port 8548
 *   VITE_BSC_RPC_URL=http://127.0.0.1:8548 TRADE_RPC_URL=http://127.0.0.1:8548 npx playwright test tests/trade.pw.ts
 */
const RPC = process.env.TRADE_RPC_URL;
// anvil's first development account.
const ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
// Two tokens launched through Pool Launch: one pooled against BNB, one against USDT.
const BNB_POOLED = "0x7c45614b3449cf2603262b3854c75a67d1517777";
const USDT_POOLED = "0x4d1fc29de06b7a39bbec1a3468104802d3277777";
// A token that graduated on Pool Launch, pooled against BNB, with its launch LP burned. BNB_POOLED above has not graduated.
const GRADUATED = "0xc6d357ac5316160c23c02ad0b87357719b8c7777";

test.skip(!RPC, "set TRADE_RPC_URL to a local fork of BNB Chain");
test.setTimeout(180_000);

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

async function buy(page: Page, token: string, amount: string) {
  await page.goto(`/#/token/${token}`);
  const panel = page.getByTestId("trade-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await panel.locator("input[name=amount]").fill(amount);
  // The page prices the amount before it lets the buy through.
  const receive = panel.locator(".trade-quote dd").first();
  await expect(receive).toContainText("≈", { timeout: 30_000 });
  await panel.locator("button.trade-go").click();
  await expect(panel.getByText("Bought.")).toBeVisible({ timeout: 90_000 });
  return panel;
}

test("buy a BNB-pooled tax token, then sell all of it", async ({ page }) => {
  await useForkWallet(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const panel = await buy(page, BNB_POOLED, "0.05");
  // The buy shows up as a balance of the token.
  await expect(panel.locator(".trade-held")).not.toContainText("· 0 ", { timeout: 30_000 });

  // Sell everything: the page approves the router for exactly that amount, then sells.
  await panel.getByRole("button", { name: "Sell", exact: true }).click();
  await panel.getByRole("button", { name: "100%" }).click();
  await expect(panel.locator(".trade-quote dd").first()).toContainText("BNB", { timeout: 30_000 });
  await panel.locator("button.trade-go").click();
  await expect(panel.getByText("Sold.")).toBeVisible({ timeout: 120_000 });
  expect(errors).toEqual([]);
});

test("buy a USDT-pooled token with BNB, through PancakeSwap's BNB/USDT pool", async ({ page }) => {
  await useForkWallet(page);
  const panel = await buy(page, USDT_POOLED, "0.05");
  await expect(panel.locator(".trade-foot")).toContainText("USDT pool");
});

test("a buy the pool cannot fill is refused before the wallet opens", async ({ page }) => {
  await useForkWallet(page);
  await page.goto(`/#/token/${BNB_POOLED}`);
  const panel = page.getByTestId("trade-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  // More BNB than the fork account's balance covers.
  await panel.locator("input[name=amount]").fill("99999999");
  await expect(panel.locator("button.trade-go")).toBeDisabled({ timeout: 30_000 });
  await expect(panel.locator("button.trade-go")).toContainText("Not enough BNB");
});

test("post a signed message in a token's chat", async ({ page }) => {
  await useForkWallet(page);
  await page.goto(`/#/token/${BNB_POOLED}`);
  const chat = page.getByTestId("token-chat");
  await expect(chat).toBeVisible({ timeout: 30_000 });
  const text = `fork test ${Date.now()}`;
  await chat.locator("input").fill(text);
  await chat.getByRole("button", { name: "Send" }).click();
  // The wallet signs the message, the server checks the signature, and it shows up in the room.
  await expect(chat.locator(".chat-message").filter({ hasText: text })).toBeVisible({ timeout: 30_000 });
});

test("the holder room takes posts from holders only", async ({ page }) => {
  await useForkWallet(page);
  // A token this wallet holds none of (CAKE): the holder room turns the post away.
  await page.goto("/#/token/0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82");
  let chat = page.getByTestId("token-chat");
  await expect(chat).toBeVisible({ timeout: 30_000 });
  await chat.getByTestId("chat-room-holders").click();
  await chat.locator("input").fill("not a holder");
  await chat.getByRole("button", { name: "Send" }).click();
  await expect(chat.getByText("The holder room is for wallets that hold this token.")).toBeVisible({ timeout: 30_000 });

  // After buying the token, the same wallet can post in its holder room, and the public room does not show it.
  await buy(page, BNB_POOLED, "0.05");
  chat = page.getByTestId("token-chat");
  await chat.getByTestId("chat-room-holders").click();
  // Chat allows one message every five seconds per wallet, across rooms: the test before this one just posted.
  await page.waitForTimeout(6000);
  const text = `holders only ${Date.now()}`;
  await chat.locator("input").fill(text);
  await chat.getByRole("button", { name: "Send" }).click();
  await expect(chat.locator(".chat-message").filter({ hasText: text })).toBeVisible({ timeout: 30_000 });
  await chat.getByTestId("chat-room-public").click();
  await expect(chat.locator(".chat-message").filter({ hasText: text })).toHaveCount(0);
});

test("the wallet menu lists a bought token and sells all of it", async ({ page }) => {
  await useForkWallet(page);
  await buy(page, BNB_POOLED, "0.05");
  // The wallet button shows the balance; opening it lists what the wallet holds.
  await page.getByTestId("wallet").click();
  const positions = page.getByTestId("positions");
  const row = positions.locator("li").first();
  await expect(row).toContainText("BNB", { timeout: 30_000 });
  await row.getByRole("button", { name: "Sell all" }).click();
  // A position sold in full leaves the list; the menu keeps saying what happened to it.
  await expect(positions.locator(".trade-done")).toContainText("Sold.", { timeout: 120_000 });
});

test("add liquidity to a graduated Flap pool, then take it out again", async ({ page }) => {
  await useForkWallet(page);
  // The Pools page lists the graduated pairs.
  await page.goto("/#/pools");
  await expect(page.getByTestId("pool-list").locator("li").first()).toBeVisible({ timeout: 60_000 });

  // Liquidity takes both sides of the pool, so buy some of the token first.
  await buy(page, GRADUATED, "0.2");
  await page.goto(`/#/pool/${GRADUATED}`);
  const panel = page.getByTestId("liquidity-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  // All four pool checks pass before anything can be added.
  await expect(page.getByTestId("pool-checks").locator("li[data-ok=true]")).toHaveCount(4, { timeout: 30_000 });
  await panel.locator("input[name=amount]").fill("0.05");
  await expect(panel.locator(".trade-quote dd").first()).not.toHaveText("—", { timeout: 30_000 });
  await panel.locator("button.trade-go").click();
  await expect(panel.getByText("Liquidity added.")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("pool-stats")).not.toContainText("0.00%", { timeout: 30_000 });

  await panel.getByRole("button", { name: "Remove", exact: true }).click();
  await panel.getByRole("button", { name: "100%" }).click();
  await expect(panel.locator(".trade-quote dd").first()).toContainText("BNB", { timeout: 30_000 });
  await panel.locator("button.trade-go").click();
  await expect(panel.getByText("Liquidity removed.")).toBeVisible({ timeout: 120_000 });
});

test("add liquidity to a major PancakeSwap pair, USDT/BNB, then take it out again", async ({ page }) => {
  await useForkWallet(page);
  await page.goto("/#/pools");
  await expect(page.getByTestId("major-pools").locator("li").first()).toBeVisible({ timeout: 60_000 });

  // Both sides are needed: buy some USDT with BNB first.
  await buy(page, "0x55d398326f99059ff775485246999027b3197955", "0.2");
  await page.goto("/#/pool/0x55d398326f99059ff775485246999027b3197955/bnb");
  const panel = page.getByTestId("liquidity-panel");
  await expect(page.getByTestId("pool-checks").locator("li[data-ok=true]")).toHaveCount(4, { timeout: 30_000 });
  await panel.locator("input[name=amount]").fill("0.05");
  await expect(panel.locator(".trade-quote dd").first()).toContainText("USDT", { timeout: 30_000 });
  await panel.locator("button.trade-go").click();
  await expect(panel.getByText("Liquidity added.")).toBeVisible({ timeout: 120_000 });

  await panel.getByRole("button", { name: "Remove", exact: true }).click();
  await panel.getByRole("button", { name: "100%" }).click();
  await expect(panel.locator(".trade-quote dd").first()).toContainText("BNB", { timeout: 30_000 });
  await panel.locator("button.trade-go").click();
  await expect(panel.getByText("Liquidity removed.")).toBeVisible({ timeout: 120_000 });
});

test("adding liquidity is closed for a pool that has not graduated", async ({ page }) => {
  await useForkWallet(page);
  await page.goto(`/#/pool/${BNB_POOLED}`);
  const panel = page.getByTestId("liquidity-panel");
  await expect(page.getByTestId("liquidity-closed")).toContainText("has not graduated", { timeout: 30_000 });
  await panel.locator("input[name=amount]").fill("0.05");
  await expect(panel.locator("button.trade-go")).toBeDisabled();
  await expect(page.getByTestId("pool-checks").locator("li[data-ok=false]").first()).toContainText("Graduated");
});

test("one-click buy from the Memescope board", async ({ page }) => {
  await useForkWallet(page);
  await page.goto("/#/scope");
  const button = page.locator("button.quick-buy").first();
  await expect(button).toBeVisible({ timeout: 30_000 });
  await button.click();
  // The first use explains what the button does and asks once.
  const consent = page.getByRole("dialog");
  await expect(consent).toContainText("One-click buys");
  await consent.getByRole("button", { name: "Turn on and buy" }).click();
  await expect(page.locator(".toast-done")).toContainText("Bought.", { timeout: 90_000 });
  // After that it is one click.
  await button.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // A second buy right after the first is the case a bare gas estimate ran out of gas on.
  await expect(page.locator(".toast").last()).toContainText("Bought.", { timeout: 90_000 });
  await expect(page.locator(".toast-error")).toHaveCount(0);
});

test("the token page lists the pool's trades, and its pop-out opens the full page again", async ({ page }) => {
  await useForkWallet(page);
  await page.goto(`/#/token/${BNB_POOLED}`);
  // The earlier tests traded this pool on the fork, so its own Swap events are there to read.
  await expect(page.getByTestId("token-trades").locator("tbody tr").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("pop-out")).toBeVisible();

  await page.goto(`/#/pop/${BNB_POOLED}`);
  const pop = page.getByTestId("pop-page");
  await expect(pop.getByTestId("token-chat")).toBeVisible({ timeout: 30_000 });
  await pop.locator("button.pop-title").click();
  await expect(page).toHaveURL(new RegExp(`#/token/${BNB_POOLED}$`));
});
