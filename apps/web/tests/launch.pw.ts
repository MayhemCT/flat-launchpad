import { expect, test } from "@playwright/test";
import flapFactory from "../src/factory-deployment.json" with { type: "json" };

/**
 * The whole mainnet launch, driven through the page: deploy the factory, create a pass mint, mint to the cap,
 * launch into PancakeSwap, claim, then buy the new token on its own page.
 *
 * It runs on a local fork of BNB Chain, where the fork's own unlocked account stands in for a browser wallet.
 * PancakeSwap's factory and router, WBNB, the CallZ contracts and the page are the real ones.
 *
 *   anvil --fork-url https://bsc-rpc.publicnode.com --port 8548
 *   VITE_BSC_RPC_URL=http://127.0.0.1:8548 TRADE_RPC_URL=http://127.0.0.1:8548 npx playwright test tests/launch.pw.ts
 */
const RPC = process.env.TRADE_RPC_URL;
// anvil's first development account.
const ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
// CallZ's Launcher Factory for Flap Pool Launch: the same address on BNB Chain as on BNB Chain Testnet.
const FLAP_FACTORY = flapFactory.address;

test.skip(!RPC, "set TRADE_RPC_URL to a local fork of BNB Chain");
test.setTimeout(300_000);

test("deploy the factory, create a mint, mint to the cap, launch, claim and trade", async ({ page }) => {
  // A minimal EIP-1193 provider that hands every request to the fork, which signs for its own account.
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
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  // On a fresh fork CallZ's contracts do not exist: the page deploys the vault, the router and the factory.
  await page.goto("/#/launch");
  const deploy = page.getByRole("button", { name: /^Deploy \d contracts?$/ });
  const create = page.getByRole("link", { name: "Create a mint" });
  await expect(deploy.or(create)).toBeVisible({ timeout: 30_000 });
  if (await deploy.isVisible()) {
    await deploy.click();
    await expect(create).toBeVisible({ timeout: 240_000 });
  }

  // The Flap Pool Launch factory is deployed from the same page, at the address it has on BNB Chain Testnet.
  await page.goto("/#/launch");
  const flapNote = page.getByTestId("flap-factory-not-deployed");
  await expect(create).toBeVisible({ timeout: 30_000 });
  if (await flapNote.isVisible()) {
    await flapNote.getByRole("button", { name: "Deploy the Flap factory" }).click();
    await expect(flapNote).toHaveCount(0, { timeout: 120_000 });
  }
  const flapFactoryCode = await (
    await fetch(RPC!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [FLAP_FACTORY, "latest"] }),
    })
  ).json();
  expect((flapFactoryCode.result as string).length, "the Flap factory has code on the fork").toBeGreaterThan(2);

  // Create: 0.5 BNB a pass, cap 1 BNB, so two passes; half the supply into the pool.
  await page.goto("/#/launch/create");
  const form = page.getByTestId("pancake-create");
  await form.locator("input[name=name]").fill("Fork Test");
  await form.locator("input[name=symbol]").fill("FORK");
  await form.locator("input[name=price]").fill("0.5");
  await form.locator("input[name=cap]").fill("1");
  await form.locator("input[name=hours]").fill("1");
  await form.locator("input[name=poolShare]").fill("50");
  await expect(page.getByTestId("pancake-summary")).toContainText("250,000,000");
  // The launch fee is named before the mint is created: 10% of the 1 BNB raise, the rest into the pool.
  await expect(page.getByTestId("pancake-summary")).toContainText("10% of the raise · 0.1 BNB");
  await expect(page.getByTestId("pancake-summary")).toContainText("0.9 BNB + 50% of supply");
  await form.getByRole("button", { name: "Create the mint" }).click();
  await expect(page).toHaveURL(/#\/mint\/0x[0-9a-f]{40}$/, { timeout: 120_000 });

  // Mint both passes: the mint that reaches the cap launches the token into PancakeSwap.
  const panel = page.getByTestId("mint-panel");
  await expect(page.getByTestId("mint-status")).toHaveText("Minting", { timeout: 30_000 });
  await panel.locator("input[name=quantity]").fill("2");
  await panel.getByRole("button", { name: "Mint 2 passes" }).click();
  await expect(page.getByTestId("mint-status")).toHaveText("Launched", { timeout: 120_000 });
  await expect(page.getByTestId("mint-stats")).toContainText("2 / 2");
  await expect(page.getByTestId("mint-stats")).toContainText("10% of the raise");

  // Claim: two passes share half of a 1,000,000,000 supply.
  await expect(panel).toContainText("500M", { timeout: 30_000 });
  await panel.getByRole("button", { name: "Claim tokens" }).click();
  await expect(panel.getByRole("button", { name: "Claim tokens" })).toHaveCount(0, { timeout: 120_000 });

  // The claimed tokens show under the wallet's positions, where they can be sold or opened.
  await page.getByTestId("wallet").click();
  const positions = page.getByTestId("positions");
  await expect(positions.locator("li").filter({ hasText: "FORK" })).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press("Escape");

  // The new token has a PancakeSwap pool, so its page can trade it straight away.
  await panel.getByRole("link", { name: "Chart and trading" }).click();
  const trade = page.getByTestId("trade-panel");
  await expect(trade).toBeVisible({ timeout: 30_000 });
  await trade.locator("input[name=amount]").fill("0.05");
  await expect(trade.locator(".trade-quote dd").first()).toContainText("FORK", { timeout: 30_000 });
  await trade.locator("button.trade-go").click();
  await expect(trade.getByText("Bought.")).toBeVisible({ timeout: 120_000 });
  expect(errors).toEqual([]);
});
