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
 * 4. Sends it through the router's fee-on-transfer swap with gas to spare, and follows it to a definite outcome.
 *    A tax token does different amounts of work from one transfer to the next (it sells its collected tax every
 *    so often), and a gas estimate taken a moment earlier can fall short of that: on a fork, a buy sent with the
 *    bare estimate ran out of gas. So each trade carries half as much gas again; what is not used is not paid for.
 *
 * This site adds no fee and never holds funds: the only contracts called are PancakeSwap's router and, for a
 * sell, the token's own `approve` for the exact amount being sold.
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
  type Address,
  type Hex,
} from "viem";
import { bsc } from "viem/chains";
import { SITES } from "./site";

export const PANCAKE_ROUTER: Address = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
export const PANCAKE_FACTORY: Address = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73";
export const WBNB: Address = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
export const USDT: Address = "0x55d398326f99059fF775485246999027B3197955";
const ZERO: Address = "0x0000000000000000000000000000000000000000";
/** How long a signed trade stays valid, in seconds. */
const DEADLINE_SECONDS = 600n;
const BPS = 10_000n;

const routerAbi = parseAbi([
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
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
const client = createPublicClient({ chain: bsc, transport: http(import.meta.env.VITE_BSC_RPC_URL ?? SITES.bsc.rpcUrl), batch: { multicall: true } });

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

export type TradeStep = "pricing" | "approving" | "checking" | "confirm" | "pending";

/** The gas limit a trade is sent with: the estimate, half as much again, and a fixed margin. Unused gas costs nothing. */
const withHeadroom = (estimate: bigint) => (estimate * 3n) / 2n + 60_000n;

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

/** The token and its PancakeSwap pool. Throws NO_POOL when it has none with liquidity. */
export async function loadMarket(token: Address): Promise<Market> {
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
  const pool = candidates.filter((candidate) => candidate.reserveToken > 0n && candidate.reserveQuote > 0n).sort((a, b) => (b.reserveToken > a.reserveToken ? 1 : -1))[0];
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

export interface Quote {
  amountIn: bigint;
  /** What arrives, after the pool's price and the token's tax. */
  amountOut: bigint;
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
  const amounts = await client.readContract({ address: PANCAKE_ROUTER, abi: routerAbi, functionName: "getAmountsOut", args: [bnbIn, market.path] });
  const out = amounts[amounts.length - 1]!;
  const paid = amounts[amounts.length - 2]!;
  return { amountIn: bnbIn, amountOut: afterTax(out, market.buyTaxBps), impactBps: impact(paid, out, market.reserveQuote, market.reserveToken) };
}

/** What selling `tokenIn` returns in BNB right now. The token takes its tax before the pool sees the rest. */
export async function quoteSell(market: Market, tokenIn: bigint): Promise<Quote> {
  const reaches = afterTax(tokenIn, market.sellTaxBps);
  const path = [...market.path].reverse();
  const amounts = await client.readContract({ address: PANCAKE_ROUTER, abi: routerAbi, functionName: "getAmountsOut", args: [reaches, path] });
  return { amountIn: tokenIn, amountOut: amounts[amounts.length - 1]!, impactBps: impact(reaches, amounts[1]!, market.reserveToken, market.reserveQuote) };
}

export async function balances(market: Market, account: Address): Promise<{ bnb: bigint; token: bigint }> {
  const [bnb, token] = await Promise.all([
    client.getBalance({ address: account }),
    client.readContract({ address: market.token, abi: tokenAbi, functionName: "balanceOf", args: [account] }),
  ]);
  return { bnb, token };
}

function wallet() {
  if (!window.ethereum) throw new TradeError("WALLET_MISSING", "No wallet found", "No browser wallet was found. Install MetaMask, Rabby or another wallet, then connect.");
  return createWalletClient({ chain: bsc, transport: custom(window.ethereum) });
}

/** Turns anything thrown along the way into a TradeError that says what happened to the funds. */
function explain(error: unknown, sent: boolean, hash?: Hex): TradeError {
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
    if (/INSUFFICIENT_OUTPUT_AMOUNT/.test(text)) {
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

async function settle(hash: Hex): Promise<Hex> {
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
        const args = [withSlippage(quote.amountOut, slippageBps), market.path, account, await deadline()] as const;
        const { request } = await client.simulateContract({
          account,
          address: PANCAKE_ROUTER,
          abi: routerAbi,
          functionName: "swapExactETHForTokensSupportingFeeOnTransferTokens",
          args,
          value: amountIn,
        });
        const gas = await client.estimateContractGas({
          account,
          address: PANCAKE_ROUTER,
          abi: routerAbi,
          functionName: "swapExactETHForTokensSupportingFeeOnTransferTokens",
          args,
          value: amountIn,
        });
        onStep?.("confirm");
        hash = await signer.writeContract({ ...request, gas: withHeadroom(gas) });
        onStep?.("pending", hash);
        return { hash: await settle(hash), quote };
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

/** Sells for BNB. Approves the router for exactly the amount sold when it is not already allowed. */
export async function sell({ market, account, amountIn, slippageBps, onStep }: TradeRequest): Promise<{ hash: Hex; quote: Quote }> {
  let hash: Hex | undefined;
  try {
    const signer = wallet();
    const allowance = await client.readContract({ address: market.token, abi: tokenAbi, functionName: "allowance", args: [account, PANCAKE_ROUTER] });
    if (allowance < amountIn) {
      onStep?.("approving");
      const { request } = await client.simulateContract({ account, address: market.token, abi: tokenAbi, functionName: "approve", args: [PANCAKE_ROUTER, amountIn] });
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
        const args = [amountIn, withSlippage(quote.amountOut, slippageBps), path, account, await deadline()] as const;
        const { request } = await client.simulateContract({
          account,
          address: PANCAKE_ROUTER,
          abi: routerAbi,
          functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens",
          args,
        });
        const gas = await client.estimateContractGas({
          account,
          address: PANCAKE_ROUTER,
          abi: routerAbi,
          functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens",
          args,
        });
        onStep?.("confirm");
        hash = await signer.writeContract({ ...request, gas: withHeadroom(gas) });
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
