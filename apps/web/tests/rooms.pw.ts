import { expect, test, type Browser, type Page } from "@playwright/test";
import { decodeFunctionResult, encodeFunctionData, parseAbi, parseEther } from "viem";
import callz from "../src/callz-deployment.json" with { type: "json" };
import deployment from "../src/room-deployment.json" with { type: "json" };

/**
 * A room from start to finish, through the pages, on a local fork of BNB Chain: the dev creates it with a
 * picture, a token to hold and a role to state; wallets apply, and one that does not hold the token is turned
 * away; the dev lets them in and each buys its pass; they talk in the private chat with a link and a picture;
 * the dev removes one member, who gets the price back, and gives another points and a tag; with every seat
 * taken the dev launches, and a pass claims its tokens. Then the clan and the leaderboard pages.
 *
 * PancakeSwap, the CallZ vault and the pages are the real ones; the fork's own unlocked accounts stand in for
 * browser wallets.
 *
 *   anvil --fork-url https://bsc-rpc.publicnode.com --port 8559
 *   npx wrangler d1 migrations apply raidpass-index --local
 *   npx wrangler dev --port 8788 --var BSC_RPC_URL:http://127.0.0.1:8559
 *   VITE_BSC_RPC_URL=http://127.0.0.1:8559 npm run build      (then restart wrangler dev: it serves the build)
 *   TRADE_RPC_URL=http://127.0.0.1:8559 npx playwright test tests/rooms.pw.ts --workers=1
 *   (against http://localhost:8788, with the page's connect-src policy lifted so it can reach the fork)
 */
const RPC = process.env.TRADE_RPC_URL;
const FACTORY = deployment.factory.address;
const CAKE = "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const PANCAKE_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
// A real picture: a 2x2 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8Dwn4EIwDiqkL4KAV6SAwGOb7vVAAAAAElFTkSuQmCC", "base64");

test.skip(!RPC, "set TRADE_RPC_URL to a local fork of BNB Chain");
test.setTimeout(600_000);

const abi = parseAbi([
  "function raised() view returns (uint256)",
  "function seated() view returns (uint256)",
  "function launched() view returns (bool)",
  "function token() view returns (address)",
  "function tokensPerSeat() view returns (uint256)",
  "function image() view returns (string)",
  "function owed(address wallet) view returns (uint256)",
  "function seatOf(address wallet) view returns (uint256)",
  "function banned(address wallet) view returns (bool)",
  "function tokenURI(uint256 id) view returns (string)",
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[])",
]);

let rpcId = 0;
async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(RPC!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

async function mined(hash: string) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const receipt = await rpc<{ status: string } | null>("eth_getTransactionReceipt", [hash]);
    if (receipt) {
      expect(receipt.status, `transaction ${hash}`).toBe("0x1");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`transaction ${hash} was not mined`);
}

type ReadName = "raised" | "seated" | "launched" | "token" | "tokensPerSeat" | "image" | "owed" | "seatOf" | "banned" | "tokenURI" | "balanceOf";
async function read(to: string, functionName: ReadName, args: readonly unknown[] = []): Promise<unknown> {
  const data = await rpc<`0x${string}`>("eth_call", [{ to, data: encodeFunctionData({ abi, functionName, args } as never) }, "latest"]);
  return decodeFunctionResult({ abi, functionName, data } as never);
}

const balanceOf = async (address: string) => BigInt(await rpc<string>("eth_getBalance", [address, "latest"]));

/** Buys a little CAKE for `account` on the fork, so that it holds the token the room requires. */
async function buyCake(account: string) {
  const data = encodeFunctionData({ abi, functionName: "swapExactETHForTokens", args: [0n, [WBNB, CAKE], account as `0x${string}`, BigInt(Math.floor(Date.now() / 1000) + 86_400 * 365)] });
  await mined(await rpc<string>("eth_sendTransaction", [{ from: account, to: PANCAKE_ROUTER, data, value: `0x${parseEther("0.05").toString(16)}`, gas: "0x7A120" }]));
  expect((await read(CAKE, "balanceOf", [account])) as bigint).toBeGreaterThan(parseEther("1"));
}

/** A page whose wallet is one of the fork's accounts: every wallet request goes to the fork, which signs for it. */
async function walletPage(browser: Browser, account: string): Promise<{ page: Page; errors: string[] }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(
    ({ rpc, account }) => {
      let id = 0;
      (window as unknown as { ethereum: unknown }).ethereum = {
        async request({ method, params }: { method: string; params?: unknown[] }) {
          if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
          if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
          const response = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }) });
          const body = await response.json();
          if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
          return body.result;
        },
        on() {},
        removeListener() {},
      };
    },
    { rpc: RPC!, account },
  );
  return { page, errors };
}

test("a room: created, applied to, joined, talked in, a member removed, launched and claimed", async ({ browser }) => {
  const accounts = (await rpc<string[]>("eth_accounts")).map((account) => account.toLowerCase());
  const [devAccount, aliceAccount, bobAccount, carolAccount] = accounts as [string, string, string, string];
  // The vault the launch fee goes to is on BNB Chain already; a fork older than that gets it the way the site deploys it.
  if ((await rpc<string>("eth_getCode", [callz.vault.address, "latest"])) === "0x") {
    await mined(await rpc<string>("eth_sendTransaction", [{ from: devAccount, to: callz.deployer, data: `${callz.vault.salt}${callz.vault.initCode.slice(2)}`, gas: "0x989680" }]));
  }
  await buyCake(aliceAccount);
  await buyCake(carolAccount);
  // Bob starts without the token, whatever an earlier run on this fork left him.
  const bobHolds = (await read(CAKE, "balanceOf", [bobAccount])) as bigint;
  if (bobHolds > 0n) {
    const data = encodeFunctionData({ abi, functionName: "transfer", args: ["0x000000000000000000000000000000000000dEaD", bobHolds] });
    await mined(await rpc<string>("eth_sendTransaction", [{ from: bobAccount, to: CAKE, data, gas: "0x186A0" }]));
  }

  const dev = await walletPage(browser, devAccount);
  const alice = await walletPage(browser, aliceAccount);
  const bob = await walletPage(browser, bobAccount);
  const carol = await walletPage(browser, carolAccount);
  const stamp = Date.now().toString(36).slice(-5).toUpperCase();
  const roomName = `Flow Room ${stamp}`;

  // ── The dev: the factory, from the page, if the fork does not have it yet; then the room ──────────────────
  await dev.page.goto("/#/rooms");
  await expect(dev.page.getByTestId("rooms-list").or(dev.page.getByTestId("rooms-empty")).or(dev.page.getByTestId("room-factory-not-deployed")).first()).toBeVisible({ timeout: 30_000 });
  if ((await rpc<string>("eth_getCode", [FACTORY, "latest"])) === "0x") {
    await dev.page.getByTestId("room-factory-deploy").click();
    await expect(dev.page.getByTestId("room-factory-not-deployed")).toHaveCount(0, { timeout: 120_000 });
  }
  expect(await rpc<string>("eth_getCode", [FACTORY, "latest"])).not.toBe("0x");

  await dev.page.getByTestId("room-create-link").click();
  const form = dev.page.getByTestId("room-form");
  await expect(form).toBeVisible({ timeout: 30_000 });
  await form.locator("[name=name]").fill(roomName);
  await form.locator("[name=symbol]").fill(`F${stamp}`);
  await form.getByTestId("room-picture-input").setInputFiles({ name: "room.png", mimeType: "image/png", buffer: PNG });
  await expect(form.getByTestId("room-picture-preview")).toBeVisible({ timeout: 15_000 });
  await form.locator("[name=about]").fill("We build at night.");
  // The simple pricing: what to raise and how many passes; the page says what each costs.
  await form.locator("[name=total]").fill("0.1");
  await form.locator("[name=passes]").fill("2");
  await expect(form.getByTestId("room-summary-price")).toContainText("0.05");
  await form.locator("[name=hours]").fill("2");
  await form.locator("[name=wantHold]").check();
  await form.locator("[name=gateToken]").fill(CAKE);
  await expect(form.getByTestId("room-gate-token-label")).toContainText("Cake", { timeout: 30_000 });
  await form.locator("[name=gateAmount]").fill("1");
  await form.locator("[name=wantRole]").check();
  await form.locator("[name=roleBrief]").fill("People who ship.");
  await expect(form.getByTestId("room-create-submit")).toBeEnabled({ timeout: 15_000 });
  await form.getByTestId("room-create-submit").click();

  await dev.page.waitForURL(/#\/room\/0x[0-9a-f]{40}$/, { timeout: 180_000 });
  const room = /#\/room\/(0x[0-9a-f]{40})$/.exec(dev.page.url())![1]!;
  await expect(dev.page.getByTestId("room-head")).toContainText(roomName, { timeout: 60_000 });
  await expect(dev.page.getByTestId("room-about")).toContainText("We build at night.", { timeout: 30_000 });
  await expect(dev.page.getByTestId("room-requirements")).toContainText("Cake");
  const picture = (await read(room, "image")) as string;
  expect(picture).toMatch(/^https:\/\/callz\.fun\/api\/rooms\/image\/[0-9a-f]{64}$/);

  // The room is on the list, with its picture served from this site.
  await carol.page.goto("/#/rooms");
  const card = carol.page.locator(`[data-testid=room-card][data-room="${room}"]`);
  await expect(card).toContainText(roomName, { timeout: 30_000 });
  await expect(card.locator("img")).toHaveAttribute("src", new RegExp(`/api/rooms/image/${picture.slice(-64)}$`));

  // ── Alice holds the token: she applies ──────────────────────────────────────────────────────────────────
  await alice.page.goto(`/#/room/${room}`);
  const aliceSeat = alice.page.getByTestId("room-seat");
  await expect(aliceSeat).toHaveAttribute("data-state", "signin", { timeout: 60_000 });
  await alice.page.getByTestId("room-apply-signin").click();
  await expect(aliceSeat).toHaveAttribute("data-state", "apply", { timeout: 30_000 });
  await expect(alice.page.getByTestId("room-apply-holding")).toHaveAttribute("data-met", "true", { timeout: 30_000 });
  await aliceSeat.locator("[name=role]").fill("Designer");
  await aliceSeat.locator("[name=portfolio]").fill("My work: https://example.com/alice");
  await alice.page.getByTestId("room-apply-submit").click();
  await expect(alice.page.getByTestId("room-apply")).toHaveAttribute("data-applied", "true", { timeout: 30_000 });

  // ── Bob does not hold it: he is turned away, by the API and by what the page reads ───────────────────────
  await bob.page.goto(`/#/room/${room}`);
  const bobSeat = bob.page.getByTestId("room-seat");
  await expect(bobSeat).toHaveAttribute("data-state", "signin", { timeout: 60_000 });
  await bob.page.getByTestId("room-apply-signin").click();
  await expect(bob.page.getByTestId("room-apply-holding")).toHaveAttribute("data-met", "false", { timeout: 30_000 });
  await bobSeat.locator("[name=role]").fill("Coder");
  await bob.page.getByTestId("room-apply-submit").click();
  await expect(bob.page.getByTestId("room-apply-error")).toContainText("does not hold enough", { timeout: 30_000 });
  await buyCake(bobAccount);
  await expect(bob.page.getByTestId("room-apply-holding")).toHaveAttribute("data-met", "true", { timeout: 60_000 });
  await bob.page.getByTestId("room-apply-submit").click();
  await expect(bob.page.getByTestId("room-apply")).toHaveAttribute("data-applied", "true", { timeout: 30_000 });

  // ── The dev sees both, with what they handed in, and lets them in ───────────────────────────────────────
  const application = (wallet: string) => dev.page.locator(`[data-testid=room-application][data-wallet="${wallet}"]`);
  await expect(application(aliceAccount)).toContainText("Designer", { timeout: 60_000 });
  await expect(application(aliceAccount)).toContainText("https://example.com/alice");
  await expect(application(bobAccount)).toContainText("Coder", { timeout: 60_000 });
  for (const wallet of [aliceAccount, bobAccount]) {
    await application(wallet).getByTestId("room-application-admit").click();
    await expect(application(wallet)).toHaveAttribute("data-standing", "admitted", { timeout: 120_000 });
  }

  // ── Each buys their pass; the pass shows the room's picture and what it cost ─────────────────────────────
  for (const member of [alice, bob]) {
    await expect(member.page.getByTestId("room-seat")).toHaveAttribute("data-state", "admitted", { timeout: 60_000 });
    await member.page.getByTestId("room-buy").click();
    await expect(member.page.getByTestId("room-seat")).toHaveAttribute("data-state", "member", { timeout: 120_000 });
  }
  expect(await read(room, "raised")).toBe(parseEther("0.1"));
  const uri = (await read(room, "tokenURI", [1n])) as string;
  const pass = JSON.parse(Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64").toString("utf8")) as { image: string; attributes: Array<{ trait_type: string; value: unknown }> };
  expect(pass.image).toBe(picture);
  expect(pass.attributes).toContainEqual({ trait_type: "Price", value: "0.05 BNB" });
  await expect(dev.page.locator("[data-testid=room-member]")).toHaveCount(2, { timeout: 60_000 });

  // ── The private chat: a link and a picture, seen by another member, closed to everyone else ─────────────
  const aliceChat = alice.page.getByTestId("room-chat");
  await expect(aliceChat.getByTestId("room-chat-form")).toBeVisible({ timeout: 60_000 });
  await aliceChat.getByTestId("room-chat-form").locator("input[type=text], textarea").first().fill("gm, read this https://example.com/brief <b>not bold</b>");
  await aliceChat.getByTestId("room-chat-send").click();
  const aliceMessage = aliceChat.getByTestId("room-chat-message").filter({ hasText: "gm, read this" });
  await expect(aliceMessage).toBeVisible({ timeout: 30_000 });
  await expect(aliceMessage.locator('a[href="https://example.com/brief"]')).toHaveAttribute("rel", /noopener/);
  // What was typed as markup is shown as the text it is.
  await expect(aliceMessage).toContainText("<b>not bold</b>");
  expect(await aliceMessage.locator("b").count()).toBe(0);
  // The chat takes one message a second from a wallet.
  await alice.page.waitForTimeout(1500);
  await aliceChat.getByTestId("room-chat-picture-input").setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: PNG });
  await expect(aliceChat.getByTestId("room-chat-attached")).toBeVisible({ timeout: 15_000 });
  await aliceChat.getByTestId("room-chat-send").click();
  await expect(aliceChat.getByTestId("room-chat-picture").first()).toBeVisible({ timeout: 30_000 });
  const bobChat = bob.page.getByTestId("room-chat");
  await expect(bobChat.getByTestId("room-chat-message").filter({ hasText: "gm, read this" })).toBeVisible({ timeout: 30_000 });
  await expect(bobChat.getByTestId("room-chat-picture").first()).toBeVisible({ timeout: 30_000 });
  // Carol is not in the room: no chat for her.
  await carol.page.goto(`/#/room/${room}`);
  await expect(carol.page.getByTestId("room-head")).toContainText(roomName, { timeout: 60_000 });
  await expect(carol.page.getByTestId("room-chat-form")).toHaveCount(0);

  // ── The dev removes Bob: his pass is burned, he is barred, and his price is his again ───────────────────
  const memberRow = (wallet: string) => dev.page.locator(`[data-testid=room-member][data-wallet="${wallet}"]`);
  const roomBalance = await balanceOf(room);
  await memberRow(bobAccount).getByTestId("room-member-manage").click();
  await memberRow(bobAccount).getByTestId("room-kick").click();
  await expect(dev.page.getByTestId("room-kick-confirm")).toContainText("0.05");
  await dev.page.getByTestId("room-kick-yes").click();
  await expect(dev.page.locator("[data-testid=room-member]")).toHaveCount(1, { timeout: 120_000 });
  expect(await read(room, "seatOf", [bobAccount])).toBe(0n);
  expect(await read(room, "banned", [bobAccount])).toBe(true);
  expect(await read(room, "raised")).toBe(parseEther("0.05"));
  // The price left the room for Bob, or waits there for him to collect: nothing of it stays with the room.
  expect(roomBalance - (await balanceOf(room)) + ((await read(room, "owed", [bobAccount])) as bigint)).toBe(parseEther("0.05"));
  await expect(bob.page.getByTestId("room-seat")).toHaveAttribute("data-state", "banned", { timeout: 60_000 });
  await expect(bob.page.getByTestId("room-chat-form")).toHaveCount(0, { timeout: 60_000 });

  // ── The free seat goes to Carol, let in directly; then points and a tag for Alice ───────────────────────
  await dev.page.getByTestId("room-admit-form").locator("input").first().fill(carolAccount);
  await dev.page.getByTestId("room-admit").click();
  await expect(carol.page.getByTestId("room-seat")).toHaveAttribute("data-state", "admitted", { timeout: 120_000 });
  await carol.page.getByTestId("room-buy").click();
  await expect(carol.page.getByTestId("room-seat")).toHaveAttribute("data-state", "member", { timeout: 120_000 });
  expect(await read(room, "seatOf", [carolAccount])).toBe(3n);

  await memberRow(aliceAccount).getByTestId("room-member-manage").click();
  const points = memberRow(aliceAccount).getByTestId("room-points-form");
  await points.locator("input").first().fill("80");
  await points.locator("input").nth(1).fill("Drew the logo");
  await memberRow(aliceAccount).getByTestId("room-points-give").click();
  await expect(memberRow(aliceAccount).getByTestId("room-member-points")).toContainText("80", { timeout: 30_000 });
  await memberRow(aliceAccount).getByTestId("room-tag-form").locator("input").first().fill("Designer");
  await memberRow(aliceAccount).getByTestId("room-tag-save").click();
  await expect(memberRow(aliceAccount).getByTestId("room-member-tag")).toContainText("Designer", { timeout: 30_000 });

  // ── Every seat is taken: the dev launches, and Alice claims ─────────────────────────────────────────────
  const vaultBefore = await balanceOf(callz.vault.address);
  const teamBefore = await balanceOf(callz.team);
  await expect(dev.page.getByTestId("room-launch")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
  await dev.page.getByTestId("room-launch-button").click();
  await expect(dev.page.getByTestId("room-status")).toHaveAttribute("data-status", "launched", { timeout: 180_000 });
  expect(await read(room, "launched")).toBe(true);
  // 10% of the 0.1 BNB raised went to the vault, which passes the platform's part on to the team wallet.
  expect((await balanceOf(callz.vault.address)) - vaultBefore + ((await balanceOf(callz.team)) - teamBefore)).toBe(parseEther("0.01"));
  expect(await balanceOf(room)).toBe((await read(room, "owed", [bobAccount])) as bigint);
  const token = (await read(room, "token")) as string;

  await expect(alice.page.getByTestId("room-claim")).toBeVisible({ timeout: 120_000 });
  await alice.page.getByTestId("room-claim").click();
  await expect(alice.page.getByTestId("room-claim")).toHaveCount(0, { timeout: 120_000 });
  expect(await read(token, "balanceOf", [aliceAccount])).toBe(await read(room, "tokensPerSeat"));

  // ── Clans and the leaderboard ───────────────────────────────────────────────────────────────────────────
  await alice.page.goto("/#/clans");
  const mine = alice.page.getByTestId("my-clan");
  await expect(mine).toBeVisible({ timeout: 30_000 });
  const tag = `F${stamp.slice(0, 4)}`;
  await expect(mine.getByTestId("clan-found").or(mine.getByTestId("my-clan-name")).first()).toBeVisible({ timeout: 60_000 });
  if (await mine.getByTestId("clan-found").isVisible().catch(() => false)) {
    await mine.locator("[name=clan-name]").fill(`Flow ${stamp}`);
    await mine.locator("[name=clan-tag]").fill(tag);
    await mine.getByTestId("clan-found-submit").click();
    await expect(mine.getByTestId("my-clan-name")).toContainText(tag, { timeout: 30_000 });
  }
  const shownTag = (await mine.getByTestId("my-clan-name").innerText()).match(/\[([A-Z0-9]{2,5})\]/)![1]!;
  // The tag now stands before her name in the room's chat.
  await alice.page.goto(`/#/room/${room}`);
  await expect(alice.page.getByTestId("room-chat").getByTestId("room-chat-message").filter({ hasText: "gm, read this" }).locator(".clan-tag")).toHaveText(`[${shownTag}]`, { timeout: 60_000 });

  await alice.page.goto("/#/leaderboard");
  const row = alice.page.getByTestId("board-row").filter({ hasText: aliceAccount.slice(-4) });
  await expect(row.first()).toContainText(`[${shownTag}]`, { timeout: 30_000 });
  // The launched room is on the Launches page, with the way to its token.
  await alice.page.goto("/#/launched");
  const launchedCard = alice.page.locator(`[data-testid=launched-card][data-room="${room}"]`);
  await expect(launchedCard).toContainText(roomName, { timeout: 30_000 });
  await expect(launchedCard.getByTestId("launched-token")).toHaveAttribute("href", `#/token/${token.toLowerCase()}`);
  await alice.page.goto(`/#/u/${aliceAccount}`);
  await expect(alice.page.getByTestId("profile-tags")).toContainText("Designer", { timeout: 30_000 });
  await expect(alice.page.getByTestId("profile-points")).toContainText("80");

  // Her profile: what she holds of the launched token, and what her pass cost against what its share is worth now.
  await expect(alice.page.locator(`[data-testid=profile-holding][data-token="${token.toLowerCase()}"]`)).toBeVisible({ timeout: 60_000 });
  const passRow = alice.page.locator(`[data-testid=profile-pass][data-room="${room}"]`);
  await expect(passRow.getByTestId("profile-pass-cost")).toContainText("0.05", { timeout: 60_000 });
  await expect(passRow.getByTestId("profile-pass-value")).toContainText("BNB");

  // ── The dev's own cooks at the top of Cook Rooms, the search, hot and latest, and the wallet menu ───────
  await dev.page.goto("/#/rooms");
  const cooks = dev.page.getByTestId("your-cooks");
  await expect(cooks.locator(`[data-testid=room-card][data-room="${room}"]`)).toBeVisible({ timeout: 30_000 });
  await expect(cooks.locator(`[data-testid=room-card][data-room="${room}"]`).getByTestId("room-card-role")).toHaveAttribute("data-role", "dev");
  const list = dev.page.getByTestId("rooms-list");
  await dev.page.getByTestId("rooms-search").fill(roomName.toLowerCase());
  await expect(list.locator("[data-testid=room-card]")).toHaveCount(1, { timeout: 30_000 });
  await expect(list.locator(`[data-testid=room-card][data-room="${room}"]`)).toBeVisible();
  await dev.page.getByTestId("rooms-search").fill("no room is called this 9z9z");
  await expect(dev.page.getByTestId("rooms-search-empty")).toBeVisible({ timeout: 30_000 });
  await dev.page.getByTestId("rooms-search-empty-clear").click();
  await dev.page.getByTestId("rooms-sort-hot").click();
  // Passes were bought in this room within the day: it is the hottest, and marked so.
  await expect(list.locator("[data-testid=room-card]").first()).toHaveAttribute("data-room", room, { timeout: 30_000 });
  await expect(list.locator("[data-testid=room-card]").first().getByTestId("room-card-hot")).toBeVisible();
  await dev.page.getByTestId("wallet").click();
  await expect(dev.page.getByTestId("positions-cooks").getByTestId("positions-cook").first()).toContainText(roomName, { timeout: 30_000 });

  for (const { errors } of [dev, alice, bob, carol]) expect(errors).toEqual([]);
});
