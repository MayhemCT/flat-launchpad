/**
 * Buying and selling a token through PancakeSwap, straight from the visitor's wallet.
 *
 * Every token Flap's Pool Launch launches on BNB Chain gets a PancakeSwap V2 pool against BNB or USDT, and
 * carries a buy and a sell tax the token itself takes on transfer. So a trade here:
 *
 * 1. Finds the token's pool in PancakeSwap's own factory, and reads the token's taxes from the token.
 * 2. Prices the trade with PancakeSwap's router, then takes the token's tax off, so the minimum the wallet
 *    signs for is what will really arrive.
 * 3. Simulates the exact transaction before the wallet opens. If the price moved in between, it prices and
 *    simulates once more. A trade the chain would reject is never sent.
 * 4. Sends it through the CallZ router with gas to spare, and follows it to a definite outcome. The CallZ router
 *    takes the CallZ trading fee on the BNB side (2%: out of the BNB paid on a buy, out of the BNB received on a
 *    sell), pays it to the CallZ vault, and makes PancakeSwap's fee-on-transfer swap with the rest.
 *    A tax token does different amounts of work from one transfer to the next (it sells its collected tax every
 *    so often), and a gas estimate taken a moment earlier can fall short of that: on a fork, a buy sent with the
 *    bare estimate ran out of gas. So each trade carries half as much gas again; what is not used is not paid for.
 *
 * CallZ never holds funds: the router keeps nothing between transactions, bought tokens go from the pool
 * straight to the buyer, and a sell approves the router for exactly the amount being sold. The fee is shown in
 * every quote before the wallet opens. While the CallZ router is not deployed, trades go to PancakeSwap's router
 * directly and carry no CallZ fee.
 *
 * Addresses were read from the chain on 27 Nov 2026: the router's `factory()` and `WETH()` are the factory
 * and WBNB below.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  custom,
  http,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { bsc } from "viem/chains";
import callz from "./callz-deployment.json";
import { address as firstCallzFactory } from "./pancake-deployment.json";
import { SITES } from "./site";

export const PANCAKE_ROUTER: Address = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
export const PANCAKE_FACTORY: Address = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73";
export const WBNB: Address = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
export const USDT: Address = "0x55d398326f99059fF775485246999027B3197955";
/** CallZ's trade router: takes the trading fee and swaps through PancakeSwap. */
export const CALLZ_ROUTER = callz.router.address as Address;
/** CallZ's vault: where every fee goes and is paid out from. */
export const CALLZ_VAULT = callz.vault.address as Address;
/** CallZ's mint factories, newest first. The first one launched before fees existed; its tokens still list. */
export const CALLZ_FACTORIES: Address[] = [callz.factory.address as Address, firstCallzFactory as Address];
const ZERO: Address = "0x0000000000000000000000000000000000000000";
/** How long a signed trade stays valid, in seconds. */
const DEADLINE_SECONDS = 600n;
const BPS = 10_000n;

const routerAbi = parseAbi([
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
]);
const callzRouterAbi = parseAbi([
  "function feeBps() view returns (uint16)",
  "function buy(address token, address[] path, uint256 minOut, uint256 deadline) payable returns (uint256 tokensOut)",
  "function sell(address token, uint256 amountIn, address[] path, uint256 minBnbOut, uint256 deadline) returns (uint256 bnbOut)",
  "error InsufficientOutput(uint256 out, uint256 minimum)",
  "error InvalidPath()",
  "error ZeroAmount()",
  "error BnbTransferFailed()",
]);
const factoryAbi = parseAbi(["function getPair(address tokenA, address tokenB) view returns (address)"]);
const pairAbi = parseAbi([
  "function token0() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
]);
const tokenAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  // Flap's tax tokens publish their rates in basis points. A token without these has no tax of this kind.
  "function buyTaxRate() view returns (uint256)",
  "function sellTaxRate() view returns (uint256)",
]);

// VITE_BSC_RPC_URL points trading at another endpoint: a private one, or a local fork in the tests.
export const client = createPublicClient({ chain: bsc, transport: http(import.meta.env.VITE_BSC_RPC_URL ?? SITES.bsc.rpcUrl), batch: { multicall: true } });

export interface Market {
  token: Address;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  buyTaxBps: number;
  sellTaxBps: number;
  pair: Address;
  /** What the pool is priced in. A USDT pool is reached from BNB through PancakeSwap's BNB/USDT pool. */
  quote: "BNB" | "USDT";
  /** BNB to the token. A sell runs it backwards. */
  path: Address[];
  reserveToken: bigint;
  reserveQuote: bigint;
}

export type TradeErrorCode =
  | "NO_POOL"
  | "WALLET_MISSING"
  | "WALLET_REJECTED"
  | "WRONG_NETWORK"
  | "INSUFFICIENT_FUNDS"
  | "PRICE_MOVED"
  | "POOL_REJECTED"
  | "NETWORK"
  | "REVERTED"
  | "PENDING";

/** Why a trade did not happen, in words for the person trading, and what became of their funds. */
export class TradeError extends Error {
  constructor(
    readonly code: TradeErrorCode,
    readonly title: string,
    message: string,
    readonly hash?: Hex,
  ) {
    super(message);
    this.name = "TradeError";
  }
}

/** One contract call of a trade: to the CallZ router, or to PancakeSwap's while the CallZ router is not deployed. */
interface RouterCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
}

export type TradeStep = "pricing" | "approving" | "checking" | "confirm" | "pending";

/** The gas limit a trade is sent with: the estimate, half as much again, and a fixed margin. Unused gas costs nothing. */
export const withHeadroom = (estimate: bigint) => (estimate * 3n) / 2n + 60_000n;

const lower = (address: string) => address.toLowerCase();
const afterTax = (amount: bigint, taxBps: number) => (amount * (BPS - BigInt(taxBps))) / BPS;
const withSlippage = (amount: bigint, slippageBps: number) => (amount * (BPS - BigInt(slippageBps))) / BPS;

async function reserves(pair: Address, token: Address): Promise<{ reserveToken: bigint; reserveQuote: bigint }> {
  const [token0, [reserve0, reserve1]] = await Promise.all([
    client.readContract({ address: pair, abi: pairAbi, functionName: "token0" }),
    client.readContract({ address: pair, abi: pairAbi, functionName: "getReserves" }),
  ]);
  return lower(token0) === lower(token) ? { reserveToken: reserve0, reserveQuote: reserve1 } : { reserveToken: reserve1, reserveQuote: reserve0 };
}

/**
 * The token and its PancakeSwap pool. A token can have one against BNB and one against USDT: `prefer` picks
 * between them, and without it the one that holds more of the token is used. Throws NO_POOL when it has none
 * with liquidity.
 */
export async function loadMarket(token: Address, prefer?: "BNB" | "USDT"): Promise<Market> {
  const read = <T,>(functionName: "name" | "symbol" | "decimals" | "totalSupply" | "buyTaxRate" | "sellTaxRate") =>
    client.readContract({ address: token, abi: tokenAbi, functionName }).catch(() => null) as Promise<T | null>;
  const pairOf = (other: Address) => client.readContract({ address: PANCAKE_FACTORY, abi: factoryAbi, functionName: "getPair", args: [token, other] });
  const [name, symbol, decimals, totalSupply, buyTax, sellTax, bnbPair, usdtPair] = await Promise.all([
    read<string>("name"),
    read<string>("symbol"),
    read<number>("decimals"),
    read<bigint>("totalSupply"),
    read<bigint>("buyTaxRate"),
    read<bigint>("sellTaxRate"),
    pairOf(WBNB),
    pairOf(USDT),
  ]);
  if (decimals === null || totalSupply === null) throw new TradeError("NO_POOL", "Not a token", "This address is not a token on BNB Chain.");

  // Where both pools exist, trade in the one that holds more of the token.
  const candidates = await Promise.all(
    ([[bnbPair, "BNB"], [usdtPair, "USDT"]] as const)
      .filter(([pair]) => pair !== ZERO)
      .map(async ([pair, quote]) => ({ pair, quote, ...(await reserves(pair, token)) })),
  );
  const funded = candidates.filter((candidate) => candidate.reserveToken > 0n && candidate.reserveQuote > 0n).sort((a, b) => (b.reserveToken > a.reserveToken ? 1 : -1));
  const pool = funded.find((candidate) => candidate.quote === prefer) ?? funded[0];
  if (!pool) throw new TradeError("NO_POOL", "No pool yet", "This token has no PancakeSwap pool with liquidity yet, so there is nothing to trade against.");

  const tax = (value: bigint | null) => (value !== null && value < BPS ? Number(value) : 0);
  return {
    token,
    name: name ?? "",
    symbol: symbol ?? "",
    decimals,
    totalSupply,
    buyTaxBps: tax(buyTax),
    sellTaxBps: tax(sellTax),
    pair: pool.pair,
    quote: pool.quote,
    path: pool.quote === "BNB" ? [WBNB, token] : [WBNB, USDT, token],
    reserveToken: pool.reserveToken,
    reserveQuote: pool.reserveQuote,
  };
}

export interface TradeFee {
  /** True once the CallZ router is deployed: trades go through it. */
  live: boolean;
  /** The CallZ trading fee, in basis points of the BNB side. */
  bps: number;
}

let feeRead: { at: number; value: Promise<TradeFee> } | null = null;

/**
 * The CallZ trading fee in force, read from the CallZ router and kept for half a minute. Before the router is
 * deployed there is nothing to read: trades then go straight to PancakeSwap, with no CallZ fee.
 */
export function tradeFee(): Promise<TradeFee> {
  if (feeRead && Date.now() - feeRead.at < 30_000) return feeRead.value;
  const value = (async (): Promise<TradeFee> => {
    const code = await client.getCode({ address: CALLZ_ROUTER });
    if (!code || code === "0x") return { live: false, bps: 0 };
    return { live: true, bps: await client.readContract({ address: CALLZ_ROUTER, abi: callzRouterAbi, functionName: "feeBps" }) };
  })();
  feeRead = { at: Date.now(), value };
  // A failed read is not remembered: the next trade asks again.
  value.catch(() => (feeRead = null));
  return value;
}

export interface Quote {
  amountIn: bigint;
  /** What arrives, after the pool's price, the token's tax and the CallZ fee. */
  amountOut: bigint;
  /** The CallZ trading fee on this trade, in BNB, and its rate. Zero while the CallZ router is not deployed. */
  fee: bigint;
  feeBps: number;
  /** How much worse than the pool's current price this trade fills, in basis points, pool fee included. */
  impactBps: number;
}

function impact(paid: bigint, got: bigint, reservePaid: bigint, reserveGot: bigint): number {
  if (paid === 0n || reserveGot === 0n) return 0;
  const filled = (got * reservePaid * BPS) / (paid * reserveGot);
  return Number(filled > BPS ? 0n : BPS - filled);
}

/** What `bnbIn` buys right now. */
export async function quoteBuy(market: Market, bnbIn: bigint): Promise<Quote> {
  const { bps } = await tradeFee();
  // The fee comes out of the BNB first; the rest is what PancakeSwap swaps.
  const fee = (bnbIn * BigInt(bps)) / BPS;
  if (bnbIn - fee === 0n) return { amountIn: bnbIn, amountOut: 0n, fee, feeBps: bps, impactBps: 0 };
  const amounts = await client.readContract({ address: PANCAKE_ROUTER, abi: routerAbi, functionName: "getAmountsOut", args: [bnbIn - fee, market.path] });
  const out = amounts[amounts.length - 1]!;
  const paid = amounts[amounts.length - 2]!;
  return { amountIn: bnbIn, amountOut: afterTax(out, market.buyTaxBps), fee, feeBps: bps, impactBps: impact(paid, out, market.reserveQuote, market.reserveToken) };
}

/** What selling `tokenIn` returns in BNB right now. The token takes its tax before the pool sees the rest. */
export async function quoteSell(market: Market, tokenIn: bigint): Promise<Quote> {
  const reaches = afterTax(tokenIn, market.sellTaxBps);
  const path = [...market.path].reverse();
  const [{ bps }, amounts] = await Promise.all([
    tradeFee(),
    client.readContract({ address: PANCAKE_ROUTER, abi: routerAbi, functionName: "getAmountsOut", args: [reaches, path] }),
  ]);
  // The fee comes out of the BNB the swap returns.
  const gross = amounts[amounts.length - 1]!;
  const fee = (gross * BigInt(bps)) / BPS;
  return { amountIn: tokenIn, amountOut: gross - fee, fee, feeBps: bps, impactBps: impact(reaches, amounts[1]!, market.reserveToken, market.reserveQuote) };
}

export async function balances(market: Market, account: Address): Promise<{ bnb: bigint; token: bigint }> {
  const [bnb, token] = await Promise.all([
    client.getBalance({ address: account }),
    client.readContract({ address: market.token, abi: tokenAbi, functionName: "balanceOf", args: [account] }),
  ]);
  return { bnb, token };
}

const swapEvent = parseAbi([
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
])[0];
/** Blocks per log query, within what the public endpoint serves, and how many queries one load may make. */
const TRADE_SPAN = 5_000n;
const TRADE_QUERIES = 8;

export interface PoolTrade {
  side: "buy" | "sell";
  tokenAmount: bigint;
  /** In the pool's quote asset: BNB or USDT, both with 18 decimals on BNB Chain. */
  quoteAmount: bigint;
  /** Unix seconds, worked out from the block number and the chain's measured block time. */
  time: number;
  hash: Hex;
  logIndex: number;
}

/**
 * The pool's latest trades, newest first, from its own Swap events. With `after` (the head returned by the
 * previous call) only trades since then, in one request; without it, it walks back from the head in spans of
 * 5,000 blocks until it has `want` trades or has looked through eight spans (about five hours).
 */
export async function poolTrades(market: Market, after: bigint | null, want: number): Promise<{ trades: PoolTrade[]; head: bigint }> {
  const head = await client.getBlockNumber();
  const [token0, newest, older] = await Promise.all([
    client.readContract({ address: market.pair, abi: pairAbi, functionName: "token0" }),
    client.getBlock({ blockNumber: head }),
    client.getBlock({ blockNumber: head - 20_000n }),
  ]);
  const tokenIsZero = lower(token0) === lower(market.token);
  // Seconds per block, measured over the last 20,000 blocks: a trade's time follows from its block number.
  const perBlock = Number(newest.timestamp - older.timestamp) / 20_000;
  const timeOf = (block: bigint) => Math.round(Number(newest.timestamp) - Number(head - block) * perBlock);

  const trades: PoolTrade[] = [];
  const read = async (fromBlock: bigint, toBlock: bigint) => {
    const logs = await client.getLogs({ address: market.pair, event: swapEvent, fromBlock, toBlock });
    const batch: PoolTrade[] = [];
    for (const log of logs) {
      const { amount0In, amount1In, amount0Out, amount1Out } = log.args;
      if (amount0In === undefined || amount1In === undefined || amount0Out === undefined || amount1Out === undefined) continue;
      const tokenIn = tokenIsZero ? amount0In : amount1In;
      const tokenOut = tokenIsZero ? amount0Out : amount1Out;
      const quoteIn = tokenIsZero ? amount1In : amount0In;
      const quoteOut = tokenIsZero ? amount1Out : amount0Out;
      // The pool pays the token out on a buy and takes it in on a sell.
      const buy = tokenOut > tokenIn;
      batch.push({
        side: buy ? "buy" : "sell",
        tokenAmount: buy ? tokenOut - tokenIn : tokenIn - tokenOut,
        quoteAmount: buy ? quoteIn - quoteOut : quoteOut - quoteIn,
        time: timeOf(log.blockNumber),
        hash: log.transactionHash,
        logIndex: log.logIndex,
      });
    }
    trades.push(...batch.reverse());
  };

  if (after !== null) {
    if (after < head) await read(after + 1n, head);
    return { trades, head };
  }
  let toBlock = head;
  for (let query = 0; query < TRADE_QUERIES && trades.length < want && toBlock > 0n; query++) {
    const fromBlock = toBlock > TRADE_SPAN ? toBlock - TRADE_SPAN + 1n : 0n;
    await read(fromBlock, toBlock);
    toBlock = fromBlock - 1n;
  }
  return { trades: trades.slice(0, want), head };
}

const BOUGHT_KEY = "callz.bought";

/** Tokens this browser bought through the site, newest first: they show under the wallet's positions. */
export function rememberedTokens(): Address[] {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(BOUGHT_KEY) ?? "[]");
    return Array.isArray(stored) ? stored.filter((value): value is Address => typeof value === "string" && /^0x[0-9a-f]{40}$/.test(value)).slice(0, 60) : [];
  } catch {
    return []; // storage blocked or unreadable: the board's own tokens still show
  }
}

function rememberBought(token: Address) {
  try {
    const address = lower(token) as Address;
    window.localStorage.setItem(BOUGHT_KEY, JSON.stringify([address, ...rememberedTokens().filter((other) => other !== address)].slice(0, 60)));
  } catch {
    // storage blocked: nothing to remember it in
  }
}

const callzFactoryAbi = parseAbi(["function mintCount() view returns (uint256)", "function mints(uint256 index) view returns (address)"]);
const callzMintAbi = parseAbi(["function token() view returns (address)"]);

/**
 * The tokens launched through CallZ's own launchpad on BNB Chain, newest first: read from its factories' lists of
 * mints, so a token shows up the moment its mint launches. A factory that is not deployed yet lists nothing.
 */
export async function callzTokens(): Promise<Address[]> {
  const lists = await Promise.all(CALLZ_FACTORIES.map((factory) => factoryTokens(factory).catch(() => [] as Address[])));
  return [...new Set(lists.flat())];
}

async function factoryTokens(factory: Address): Promise<Address[]> {
  const count = await client.readContract({ address: factory, abi: callzFactoryAbi, functionName: "mintCount" }).catch(() => 0n);
  if (count === 0n) return [];
  const newest = Array.from({ length: Number(count > 100n ? 100n : count) }, (_, index) => count - 1n - BigInt(index));
  const mints = await client.multicall({
    allowFailure: true,
    contracts: newest.map((index) => ({ address: factory, abi: callzFactoryAbi, functionName: "mints" as const, args: [index] as const })),
  });
  const tokens = await client.multicall({
    allowFailure: true,
    contracts: mints.flatMap((mint) => (mint.status === "success" ? [{ address: mint.result as Address, abi: callzMintAbi, functionName: "token" as const }] : [])),
  });
  // A mint that has not launched yet has no token: its `token()` is the zero address.
  return tokens.flatMap((token) => (token.status === "success" && lower(token.result as string) !== ZERO ? [lower(token.result as string) as Address] : []));
}

/** Which of `tokens` the account holds, with each balance. One request for all of them. */
export async function heldTokens(account: Address, tokens: Address[]): Promise<Array<{ token: Address; balance: bigint }>> {
  if (tokens.length === 0) return [];
  const results = await client.multicall({
    contracts: tokens.map((token) => ({ address: token, abi: tokenAbi, functionName: "balanceOf" as const, args: [account] as const })),
    allowFailure: true,
  });
  return tokens.flatMap((token, index) => {
    const result = results[index];
    return result?.status === "success" && typeof result.result === "bigint" && result.result > 0n ? [{ token, balance: result.result }] : [];
  });
}

export function wallet() {
  if (!window.ethereum) throw new TradeError("WALLET_MISSING", "No wallet found", "No browser wallet was found. Install MetaMask, Rabby or another wallet, then connect.");
  return createWalletClient({ chain: bsc, transport: custom(window.ethereum) });
}

/** Turns anything thrown along the way into a TradeError that says what happened to the funds. */
export function explain(error: unknown, sent: boolean, hash?: Hex): TradeError {
  if (error instanceof TradeError) return error;
  const text = error instanceof BaseError ? `${error.shortMessage} ${error.details ?? ""}` : String((error as { message?: string })?.message ?? error);
  const code = (error as { code?: number })?.code ?? ((error as BaseError)?.walk?.() as { code?: number } | undefined)?.code;
  if (code === 4001 || /user (rejected|denied)|rejected the request/i.test(text)) {
    return new TradeError("WALLET_REJECTED", "Cancelled", "You cancelled the request in your wallet. Nothing was sent.");
  }
  if (/chain|network/i.test(text) && /mismatch|does not match|switch/i.test(text)) {
    return new TradeError("WRONG_NETWORK", "Wrong network", "Your wallet is not on BNB Chain. Switch networks and try again. Nothing was sent.");
  }
  if (/insufficient funds|exceeds (the )?balance/i.test(text)) {
    return new TradeError("INSUFFICIENT_FUNDS", "Not enough BNB", "Your balance does not cover this amount plus the network fee. Nothing was sent.");
  }
  if (error instanceof BaseError && error.walk((cause) => cause instanceof ContractFunctionRevertedError)) {
    if (/INSUFFICIENT_OUTPUT_AMOUNT|InsufficientOutput/.test(text)) {
      return new TradeError("PRICE_MOVED", "Price moved", "The price moved past your slippage while the trade was being prepared, or the token takes more than the tax it states. Nothing was sent. Try again, or raise slippage.");
    }
    const reason = /reason:\s*(.{1,80})/i.exec(text)?.[1] ?? /reverted[^:]*:\s*(.{1,80})/i.exec(text)?.[1];
    return new TradeError("POOL_REJECTED", "Trade rejected", `The pool or the token will not accept this trade right now${reason ? ` ("${reason.trim()}")` : ""}. Some tokens restrict buying or selling. Nothing was sent.`);
  }
  return sent
    ? new TradeError("PENDING", "Still confirming", "Your transaction was sent, but its result could not be read yet. Check it on BscScan before trying again.", hash)
    : new TradeError("NETWORK", "Could not reach BNB Chain", "The network did not answer, so the trade could not be checked. Nothing was sent. Try again in a few seconds.");
}

async function deadline(): Promise<bigint> {
  const block = await client.getBlock({ blockTag: "latest" });
  return block.timestamp + DEADLINE_SECONDS;
}

export async function settle(hash: Hex): Promise<Hex> {
  let receipt;
  try {
    receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  } catch (error) {
    throw explain(error, true, hash);
  }
  if (receipt.status !== "success") {
    throw new TradeError("REVERTED", "Trade reverted", "The network rejected the transaction. Only the network fee was spent; the rest of your funds did not move.", hash);
  }
  return hash;
}

export interface TradeRequest {
  market: Market;
  account: Address;
  amountIn: bigint;
  slippageBps: number;
  onStep?(step: TradeStep, hash?: Hex): void;
}

/** Buys with BNB. Resolves with the transaction hash once it has confirmed. */
export async function buy({ market, account, amountIn, slippageBps, onStep }: TradeRequest): Promise<{ hash: Hex; quote: Quote }> {
  let hash: Hex | undefined;
  try {
    const signer = wallet();
    let attempt = 0;
    for (;;) {
      onStep?.("pricing");
      const quote = await quoteBuy(market, amountIn);
      if (quote.amountOut === 0n) throw new TradeError("NO_POOL", "Amount too small", "This amount buys nothing at the current price. Nothing was sent.");
      onStep?.("checking");
      try {
        const minOut = withSlippage(quote.amountOut, slippageBps);
        const until = await deadline();
        // Through the CallZ router once it is deployed; before that, PancakeSwap's router directly.
        const call: RouterCall = (await tradeFee()).live
          ? { address: CALLZ_ROUTER, abi: callzRouterAbi, functionName: "buy", args: [market.token, market.path, minOut, until], value: amountIn }
          : { address: PANCAKE_ROUTER, abi: routerAbi, functionName: "swapExactETHForTokensSupportingFeeOnTransferTokens", args: [minOut, market.path, account, until], value: amountIn };
        await client.simulateContract({ account, ...call });
        const gas = await client.estimateContractGas({ account, ...call });
        onStep?.("confirm");
        hash = await signer.writeContract({ account, chain: bsc, ...call, gas: withHeadroom(gas) });
        onStep?.("pending", hash);
        const settled = await settle(hash);
        rememberBought(market.token);
        return { hash: settled, quote };
      } catch (error) {
        const failure = explain(error, hash !== undefined, hash);
        // The price can move between pricing and checking: price it once more before giving up.
        if (failure.code !== "PRICE_MOVED" || hash !== undefined || attempt++ > 0) throw failure;
      }
    }
  } catch (error) {
    throw explain(error, hash !== undefined, hash);
  }
}

/** Sells for BNB. Approves the router it sells through for exactly the amount sold when it is not already allowed. */
export async function sell({ market, account, amountIn, slippageBps, onStep }: TradeRequest): Promise<{ hash: Hex; quote: Quote }> {
  let hash: Hex | undefined;
  try {
    const signer = wallet();
    const live = (await tradeFee()).live;
    const spender = live ? CALLZ_ROUTER : PANCAKE_ROUTER;
    const allowance = await client.readContract({ address: market.token, abi: tokenAbi, functionName: "allowance", args: [account, spender] });
    if (allowance < amountIn) {
      onStep?.("approving");
      const { request } = await client.simulateContract({ account, address: market.token, abi: tokenAbi, functionName: "approve", args: [spender, amountIn] });
      const approval = await signer.writeContract(request);
      const receipt = await client.waitForTransactionReceipt({ hash: approval, timeout: 120_000 });
      if (receipt.status !== "success") throw new TradeError("REVERTED", "Approval reverted", "The token rejected the approval. Only the network fee was spent.", approval);
    }
    const path = [...market.path].reverse();
    let attempt = 0;
    for (;;) {
      onStep?.("pricing");
      const quote = await quoteSell(market, amountIn);
      if (quote.amountOut === 0n) throw new TradeError("NO_POOL", "Amount too small", "This amount returns nothing at the current price. Nothing was sent.");
      onStep?.("checking");
      try {
        const minOut = withSlippage(quote.amountOut, slippageBps);
        const until = await deadline();
        const call: RouterCall = live
          ? { address: CALLZ_ROUTER, abi: callzRouterAbi, functionName: "sell", args: [market.token, amountIn, path, minOut, until] }
          : { address: PANCAKE_ROUTER, abi: routerAbi, functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens", args: [amountIn, minOut, path, account, until] };
        await client.simulateContract({ account, ...call });
        const gas = await client.estimateContractGas({ account, ...call });
        onStep?.("confirm");
        hash = await signer.writeContract({ account, chain: bsc, ...call, gas: withHeadroom(gas) });
        onStep?.("pending", hash);
        return { hash: await settle(hash), quote };
      } catch (error) {
        const failure = explain(error, hash !== undefined, hash);
        if (failure.code !== "PRICE_MOVED" || hash !== undefined || attempt++ > 0) throw failure;
      }
    }
  } catch (error) {
    throw explain(error, hash !== undefined, hash);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Liquidity: adding to and removing from a token's PancakeSwap pool
// ─────────────────────────────────────────────────────────────────────────────

const liquidityAbi = parseAbi([
  "function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)",
  "function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity)",
  "function removeLiquidityETHSupportingFeeOnTransferTokens(address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) returns (uint256 amountETH)",
  "function removeLiquidity(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB)",
]);
const erc20Abi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export interface PoolPosition {
  /** The pool's reserves now. */
  reserveToken: bigint;
  reserveQuote: bigint;
  /** All LP tokens of the pool, and the account's. */
  lpSupply: bigint;
  lpBalance: bigint;
  /** What the account's LP tokens are worth in the pool right now. */
  tokenShare: bigint;
  quoteShare: bigint;
  /** What the account has to put in: the token, and the pool's quote asset (BNB or USDT). */
  tokenBalance: bigint;
  quoteBalance: bigint;
}

/** The pool as it stands, and the account's part in it. */
export async function poolPosition(market: Market, account: Address | null): Promise<PoolPosition> {
  const holder = account ?? ZERO;
  const [pool, lpSupply, lpBalance, tokenBalance, quoteBalance] = await Promise.all([
    reserves(market.pair, market.token),
    client.readContract({ address: market.pair, abi: erc20Abi, functionName: "totalSupply" }),
    client.readContract({ address: market.pair, abi: erc20Abi, functionName: "balanceOf", args: [holder] }),
    client.readContract({ address: market.token, abi: erc20Abi, functionName: "balanceOf", args: [holder] }),
    account === null
      ? 0n
      : market.quote === "BNB"
        ? client.getBalance({ address: account })
        : client.readContract({ address: USDT, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
  ]);
  const share = (reserve: bigint) => (lpSupply === 0n ? 0n : (reserve * lpBalance) / lpSupply);
  return { ...pool, lpSupply, lpBalance, tokenShare: share(pool.reserveToken), quoteShare: share(pool.reserveQuote), tokenBalance, quoteBalance };
}

/** The tokens that go in beside `quoteIn` of the pool's quote asset, at the pool's current price. */
export function tokensFor(position: Pick<PoolPosition, "reserveToken" | "reserveQuote">, quoteIn: bigint): bigint {
  return position.reserveQuote === 0n ? 0n : (quoteIn * position.reserveToken) / position.reserveQuote;
}

/** Allows `spender` to move exactly `amount` of `asset`, when it is not already allowed. */
async function allow(asset: Address, account: Address, spender: Address, amount: bigint, onStep?: (step: TradeStep, hash?: Hex) => void) {
  const allowance = await client.readContract({ address: asset, abi: erc20Abi, functionName: "allowance", args: [account, spender] });
  if (allowance >= amount) return;
  onStep?.("approving");
  const { request } = await client.simulateContract({ account, address: asset, abi: erc20Abi, functionName: "approve", args: [spender, amount] });
  const approval = await wallet().writeContract(request);
  const receipt = await client.waitForTransactionReceipt({ hash: approval, timeout: 120_000 });
  if (receipt.status !== "success") throw new TradeError("REVERTED", "Approval reverted", "The approval was rejected. Only the network fee was spent.", approval);
}

export interface LiquidityRequest {
  market: Market;
  account: Address;
  /** Adding: the pool's quote asset to put in. Removing: the LP tokens to take out. */
  amount: bigint;
  slippageBps: number;
  onStep?(step: TradeStep, hash?: Hex): void;
}

/**
 * Adds liquidity: `amount` of the pool's quote asset and the matching tokens at the pool's current price,
 * through PancakeSwap's router. Only to a pool that passes `poolChecks`. The LP tokens come to the account. A token that takes a tax on transfers takes
 * it on the tokens going into the pool, so the LP tokens received are that much fewer than the amounts suggest:
 * the transaction is simulated first, and what it really returns is what is reported.
 */
export async function addLiquidity({ market, account, amount, slippageBps, onStep }: LiquidityRequest): Promise<{ hash: Hex; liquidity: bigint }> {
  let hash: Hex | undefined;
  try {
    const signer = wallet();
    onStep?.("pricing");
    // Enforced here, not only on the page: liquidity goes into graduated, burned-LP PancakeSwap pools only.
    const checks = await poolChecks(market);
    if (!checks.ok) throw new TradeError("POOL_REJECTED", "Pool not eligible", `${checks.reason} Nothing was sent.`);
    const position = await poolPosition(market, account);
    const tokens = tokensFor(position, amount);
    if (tokens === 0n) throw new TradeError("NO_POOL", "Amount too small", "This amount is too small to add at the pool's price. Nothing was sent.");
    if (tokens > position.tokenBalance) {
      throw new TradeError("INSUFFICIENT_FUNDS", `Not enough ${market.symbol || "tokens"}`, "Adding liquidity takes both sides of the pool, and this wallet does not hold enough of the token for this amount. Nothing was sent.");
    }
    if (amount > position.quoteBalance) {
      throw new TradeError("INSUFFICIENT_FUNDS", `Not enough ${market.quote}`, `This wallet does not hold enough ${market.quote} for this amount. Nothing was sent.`);
    }

    await allow(market.token, account, PANCAKE_ROUTER, tokens, onStep);
    if (market.quote === "USDT") await allow(USDT, account, PANCAKE_ROUTER, amount, onStep);

    onStep?.("checking");
    const closes = await deadline();
    const tokenMin = withSlippage(tokens, slippageBps);
    const quoteMin = withSlippage(amount, slippageBps);
    let liquidity: bigint;
    if (market.quote === "BNB") {
      const call = {
        account,
        address: PANCAKE_ROUTER,
        abi: liquidityAbi,
        functionName: "addLiquidityETH",
        args: [market.token, tokens, tokenMin, quoteMin, account, closes],
        value: amount,
      } as const;
      liquidity = (await client.simulateContract(call)).result[2];
      const gas = await client.estimateContractGas(call);
      onStep?.("confirm");
      hash = await signer.writeContract({ ...call, gas: withHeadroom(gas) });
    } else {
      const call = {
        account,
        address: PANCAKE_ROUTER,
        abi: liquidityAbi,
        functionName: "addLiquidity",
        args: [market.token, USDT, tokens, amount, tokenMin, quoteMin, account, closes],
      } as const;
      liquidity = (await client.simulateContract(call)).result[2];
      const gas = await client.estimateContractGas(call);
      onStep?.("confirm");
      hash = await signer.writeContract({ ...call, gas: withHeadroom(gas) });
    }
    onStep?.("pending", hash);
    return { hash: await settle(hash), liquidity };
  } catch (error) {
    throw explain(error, hash !== undefined, hash);
  }
}

/** Removes liquidity: burns `amount` LP tokens for their share of the pool, paid to the account as the token and BNB or USDT. */
export async function removeLiquidity({ market, account, amount, slippageBps, onStep }: LiquidityRequest): Promise<{ hash: Hex }> {
  let hash: Hex | undefined;
  try {
    const signer = wallet();
    onStep?.("pricing");
    const position = await poolPosition(market, account);
    if (amount === 0n || amount > position.lpBalance) {
      throw new TradeError("INSUFFICIENT_FUNDS", "Not enough LP tokens", "This wallet does not hold that many LP tokens of this pool. Nothing was sent.");
    }
    const tokenMin = withSlippage((position.reserveToken * amount) / position.lpSupply, slippageBps);
    const quoteMin = withSlippage((position.reserveQuote * amount) / position.lpSupply, slippageBps);

    await allow(market.pair, account, PANCAKE_ROUTER, amount, onStep);
    onStep?.("checking");
    const closes = await deadline();
    if (market.quote === "BNB") {
      // The fee-on-transfer form: it pays out whatever tokens actually arrive after the token's own tax.
      const call = {
        account,
        address: PANCAKE_ROUTER,
        abi: liquidityAbi,
        functionName: "removeLiquidityETHSupportingFeeOnTransferTokens",
        args: [market.token, amount, tokenMin, quoteMin, account, closes],
      } as const;
      await client.simulateContract(call);
      const gas = await client.estimateContractGas(call);
      onStep?.("confirm");
      hash = await signer.writeContract({ ...call, gas: withHeadroom(gas) });
    } else {
      const call = {
        account,
        address: PANCAKE_ROUTER,
        abi: liquidityAbi,
        functionName: "removeLiquidity",
        args: [market.token, USDT, amount, tokenMin, quoteMin, account, closes],
      } as const;
      await client.simulateContract(call);
      const gas = await client.estimateContractGas(call);
      onStep?.("confirm");
      hash = await signer.writeContract({ ...call, gas: withHeadroom(gas) });
    }
    onStep?.("pending", hash);
    return { hash: await settle(hash) };
  } catch (error) {
    throw explain(error, hash !== undefined, hash);
  }
}

export interface PoolSummary {
  token: Address;
  pair: Address;
  quote: "BNB" | "USDT";
  reserveToken: bigint;
  reserveQuote: bigint;
  /** Both sides of the pool in BNB: twice the quote side, with USDT priced through PancakeSwap's BNB/USDT pool. */
  liquidityBnb: bigint;
}

/** The pools of `tokens` as they stand, deepest first. `pair` is the pool address the launch recorded. */
export async function poolSummaries(tokens: Array<{ token: Address; pair: Address; quoteToken: string | null }>): Promise<PoolSummary[]> {
  if (tokens.length === 0) return [];
  const bnbUsdt = await client.readContract({ address: PANCAKE_FACTORY, abi: factoryAbi, functionName: "getPair", args: [WBNB, USDT] });
  const [price, states] = await Promise.all([
    // With BNB as the "token" side: BNB per USDT is reserveToken / reserveQuote.
    reserves(bnbUsdt, WBNB),
    client.multicall({
      allowFailure: true,
      contracts: tokens.flatMap(({ pair }) => [
        { address: pair, abi: pairAbi, functionName: "token0" as const },
        { address: pair, abi: pairAbi, functionName: "getReserves" as const },
      ]),
    }),
  ]);
  const summaries: PoolSummary[] = [];
  tokens.forEach(({ token, pair, quoteToken }, index) => {
    const token0 = states[index * 2];
    const pool = states[index * 2 + 1];
    if (token0?.status !== "success" || pool?.status !== "success") return;
    const [reserve0, reserve1] = pool.result as readonly [bigint, bigint, number];
    const tokenIsZero = lower(token0.result as string) === lower(token);
    const reserveToken = tokenIsZero ? reserve0 : reserve1;
    const reserveQuote = tokenIsZero ? reserve1 : reserve0;
    const quote = quoteToken && lower(quoteToken) === lower(USDT) ? "USDT" : "BNB";
    const quoteInBnb = quote === "BNB" ? reserveQuote : price.reserveQuote === 0n ? 0n : (reserveQuote * price.reserveToken) / price.reserveQuote;
    summaries.push({ token, pair, quote, reserveToken, reserveQuote, liquidityBnb: quoteInBnb * 2n });
  });
  return summaries.sort((a, b) => (b.liquidityBnb > a.liquidityBnb ? 1 : -1));
}

// ─────────────────────────────────────────────────────────────────────────────
// Which pools liquidity may be added to
// ─────────────────────────────────────────────────────────────────────────────

const DEAD: Address = "0x000000000000000000000000000000000000dEaD";
/** The least share of a launch pool's LP that must be burned before this site adds liquidity to it. In basis points. */
const MIN_BURNED_BPS = 9000;
/** A major pool must hold at least this much on its quote side, counted in BNB, to be taken as established. */
const MIN_MAJOR_QUOTE_BNB = 50n * 10n ** 18n;
const pairFactoryAbi = parseAbi(["function factory() view returns (address)"]);

/**
 * The major assets: the ones on PancakeSwap's own Default token list for BNB Chain
 * (tokens.pancakeswap.finance/pancakeswap-default.json, read on 27 Nov 2026), by lowercase address.
 * BNB itself is the other side of most of their pools. BUSD is on that list too, but is being wound down.
 */
export const MAJOR_ASSETS: Readonly<Record<string, string>> = {
  "0x55d398326f99059ff775485246999027b3197955": "USDT",
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": "USDC",
  "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82": "CAKE",
  "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c": "BTCB",
  "0x2170ed0880ac9a755fd29b2688956bd959f933f8": "ETH",
};

/** The major pools this site lists: each major asset against BNB, and USDC against USDT. */
const MAJOR_POOLS: ReadonlyArray<{ token: Address; quote: "BNB" | "USDT" }> = [
  { token: "0x55d398326f99059fF775485246999027B3197955", quote: "BNB" },
  { token: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", quote: "BNB" },
  { token: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", quote: "USDT" },
  { token: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82", quote: "BNB" },
  { token: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", quote: "BNB" },
  { token: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", quote: "BNB" },
];

/** The major pools as they stand, deepest first, each with its asset's symbol. */
export async function majorPools(): Promise<Array<PoolSummary & { symbol: string }>> {
  const pairs = await client.multicall({
    allowFailure: false,
    contracts: MAJOR_POOLS.map(({ token, quote }) => ({ address: PANCAKE_FACTORY, abi: factoryAbi, functionName: "getPair" as const, args: [token, quote === "BNB" ? WBNB : USDT] as const })),
  });
  const listed = MAJOR_POOLS.flatMap(({ token, quote }, index) => (pairs[index] === ZERO ? [] : [{ token, pair: pairs[index] as Address, quoteToken: quote === "USDT" ? USDT : null }]));
  return (await poolSummaries(listed)).map((pool) => ({ ...pool, symbol: MAJOR_ASSETS[lower(pool.token)] ?? "" }));
}

export interface PoolCheck {
  label: string;
  ok: boolean;
}

export interface PoolChecks {
  /** A pool from a Pool Launch graduation, a pool between major assets, or neither. */
  kind: "flap" | "major";
  items: PoolCheck[];
  /** Every check passed. */
  ok: boolean;
  /** Why not, in plain words: the first failed check. Null when `ok`. */
  reason: string | null;
}

/**
 * Whether this site will add liquidity to `market`'s pool. Only to a pool that cannot be a trap, of two kinds.
 *
 * A pool between major assets (PancakeSwap's own default token list, and BNB):
 *  - it is the pair PancakeSwap's own factory holds for the two;
 *  - it holds liquidity, at least 50 BNB's worth on its quote side.
 *
 * A pool of a token that graduated on Flap's Pool Launch:
 *  - the token graduated, by this site's index of the Portal's own events, not by the page's address bar;
 *  - the pool is the pair PancakeSwap's own factory created for it, the same one the launch recorded;
 *  - it holds liquidity now;
 *  - at least 90% of its LP tokens are burned, so the liquidity that prices the token cannot be withdrawn.
 *
 * Checked on 27 Nov 2026: every graduated Pool Launch pool on BNB Chain passes, with 99.85% to 100% of its LP
 * at the burn address. Any other pool is refused. Taking your own liquidity out is never blocked by any of this.
 */
export async function poolChecks(market: Market): Promise<PoolChecks> {
  const quoteAsset = market.quote === "BNB" ? WBNB : USDT;
  const [pairOwner, factoryPair, pool] = await Promise.all([
    client.readContract({ address: market.pair, abi: pairFactoryAbi, functionName: "factory" }).catch(() => ZERO),
    client.readContract({ address: PANCAKE_FACTORY, abi: factoryAbi, functionName: "getPair", args: [market.token, quoteAsset] }),
    reserves(market.pair, market.token),
  ]);
  const official = lower(pairOwner) === lower(PANCAKE_FACTORY) && lower(factoryPair) === lower(market.pair);
  const funded = pool.reserveToken > 0n && pool.reserveQuote > 0n;
  const finish = (kind: PoolChecks["kind"], checks: Array<PoolCheck & { why: string }>): PoolChecks => {
    const failed = checks.find((check) => !check.ok);
    return { kind, items: checks.map(({ label, ok }) => ({ label, ok })), ok: !failed, reason: failed?.why ?? null };
  };

  if (MAJOR_ASSETS[lower(market.token)]) {
    // The quote side in BNB: a USDT side is priced through PancakeSwap's BNB/USDT pool.
    let quoteInBnb = pool.reserveQuote;
    if (market.quote === "USDT") {
      const bnbUsdt = await client.readContract({ address: PANCAKE_FACTORY, abi: factoryAbi, functionName: "getPair", args: [WBNB, USDT] });
      const price = await reserves(bnbUsdt, WBNB);
      quoteInBnb = price.reserveQuote === 0n ? 0n : (pool.reserveQuote * price.reserveToken) / price.reserveQuote;
    }
    const deep = quoteInBnb >= MIN_MAJOR_QUOTE_BNB;
    return finish("major", [
      { label: "Both assets are on PancakeSwap's own default token list", ok: true, why: "" },
      { label: "PancakeSwap's own pool for this pair", ok: official, why: "This is not the pool PancakeSwap's factory holds for this pair." },
      { label: "Holds liquidity now", ok: funded, why: "This pool holds no liquidity." },
      {
        label: `Established: ${(quoteInBnb / 10n ** 18n).toLocaleString("en")} BNB's worth on its quote side (at least 50 needed)`,
        ok: deep,
        why: "This pool is too shallow to count as an established one: under 50 BNB's worth on its quote side.",
      },
    ]);
  }

  const [indexed, lpSupply, atDead, atZero] = await Promise.all([
    fetch(`/api/bsc/tokens?address=${lower(market.token)}`)
      .then((response) => (response.ok ? (response.json() as Promise<{ items: Array<{ graduated: boolean; pool: string | null }> }>) : null))
      .catch(() => null),
    client.readContract({ address: market.pair, abi: erc20Abi, functionName: "totalSupply" }),
    client.readContract({ address: market.pair, abi: erc20Abi, functionName: "balanceOf", args: [DEAD] }),
    client.readContract({ address: market.pair, abi: erc20Abi, functionName: "balanceOf", args: [ZERO] }),
  ]);
  const row = indexed?.items[0] ?? null;
  const recorded = typeof row?.pool === "string" && lower(row.pool) === lower(market.pair);
  const burnedBps = lpSupply === 0n ? 0 : Number(((atDead + atZero) * BPS) / lpSupply);
  return finish("flap", [
    {
      label: "Graduated on Flap's Pool Launch",
      ok: row?.graduated === true,
      why:
        indexed === null
          ? "This site's index could not be reached to confirm the token graduated on Flap."
          : "This token is not a major asset and has not graduated on Flap's Pool Launch. Liquidity can only be added to graduated pools and to pools between major assets.",
    },
    { label: "PancakeSwap's own pool for this token, the one its launch recorded", ok: official && recorded, why: "This is not the PancakeSwap pool the token's launch recorded." },
    { label: "Holds liquidity now", ok: funded, why: "This pool holds no liquidity." },
    {
      label: `${(burnedBps / 100).toFixed(2)}% of its LP is burned (at least 90% needed), so it cannot be pulled`,
      ok: burnedBps >= MIN_BURNED_BPS,
      why: `Only ${(burnedBps / 100).toFixed(1)}% of this pool's LP is burned, so most of its liquidity could be withdrawn. At least 90% must be burned.`,
    },
  ]);
}
