/**
 * Two facts about a token that callouts are weighed by, read from where they are kept: how much of it a wallet
 * holds (the token contract on BNB Chain), and what the market values it at (DexScreener's pair data, or the
 * token's own PancakeSwap pool where DexScreener has not listed it yet).
 *
 * Nothing here guesses. A reading that cannot be made is reported as such (an exception for the chain, null
 * for the market cap), and the caller refuses or waits rather than store a number that was never read.
 */
import { CHAINS, createRpc, type Rpc } from '@flat/protocol'
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'

export interface MarketEnv {
  /** Optional private BNB Chain endpoint. Public ones are used when unset. */
  BSC_RPC_URL?: string
}

/** Multicall3: the same address on every chain it is deployed to. */
const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11'
const RPC_TIMEOUT_MS = 8000
const DEXSCREENER = 'https://api.dexscreener.com/token-pairs/v1/bsc'
const DEXSCREENER_TIMEOUT_MS = 8000
const DEXSCREENER_MAX_BYTES = 2_097_152

const multicallAbi = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
])
const erc20Abi = parseAbi(['function balanceOf(address account) view returns (uint256)'])

/** A JSON-RPC client for BNB Chain mainnet: one retry, on the next endpoint when there is one. */
export function bscRpc(env: MarketEnv, fetcher: typeof fetch = fetch): Rpc {
  return createRpc(env.BSC_RPC_URL ? [env.BSC_RPC_URL] : CHAINS.bsc.rpcUrls, { retries: 1, timeoutMs: RPC_TIMEOUT_MS, fetch: fetcher })
}

const balanceCall = (holder: string): Hex =>
  encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [holder.toLowerCase() as Address] })

/** A `balanceOf` result: one 32-byte word. Null for anything else, such as the empty answer of an address that is no contract. */
const word = (data: Hex | null | undefined): bigint | null => (typeof data === 'string' && /^0x[0-9a-fA-F]{64}$/.test(data) ? BigInt(data) : null)

/**
 * `holder`'s balance of `token`, in the token's base units. Throws when the chain could not be read or the
 * address did not answer as a token does: an unread balance is never a balance of zero.
 */
export async function balanceOf(rpc: Rpc, token: string, holder: string): Promise<bigint> {
  const balance = word(await rpc<Hex>('eth_call', [{ to: token.toLowerCase(), data: balanceCall(holder) }, 'latest']))
  if (balance === null) throw new Error('balanceOf returned no value')
  return balance
}

/**
 * Each holder's balance of each token, in one `eth_call` through Multicall3. A read that reverts or returns
 * nothing is null. Throws when the request itself fails.
 */
export async function balancesOf(rpc: Rpc, positions: ReadonlyArray<{ token: string; holder: string }>): Promise<Array<bigint | null>> {
  if (positions.length === 0) return []
  const data = encodeFunctionData({
    abi: multicallAbi,
    functionName: 'aggregate3',
    args: [positions.map(({ token, holder }) => ({ target: token.toLowerCase() as Address, allowFailure: true, callData: balanceCall(holder) }))],
  })
  const raw = await rpc<Hex>('eth_call', [{ to: MULTICALL3, data }, 'latest'])
  const results = decodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', data: raw })
  if (results.length !== positions.length) throw new Error('Multicall3 returned a different number of results')
  return results.map((result) => (result.success ? word(result.returnData) : null))
}

/**
 * True when a position counts as closed: the wallet holds less than a tenth of what it held at the call.
 * Whole-number maths on base units, so no balance is too large for it.
 */
export function positionClosed(callBalance: bigint, heldBalance: bigint): boolean {
  return heldBalance * 10n < callBalance
}

const positive = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null)

/**
 * A token's market cap in whole US dollars, from DexScreener's answer for it: the pair with the most
 * liquidity in which the token is the one being priced, and that pair's market cap (its fully diluted value
 * where no market cap is given). Null when the answer holds no such figure above zero.
 *
 * The answer lists every pair the token is in, including ones where it is only what another token is priced
 * in. Those carry the other token's market cap, so they are left out.
 */
export function pickMarketCap(payload: unknown, token: string): number | null {
  if (!Array.isArray(payload)) return null
  const wanted = token.toLowerCase()
  let best: { liquidity: number; value: number } | null = null
  for (const pair of payload as unknown[]) {
    if (typeof pair !== 'object' || pair === null) continue
    const { chainId, baseToken, liquidity, marketCap, fdv } = pair as Record<string, unknown>
    if (chainId !== 'bsc') continue
    const base = (baseToken as { address?: unknown } | null | undefined)?.address
    if (typeof base !== 'string' || base.toLowerCase() !== wanted) continue
    const value = positive(marketCap) ?? positive(fdv)
    if (value === null) continue
    const depth = positive((liquidity as { usd?: unknown } | null | undefined)?.usd) ?? 0
    if (best === null || depth > best.liquidity) best = { liquidity: depth, value }
  }
  if (best === null) return null
  const dollars = Math.round(best.value)
  return Number.isSafeInteger(dollars) && dollars > 0 ? dollars : null
}

/** PancakeSwap V2 on BNB Chain, and the two assets its pools are priced in. Both have 18 decimals. */
const PANCAKE_FACTORY: Address = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73'
const WBNB: Address = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const USDT: Address = '0x55d398326f99059fF775485246999027B3197955'
const ZERO = '0x0000000000000000000000000000000000000000'
const poolAbi = parseAbi([
  'function getPair(address tokenA, address tokenB) view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function totalSupply() view returns (uint256)',
])

type PoolCall = { target: Address; functionName: 'getPair' | 'getReserves' | 'token0' | 'totalSupply'; args?: readonly [Address, Address] }

/** Several reads in one `eth_call` through Multicall3. A read that reverts is null. */
async function readPools(rpc: Rpc, calls: PoolCall[]): Promise<Array<Hex | null>> {
  const data = encodeFunctionData({
    abi: multicallAbi,
    functionName: 'aggregate3',
    args: [calls.map((call) => ({ target: call.target, allowFailure: true, callData: encodeFunctionData({ abi: poolAbi, functionName: call.functionName, args: call.args } as never) }))],
  })
  const raw = await rpc<Hex>('eth_call', [{ to: MULTICALL3, data }, 'latest'])
  const results = decodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', data: raw })
  return results.map((result) => (result.success && result.returnData.length > 2 ? result.returnData : null))
}

const addressOf = (data: Hex | null): Address | null => (data && data.length >= 66 ? (`0x${data.slice(-40)}`.toLowerCase() as Address) : null)

/** A pair's reserves as [of `token`, of the other asset]. Null when the pair could not be read or is empty. */
function sides(token0: Hex | null, reserves: Hex | null, token: string): [bigint, bigint] | null {
  const first = addressOf(token0)
  if (!first || !reserves || reserves.length < 2 + 128) return null
  const reserve0 = BigInt(`0x${reserves.slice(2, 66)}`)
  const reserve1 = BigInt(`0x${reserves.slice(66, 130)}`)
  if (reserve0 === 0n || reserve1 === 0n) return null
  return first === token.toLowerCase() ? [reserve0, reserve1] : [reserve1, reserve0]
}

/**
 * A market cap in whole US dollars worked out from pool reserves: the supply, priced by the token's pool
 * (`tokenReserve` of the token against `quoteReserve` of BNB or USDT), with BNB priced by PancakeSwap's own
 * BNB/USDT pool. Whole-number maths throughout. Null when it does not come to a whole dollar.
 */
export function marketCapFromReserves(supply: bigint, tokenReserve: bigint, quoteReserve: bigint, bnb: { wbnb: bigint; usdt: bigint } | null): number | null {
  if (supply <= 0n || tokenReserve <= 0n || quoteReserve <= 0n) return null
  // Supply and the token's reserve are in the same units, so the token's decimals cancel out.
  let value = (supply * quoteReserve) / tokenReserve
  if (bnb) {
    if (bnb.wbnb <= 0n || bnb.usdt <= 0n) return null
    value = (value * bnb.usdt) / bnb.wbnb
  }
  const dollars = value / 10n ** 18n
  return dollars > 0n && dollars <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(dollars) : null
}

/**
 * The token's market cap in whole US dollars read from PancakeSwap itself: its own pool against BNB or USDT
 * (the one holding more of the token when it has both). For a token too new or too small for DexScreener to
 * list. Null when the token has no funded PancakeSwap pool. Never throws.
 */
export async function poolMarketCapUsd(rpc: Rpc, token: string): Promise<number | null> {
  try {
    const address = token.toLowerCase() as Address
    const [bnbPairRaw, usdtPairRaw, bnbUsdtRaw, supplyRaw] = await readPools(rpc, [
      { target: PANCAKE_FACTORY, functionName: 'getPair', args: [address, WBNB] },
      { target: PANCAKE_FACTORY, functionName: 'getPair', args: [address, USDT] },
      { target: PANCAKE_FACTORY, functionName: 'getPair', args: [WBNB, USDT] },
      { target: address, functionName: 'totalSupply' },
    ])
    const supply = word(supplyRaw)
    const bnbPair = addressOf(bnbPairRaw ?? null)
    const usdtPair = addressOf(usdtPairRaw ?? null)
    const bnbUsdt = addressOf(bnbUsdtRaw ?? null)
    if (supply === null || !bnbUsdt || bnbUsdt === ZERO) return null

    const pairs = [bnbPair, usdtPair, bnbUsdt].map((pair) => (pair && pair !== ZERO ? pair : null))
    const reads = await readPools(
      rpc,
      pairs.flatMap((pair) => (pair ? [{ target: pair, functionName: 'token0' as const }, { target: pair, functionName: 'getReserves' as const }] : [])),
    )
    let next = 0
    const take = (pair: Address | null, of: string) => (pair ? sides(reads[next++] ?? null, reads[next++] ?? null, of) : null)
    const againstBnb = take(pairs[0] ?? null, address)
    const againstUsdt = take(pairs[1] ?? null, address)
    const bnbPrice = take(pairs[2] ?? null, WBNB)
    if (againstUsdt && (!againstBnb || againstUsdt[0] > againstBnb[0])) return marketCapFromReserves(supply, againstUsdt[0], againstUsdt[1], null)
    if (againstBnb && bnbPrice) return marketCapFromReserves(supply, againstBnb[0], againstBnb[1], { wbnb: bnbPrice[0], usdt: bnbPrice[1] })
    return null
  } catch {
    return null
  }
}

/**
 * The token's market cap in whole US dollars right now: DexScreener's figure, and where DexScreener has none
 * (a token it has not listed yet) the one read from the token's PancakeSwap pool when `rpc` is given. Null when
 * neither could say. Never throws.
 */
export async function marketCapUsd(token: string, fetcher: typeof fetch = fetch, rpc?: Rpc): Promise<number | null> {
  const listed = await dexScreenerMarketCapUsd(token, fetcher)
  if (listed !== null || !rpc) return listed
  return poolMarketCapUsd(rpc, token)
}

async function dexScreenerMarketCapUsd(token: string, fetcher: typeof fetch): Promise<number | null> {
  try {
    const response = await fetcher(`${DEXSCREENER}/${token.toLowerCase()}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(DEXSCREENER_TIMEOUT_MS),
    })
    if (!response.ok) {
      await response.body?.cancel()
      return null
    }
    const text = await response.text()
    if (text.length > DEXSCREENER_MAX_BYTES) return null
    return pickMarketCap(JSON.parse(text), token)
  } catch {
    return null
  }
}
