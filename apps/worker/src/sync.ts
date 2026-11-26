import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from 'viem'
import {
  createRpc,
  decodePortalLog,
  compareEvents,
  getHead,
  getTransactionTo,
  portalReadsAbi,
  type ChainConfig,
  type PortalEvent,
  type RawLog,
  type Rpc,
} from '@flat/protocol'
import { refreshRaises, resolveImages } from './enrich.js'
import {
  checkpointStatement,
  ensureSyncStatement,
  eventStatements,
  factoryStatusStatement,
  linkStatement,
  type Statement,
} from './statements.js'

/** Blocks to stay behind the head, so a reorg cannot undo what was indexed. */
const CONFIRMATIONS = 20
/** A factory's enabled flag is re-read from the Portal this often. */
const FACTORY_STATUS_TTL_SECONDS = 3600
/**
 * Largest block span per log query from the Worker. The Worker only follows the head (history is loaded by
 * scripts/backfill-d1.ts), and public endpoints time out on wide queries from Cloudflare's network.
 */
const MAX_LOG_SPAN = 2000

/**
 * Counts outbound requests. A Worker invocation has a hard subrequest limit
 * (50 on the Free plan), so every RPC call draws from one shared budget and the
 * sync stops cleanly when it runs out. The next cron tick continues from the
 * checkpoint.
 */
export class Budget {
  constructor(public remaining: number) {}

  take(count = 1): boolean {
    if (this.remaining < count) return false
    this.remaining -= count
    return true
  }
}

export class BudgetExhausted extends Error {
  constructor() {
    super('subrequest budget exhausted')
    this.name = 'BudgetExhausted'
  }
}

/** An RPC client whose every HTTP request, retries included, is charged to the budget. */
export function budgetedRpc(urls: readonly string[], budget: Budget): Rpc {
  return createRpc(urls, {
    retries: 1,
    timeoutMs: 15_000,
    fetch: (input, init) => {
      if (!budget.take()) throw new BudgetExhausted()
      return fetch(input, init)
    },
  })
}

const hex = (n: number): Hex => `0x${n.toString(16)}`

function bind(db: D1Database, statement: Statement): D1PreparedStatement {
  return db.prepare(statement.sql).bind(...statement.params)
}

export interface SyncResult {
  chain: string
  fromBlock: number
  nextBlock: number
  head: number
  events: number
  linked: number
  factoriesChecked: number
  raisesUpdated: number
  imagesResolved: number
  /** Why raise progress or pictures could not be read this run, when they could not. */
  enrichError: string | null
  caughtUp: boolean
}

/**
 * One sync step for one chain: scan new blocks, write their events, link new
 * tokens to their Launchers, refresh factory status, then read raise progress
 * and token pictures. Each part commits on its own, so running out of budget
 * part-way loses nothing.
 */
export async function syncChain(
  db: D1Database,
  chain: ChainConfig,
  rpcUrls: readonly string[],
  budget: Budget,
  maxRanges: number,
): Promise<SyncResult> {
  const rpc = budgetedRpc(rpcUrls, budget)
  const now = Math.floor(Date.now() / 1000)
  const key = chain.key

  await bind(db, ensureSyncStatement(key, chain.poolLaunch.startBlock, now)).run()
  const row = await db
    .prepare('SELECT next_block FROM sync_state WHERE chain = ?')
    .bind(key)
    .first<{ next_block: number }>()
  const fromBlock = row?.next_block ?? chain.poolLaunch.startBlock

  const head = await getHead(rpc)
  const safeHead = head - CONFIRMATIONS

  // 1. Scan. Stop early rather than start a range the budget cannot finish.
  const events: PortalEvent[] = []
  let nextBlock = fromBlock
  for (let i = 0; i < maxRanges && nextBlock <= safeHead && budget.remaining >= 2; i++) {
    const toBlock = Math.min(nextBlock + Math.min(chain.logRange, MAX_LOG_SPAN) - 1, safeHead)
    let logs: RawLog[]
    try {
      logs = await rpc<RawLog[]>('eth_getLogs', [
        { address: chain.poolLaunch.portal, fromBlock: hex(nextBlock), toBlock: hex(toBlock) },
      ])
    } catch (error) {
      if (error instanceof BudgetExhausted) break
      throw error
    }
    for (const log of logs) {
      const event = decodePortalLog(log)
      if (event) events.push(event)
    }
    nextBlock = toBlock + 1
  }
  events.sort(compareEvents)

  const statements = events.flatMap((event) => eventStatements(key, event))
  statements.push(checkpointStatement(key, nextBlock, head, now))
  await db.batch(statements.map((statement) => bind(db, statement)))

  // 2. Link tokens to Launchers through the launch transaction's recipient.
  const linked = await linkPendingTokens(db, chain, rpc, budget)

  // 3. The Portal is the authority on whether a factory is enabled.
  const factoriesChecked = await refreshFactoryStatus(db, chain, rpc, budget, now)

  // 4. How far each open raise has come, and where each token's picture is. These are read again on every
  //    run, so one that fails (a fallback endpoint that refuses the request, a slow gateway) is reported in
  //    the result and left for the next run. It must not mark the event index, already committed, as failed.
  let raisesUpdated = 0
  let imagesResolved = 0
  let enrichError: string | null = null
  try {
    raisesUpdated = await refreshRaises(db, chain, rpc, budget, now)
  } catch (error) {
    enrichError = String(error).slice(0, 200)
  }
  try {
    imagesResolved = await resolveImages(db, chain, budget, now)
  } catch (error) {
    enrichError ??= String(error).slice(0, 200)
  }

  return {
    chain: key,
    fromBlock,
    nextBlock,
    head,
    events: events.length,
    linked,
    factoriesChecked,
    raisesUpdated,
    imagesResolved,
    enrichError,
    caughtUp: nextBlock > safeHead,
  }
}

async function linkPendingTokens(db: D1Database, chain: ChainConfig, rpc: Rpc, budget: Budget): Promise<number> {
  if (budget.remaining < 1) return 0
  const pending = await db
    .prepare('SELECT address, tx_hash FROM tokens WHERE chain = ? AND launcher_checked = 0 ORDER BY block_number LIMIT ?')
    .bind(chain.key, budget.remaining)
    .all<{ address: string; tx_hash: string }>()

  const statements: Statement[] = []
  for (const token of pending.results) {
    if (budget.remaining < 1) break
    try {
      const to = await getTransactionTo(rpc, token.tx_hash as Hex)
      statements.push(linkStatement(chain.key, token.address, to))
    } catch (error) {
      if (error instanceof BudgetExhausted) break
      throw error
    }
  }
  if (statements.length > 0) await db.batch(statements.map((statement) => bind(db, statement)))
  return statements.length
}

async function refreshFactoryStatus(
  db: D1Database,
  chain: ChainConfig,
  rpc: Rpc,
  budget: Budget,
  now: number,
): Promise<number> {
  if (budget.remaining < 1) return 0
  const stale = await db
    .prepare(
      `SELECT address FROM launcher_factories
WHERE chain = ? AND (status_checked_at IS NULL OR status_checked_at < ?)
ORDER BY status_checked_at IS NOT NULL, status_checked_at LIMIT ?`,
    )
    .bind(chain.key, now - FACTORY_STATUS_TTL_SECONDS, budget.remaining)
    .all<{ address: string }>()

  const statements: Statement[] = []
  for (const factory of stale.results) {
    if (budget.remaining < 1) break
    try {
      const data = encodeFunctionData({
        abi: portalReadsAbi,
        functionName: 'launcherFactoryMultiplier',
        args: [factory.address as Address],
      })
      const result = await rpc<Hex>('eth_call', [{ to: chain.poolLaunch.portal, data }, 'latest'])
      const [enabled, multiplierBps] = decodeFunctionResult({
        abi: portalReadsAbi,
        functionName: 'launcherFactoryMultiplier',
        data: result,
      })
      statements.push(factoryStatusStatement(chain.key, factory.address, enabled, multiplierBps, now))
    } catch (error) {
      if (error instanceof BudgetExhausted) break
      throw error
    }
  }
  if (statements.length > 0) await db.batch(statements.map((statement) => bind(db, statement)))
  return statements.length
}
