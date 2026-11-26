import { CHAINS, type ChainKey } from '@flat/protocol'
import { handleApi } from './api.js'
import { handleCallouts } from './callouts.js'
import { handleChat } from './chat.js'
import { handleImage, handleMeta } from './image.js'
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
  /** The wallet whose signature approves a callout. A public address, not a secret. */
  CALLOUT_ATTESTER?: string
  /** The rewards vault the callout attestations are for. A public address. */
  CALLZ_VAULT?: string
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
    else {
      const chain = ORDER[i]!
      const message = String(result.reason).slice(0, 500)
      console.error(JSON.stringify({ syncFailed: chain, error: message }))
      // Keep the failure where the API can show it. The row may not exist yet if the very first step failed.
      const now = Math.floor(Date.now() / 1000)
      const start = CHAINS[chain].poolLaunch.startBlock
      await env.DB.batch([
        env.DB.prepare(
          'INSERT INTO sync_state (chain, next_block, head, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (chain) DO NOTHING',
        ).bind(chain, start, start, now),
        env.DB.prepare('UPDATE sync_state SET last_error = ?, last_error_at = ? WHERE chain = ?').bind(message, now, chain),
      ]).catch(() => undefined)
    }
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/image/')) return handleImage(request, ctx)
    if (url.pathname.startsWith('/api/meta/')) return handleMeta(request, ctx)
    if (url.pathname.startsWith('/api/chat/')) return handleChat(request, env.DB)
    if (url.pathname.startsWith('/api/callouts/')) return handleCallouts(request, env)
    if (url.pathname.startsWith('/api/')) return handleApi(request, env.DB)
    return env.ASSETS.fetch(request)
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(sync(env))
  },
} satisfies ExportedHandler<Env>
