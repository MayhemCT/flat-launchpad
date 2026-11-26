/**
 * Two facts about a token that callouts are weighed by, read from where they are kept: how much of it a wallet
 * holds (the token contract on BNB Chain), and what the market values it at (DexScreener's pair data).
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

/** The token's market cap in whole US dollars right now, or null when DexScreener could not say. Never throws. */
export async function marketCapUsd(token: string, fetcher: typeof fetch = fetch): Promise<number | null> {
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
