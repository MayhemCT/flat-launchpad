import { expect, test } from "@playwright/test";

/**
 * The whole launch, driven through the page: create a Launcher, mint every NFT, launch, claim.
 *
 * It runs against a local fork of BNB Chain Testnet, where the fork's own unlocked account stands in for a
 * browser wallet. The page deploys the factory itself if the fork does not have it. The contracts, the
 * Portal and the page are the real ones; only the signer is the fork's.
 *
 *   anvil --fork-url https://bsc-testnet-rpc.publicnode.com --port 8547 --block-time 1
 *   VITE_RPC_URL=http://127.0.0.1:8547 FLOW_RPC_URL=http://127.0.0.1:8547 npx playwright test tests/flow.pw.ts
 */
const RPC = process.env.FLOW_RPC_URL;
// anvil's first development account.
const ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

test.skip(!RPC, "set FLOW_RPC_URL to a local fork with the factory deployed");
test.setTimeout(240_000);

test("create a Launcher, mint to the cap, launch and claim", async ({ page }) => {
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

  // On a fresh fork the current factory does not exist: deploy it from the page, with one transaction. The mint
  // made through the earlier factory on BNB Chain Testnet is listed before and after.
  await page.goto("/#/launch/testnet");
  const earlier = page.locator("tr", { hasText: "CallZ Testnet Pass" });
  await expect(earlier).toContainText("Launched", { timeout: 30_000 });
  const deployButton = page.getByRole("button", { name: "Deploy the factory" });
  if (await deployButton.isVisible()) {
    await deployButton.click();
    await expect(page.getByTestId("not-deployed")).toHaveCount(0, { timeout: 90_000 });
  }
  await expect(earlier).toContainText("Launched");

  // Create: 0.5 tBNB per NFT, cap 2.5 tBNB, so five NFTs. 2.5 tBNB clears the Portal's floor at a 50% pool share.
  await page.goto("/#/create");
  // The page reads the Portal's floor and shows the smallest cap that can launch, for three pool shares.
  const guide = page.getByTestId("floor-guide");
  await expect(guide).toBeVisible({ timeout: 30_000 });
  await expect(guide.locator("dd")).toHaveCount(3);
  await expect(guide.locator("dd").first()).toContainText("tBNB");
  await page.locator("input[name=name]").fill("Flow Test");
  await page.locator("input[name=symbol]").fill("FLOW");
  await page.locator("input[name=price]").fill("0.5");
  await page.locator("input[name=cap]").fill("2.5");
  await expect(page.getByText("5", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Review creation" }).click();
  await page.getByRole("button", { name: "Prepare transaction" }).click();
  await page.getByRole("button", { name: "Create Launcher" }).click({ timeout: 90_000 });
  await expect(page.getByText("Confirmed")).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: "Open mint page" }).click();

  // Mint all five: the mint that reaches the cap launches the token.
  await expect(page).toHaveURL(/#\/launcher\/0x[0-9a-f]{40}$/);
  await expect(page.getByText("0 / 5")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Minting")).toBeVisible();
  // 2.5 tBNB clears the floor, so the page raises no warning.
  await page.waitForTimeout(3000);
  await expect(page.getByTestId("floor-warning")).toHaveCount(0);
  await page.locator("input[name=quantity]").fill("5");
  await expect(page.getByText("2.5 tBNB").first()).toBeVisible();
  await page.getByRole("button", { name: "Mint", exact: true }).click();
  await page.getByRole("button", { name: "Confirm in wallet" }).click();
  await expect(page.getByText("5 / 5")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText("Launched")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("link", { name: "Token on Flap" })).toBeVisible();

  // Claim: five NFTs share half of a 1,000,000,000 supply, so 100,000,000 each.
  await expect(page.getByText("500,000,000", { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Claim tokens" }).click();
  await page.getByRole("button", { name: "Confirm in wallet" }).click();
  await expect(page.getByRole("button", { name: "Claim tokens" })).toHaveCount(0, { timeout: 90_000 });

  // The launchpad lists it.
  await page.goto("/#/launch/testnet");
  // The newest mint comes first: a fork that has run this before lists the earlier runs under it.
  await expect(page.locator("tr", { hasText: "Flow Test" }).first()).toContainText("Launched", { timeout: 30_000 });
  // The earlier factory's mint still opens: its page reads it and offers nothing to claim twice.
  await earlier.getByRole("link").click();
  await expect(page).toHaveURL(/#\/launcher\/0x86a22874083777d066359d6ef3661c6d8f186e90$/);
  await expect(page.getByText("16 / 16")).toBeVisible({ timeout: 30_000 });
  // A mint whose cap is under the Portal's floor cannot be created: the contract refuses it, so the page finds
  // that the transaction would revert and sends nothing to the wallet.
  await page.goto("/#/create");
  await page.locator("input[name=name]").fill("Too Small");
  await page.locator("input[name=symbol]").fill("SMALL");
  await page.locator("input[name=price]").fill("0.5");
  await page.locator("input[name=cap]").fill("1");
  await page.getByRole("button", { name: "Review creation" }).click();
  await page.getByRole("button", { name: "Prepare transaction" }).click();
  await page.getByRole("button", { name: "Create Launcher" }).click({ timeout: 90_000 });
  await expect(page.getByRole("alert")).toContainText("would revert", { timeout: 90_000 });
  await expect(page.getByText("Confirmed")).toHaveCount(0);

  // Nor can a mint whose token symbol Flap's anti-scam module flags, whatever its cap.
  await page.goto("/#/create");
  await page.locator("input[name=name]").fill("Flow Test Two");
  await page.locator("input[name=symbol]").fill("USDT");
  await page.locator("input[name=price]").fill("0.5");
  await page.locator("input[name=cap]").fill("2.5");
  await page.getByRole("button", { name: "Review creation" }).click();
  await page.getByRole("button", { name: "Prepare transaction" }).click();
  await page.getByRole("button", { name: "Create Launcher" }).click({ timeout: 90_000 });
  await expect(page.getByRole("alert")).toContainText("would revert", { timeout: 90_000 });
  await expect(page.getByText("Confirmed")).toHaveCount(0);

  expect(errors, "page errors").toEqual([]);
});
