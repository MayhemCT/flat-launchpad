import { CHAINS, type ChainKey } from '@flat/protocol'
import { handleApi } from './api.js'
import { Budget, syncChain } from './sync.js'

export interface Env {
  DB: D1Database
  ASSETS: Fetcher
  /** Optional private endpoints. Public ones are used when unset. */
  BSC_RPC_URL?: string
  BSC_TESTNET_RPC_URL?: string
  /**
   * RPC requests one cron run may make across all chains. The default fits the
   * Workers Free plan (50 external subrequests per invocation). Raise it on a
   * paid plan to catch up faster.
   */
  SUBREQUEST_BUDGET?: string
}

const DEFAULT_BUDGET = 44
const ORDER: ChainKey[] = ['bsc', 'bscTestnet']

function rpcUrls(env: Env, chain: ChainKey): readonly string[] {
  const override = chain === 'bsc' ? env.BSC_RPC_URL : env.BSC_TESTNET_RPC_URL
  return override ? [override] : CHAINS[chain].rpcUrls
}

async function sync(env: Env): Promise<void> {
  const total = Number(env.SUBREQUEST_BUDGET ?? DEFAULT_BUDGET)
  const perChain = Math.floor((Number.isFinite(total) && total > 0 ? total : DEFAULT_BUDGET) / ORDER.length)
  // Chains sync independently: one failing endpoint must not stall the other.
  const results = await Promise.allSettled(
    ORDER.map((key) => {
      const budget = new Budget(perChain)
      // Leave room for the head read, token links and factory status.
      const maxRanges = Math.max(1, Math.floor(perChain / 2))
      return syncChain(env.DB, CHAINS[key], rpcUrls(env, key), budget, maxRanges)
    }),
  )
  for (const [i, result] of results.entries()) {
    if (result.status === 'fulfilled') console.log(JSON.stringify({ sync: result.value }))
    else console.error(JSON.stringify({ syncFailed: ORDER[i], error: String(result.reason) }))
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/')) return handleApi(request, env.DB)
    return env.ASSETS.fetch(request)
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(sync(env))
  },
} satisfies ExportedHandler<Env>
