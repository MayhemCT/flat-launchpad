/**
 * Writes the full Pool Launch history as SQL for the indexer's D1 database.
 *
 * The live Worker follows new blocks. History is loaded with this script instead, from a machine whose RPC
 * endpoint serves the whole log range: public endpoints answer large history queries unreliably from
 * Cloudflare's network. The statements are the same ones the Worker runs, and they are idempotent.
 *
 * A public endpoint can answer a history query with fewer logs than exist, without an error. Running this again
 * is safe and only adds what an earlier run missed.
 *
 *   npx tsx scripts/backfill-d1.ts > backfill.sql
 *   npx wrangler d1 execute raidpass-index --remote --file backfill.sql --config apps/web/wrangler.jsonc
 */
import { decodeFunctionResult, encodeFunctionData, type Hex } from 'viem'
import {
  CHAINS,
  createRpc,
  getHead,
  getTransactionTo,
  portalReadsAbi,
  scanPortalEvents,
  type ChainConfig,
  type ChainKey,
} from '@flat/protocol'
import {
  checkpointStatement,
  ensureSyncStatement,
  eventStatements,
  factoryStatusStatement,
  linkStatement,
  type Statement,
} from '../apps/worker/src/statements.js'

const CONFIRMATIONS = 20
const RPC_ENV: Record<ChainKey, string> = { bsc: 'BSC_RPC_URL', bscTestnet: 'BSC_TESTNET_RPC_URL' }

function literal(value: string | number | null): string {
  if (value === null) return 'NULL'
  if (typeof value === 'number') return String(value)
  return `'${value.replaceAll("'", "''")}'`
}

/** Inlines a statement's parameters. The templates contain no `?` other than placeholders. */
function inline(statement: Statement): string {
  let index = 0
  const sql = statement.sql.replace(/\?/g, () => literal(statement.params[index++] ?? null))
  if (index !== statement.params.length) throw new Error(`parameter count mismatch in: ${statement.sql}`)
  return `${sql.replace(/\s+/g, ' ').trim()};`
}

async function backfill(chain: ChainConfig): Promise<string[]> {
  const override = process.env[RPC_ENV[chain.key]]
  const rpc = createRpc(override ? [override] : chain.rpcUrls)
  const now = Math.floor(Date.now() / 1000)
  const head = await getHead(rpc)
  const safeHead = head - CONFIRMATIONS

  const events = await scanPortalEvents(rpc, chain, { fromBlock: chain.poolLaunch.startBlock, toBlock: safeHead })
  const statements: Statement[] = [ensureSyncStatement(chain.key, chain.poolLaunch.startBlock, now)]
  for (const event of events) statements.push(...eventStatements(chain.key, event))

  const factories = new Set<string>()
  for (const event of events) {
    if (event.type === 'DirectLaunched') {
      statements.push(linkStatement(chain.key, event.token, await getTransactionTo(rpc, event.txHash)))
    }
    if (event.type === 'LauncherCreated') factories.add(event.launcherFactory.toLowerCase())
    if (event.type === 'LauncherFactoryMultiplierSet') factories.add(event.factory.toLowerCase())
  }
  // The Portal is the authority on whether a factory is enabled right now.
  for (const factory of factories) {
    const data = encodeFunctionData({ abi: portalReadsAbi, functionName: 'launcherFactoryMultiplier', args: [factory as Hex] })
    const result = await rpc<Hex>('eth_call', [{ to: chain.poolLaunch.portal, data }, 'latest'])
    const [enabled, multiplierBps] = decodeFunctionResult({ abi: portalReadsAbi, functionName: 'launcherFactoryMultiplier', data: result })
    statements.push(factoryStatusStatement(chain.key, factory, enabled, multiplierBps, now))
  }
  statements.push(checkpointStatement(chain.key, safeHead + 1, head, now))
  statements.push({ sql: 'UPDATE sync_state SET last_error = NULL, last_error_at = NULL WHERE chain = ?', params: [chain.key] })

  console.error(`${chain.name}: ${events.length} events, ${factories.size} launcher factories, through block ${safeHead}`)
  return statements.map(inline)
}

const lines: string[] = []
// Optional arguments pick the chains: `npx tsx scripts/backfill-d1.ts bscTestnet`.
const requested = process.argv.slice(2).filter((value): value is ChainKey => value === 'bsc' || value === 'bscTestnet')
for (const key of requested.length > 0 ? requested : (['bsc', 'bscTestnet'] as const)) lines.push(...(await backfill(CHAINS[key])))
process.stdout.write(`${lines.join('\n')}\n`)
