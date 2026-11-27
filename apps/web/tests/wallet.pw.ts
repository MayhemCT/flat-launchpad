import { expect, test, type Page } from "@playwright/test";

/**
 * The wallet menu's Disconnect, and the floating pop-out. Neither sends a transaction: a stand-in wallet that
 * only answers which account it has is enough, and the pages read BNB Chain itself.
 *
 *   (from apps/web) npm run build && npx wrangler dev --port 8788
 *   npx playwright test -c playwright.fork.config.ts tests/wallet.pw.ts
 */
const ACCOUNT = "0x00000000000000000000000000000000000a11ce";
// A token launched through Flap's Pool Launch, pooled against BNB.
const TOKEN = "0x7c45614b3449cf2603262b3854c75a67d1517777";

async function useWallet(page: Page) {
  await page.addInitScript((account) => {
    const asked: string[] = [];
    (window as unknown as { asked: string[] }).asked = asked;
    (window as unknown as { ethereum: unknown }).ethereum = {
      async request({ method }: { method: string }) {
        asked.push(method);
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
        if (method === "eth_chainId") return "0x38";
        if (method === "eth_getBalance") return "0x0";
        if (method === "wallet_requestPermissions" || method === "wallet_revokePermissions") return [{ parentCapability: "eth_accounts" }];
        throw Object.assign(new Error("not offered by this stand-in"), { code: 4200 });
      },
      on() {},
      removeListener() {},
    };
  }, ACCOUNT);
}

test("disconnect forgets the wallet, stays disconnected over a reload, and connecting asks the wallet again", async ({ page }) => {
  await useWallet(page);
  await page.goto("/#/rooms");
  const wallet = page.getByTestId("wallet").first();
  await expect(wallet).toContainText("0x0000…11ce", { timeout: 30_000 });
  await expect(page.getByTestId("your-cooks")).toBeVisible({ timeout: 30_000 });

  await wallet.click();
  await page.getByTestId("wallet-disconnect").click();
  await expect(wallet).toHaveText("Connect wallet");
  // What belonged to the wallet is gone from the page.
  await expect(page.getByTestId("your-cooks")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { asked: string[] }).asked)).toContain("wallet_revokePermissions");
  expect(await page.evaluate(() => window.localStorage.getItem("callz.session"))).toBeNull();

  // The wallet still knows the site, but the page does not connect by itself any more.
  await page.reload();
  await expect(page.getByTestId("wallet").first()).toHaveText("Connect wallet", { timeout: 30_000 });
  await expect(page.getByTestId("your-cooks")).toHaveCount(0);

  // Connecting again goes through the wallet's own permission prompt, where another account can be picked.
  await page.getByTestId("wallet").first().click();
  await expect(page.getByTestId("wallet").first()).toContainText("0x0000…11ce", { timeout: 30_000 });
  expect(await page.evaluate(() => (window as unknown as { asked: string[] }).asked)).toContain("wallet_requestPermissions");
});

test("the pop-out floats as a picture-in-picture window where the browser offers one", async ({ page }) => {
  await page.goto(`/#/token/${TOKEN}`);
  const button = page.getByTestId("pop-out");
  await expect(button).toBeVisible({ timeout: 60_000 });
  const offered = await page.evaluate(() => "documentPictureInPicture" in window);
  test.skip(!offered, "this browser has no Document Picture-in-Picture");
  await button.click();
  // The floating window is drawn by this page: its document holds the pop-out, styled, with the token's chat.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const floating = (window as unknown as { documentPictureInPicture: { window: Window | null } }).documentPictureInPicture.window;
          const pop = floating?.document.querySelector("[data-testid=pop-page]");
          if (!floating || !pop) return null;
          return { sheets: floating.document.querySelectorAll('link[rel="stylesheet"], style').length, display: floating.getComputedStyle(pop).display };
        }),
      { timeout: 30_000 },
    )
    .toMatchObject({ display: "grid" });
});
