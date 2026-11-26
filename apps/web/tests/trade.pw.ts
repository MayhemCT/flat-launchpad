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
  await expect(page.locator(".toast-done")).toHaveCount(2, { timeout: 90_000 });
});
