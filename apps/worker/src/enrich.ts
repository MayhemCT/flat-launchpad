/**
 * What the Portal's events do not carry: how much each open Launcher has raised so far, what its quote token
 * is called, and where each token's picture is. Read from the chain and from IPFS on every sync.
 */
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'
import type { ChainConfig, Rpc } from '@flat/protocol'
import { parseLauncherDescription } from '@flat/protocol/description'
import { fetchIpfs, ipfsPath, readCapped } from './ipfs.js'
import type { Statement } from './statements.js'
import { BudgetExhausted, type Budget } from './sync.js'

/** Multicall3: the same address on BNB Chain and BNB Chain Testnet. */
const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

const multicallAbi = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
])
const erc20Abi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
])

/** Open Launchers whose balance is read each sync, newest first. */
const OPEN_LAUNCHERS = 300
/** Calls per `eth_call`, so one request stays well inside any endpoint's limits. */
const CALLS_PER_REQUEST = 200
/** Token pictures resolved per sync, per chain. */
const IMAGE_BATCH = 8
const IMAGE_RETRY_SECONDS = 1800
const IMAGE_MAX_TRIES = 5
const METADATA_MAX_BYTES = 262_144

interface Call {
  target: Address
  callData: Hex
}

function bind(db: D1Database, statement: Statement): D1PreparedStatement {
  return db.prepare(statement.sql).bind(...statement.params)
}

/** Runs the calls through Multicall3. A call that reverts, or returns nothing, is null. */
async function multicall(rpc: Rpc, budget: Budget, calls: Call[]): Promise<Array<Hex | null>> {
  const results: Array<Hex | null> = []
  for (let start = 0; start < calls.length; start += CALLS_PER_REQUEST) {
    if (budget.remaining < 1) throw new BudgetExhausted()
    const chunk = calls.slice(start, start + CALLS_PER_REQUEST)
    const data = encodeFunctionData({
      abi: multicallAbi,
      functionName: 'aggregate3',
      args: [chunk.map((call) => ({ ...call, allowFailure: true }))],
    })
    const raw = await rpc<Hex>('eth_call', [{ to: MULTICALL3, data }, 'latest'])
    const decoded = decodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', data: raw })
    for (const result of decoded) results.push(result.success && result.returnData !== '0x' ? result.returnData : null)
  }
  return results
}

const uint = (data: Hex | null | undefined): bigint | null => (data && data.length === 66 ? BigInt(data) : null)

function text(data: Hex | null | undefined): string | null {
  if (!data) return null
  try {
    const value = decodeFunctionResult({ abi: erc20Abi, functionName: 'symbol', data })
    // Symbols are shown as written, so anything unprintable or oversized is dropped rather than stored.
    return /^[\x20-\x7e]{1,24}$/.test(value) ? value : null
  } catch {
    return null
  }
}

/**
 * Reads the quote-token balance each open Launcher holds: how far its raise has come. Also names any quote
 * token seen for the first time. One request per 200 Launchers; only values that changed are written.
 */
export async function refreshRaises(db: D1Database, chain: ChainConfig, rpc: Rpc, budget: Budget, now: number): Promise<number> {
  if (budget.remaining < 1) return 0
  const [open, known] = await db.batch<Record<string, string | null>>([
    db
      .prepare(
        `SELECT l.address, l.description, l.raised FROM launchers l
WHERE l.chain = ?1 AND NOT EXISTS (SELECT 1 FROM tokens t WHERE t.chain = l.chain AND t.launcher = l.address)
ORDER BY l.block_number DESC LIMIT ?2`,
      )
      .bind(chain.key, OPEN_LAUNCHERS),
    db.prepare('SELECT address FROM quote_tokens WHERE chain = ?').bind(chain.key),
  ])
  const launchers = (open?.results ?? []).map((row) => ({
    address: String(row.address),
    description: row.description ?? '',
    raised: row.raised ?? null,
  }))
  if (launchers.length === 0) return 0

  const knownQuotes = new Set((known?.results ?? []).map((row) => row.address))
  const newQuotes: string[] = []
  const calls: Call[] = launchers.map((launcher) => {
    const parsed = parseLauncherDescription(launcher.description)
    const quote = parsed.kind === 'v1' ? parsed.description.quoteToken : undefined
    const holder = launcher.address as Address
    if (!quote || quote === ZERO_ADDRESS || !/^0x[0-9a-f]{40}$/.test(quote)) {
      return { target: MULTICALL3, callData: encodeFunctionData({ abi: multicallAbi, functionName: 'getEthBalance', args: [holder] }) }
    }
    if (!knownQuotes.has(quote) && !newQuotes.includes(quote)) newQuotes.push(quote)
    return { target: quote as Address, callData: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [holder] }) }
  })
  for (const quote of newQuotes) {
    calls.push({ target: quote as Address, callData: encodeFunctionData({ abi: erc20Abi, functionName: 'symbol' }) })
    calls.push({ target: quote as Address, callData: encodeFunctionData({ abi: erc20Abi, functionName: 'decimals' }) })
  }

  let results: Array<Hex | null>
  try {
    results = await multicall(rpc, budget, calls)
  } catch (error) {
    if (error instanceof BudgetExhausted) return 0
    throw error
  }

  const statements: Statement[] = []
  launchers.forEach((launcher, index) => {
    const balance = uint(results[index])
    if (balance === null || balance.toString() === launcher.raised) return
    statements.push({
      sql: 'UPDATE launchers SET raised = ?, raised_at = ? WHERE chain = ? AND address = ?',
      params: [balance.toString(), now, chain.key, launcher.address],
    })
  })
  newQuotes.forEach((quote, index) => {
    const at = launchers.length + index * 2
    const decimals = uint(results[at + 1])
    statements.push({
      sql: `INSERT INTO quote_tokens (chain, address, symbol, decimals, checked_at) VALUES (?, ?, ?, ?, ?)
ON CONFLICT (chain, address) DO NOTHING`,
      params: [chain.key, quote, text(results[at]), decimals !== null && decimals <= 36n ? Number(decimals) : null, now],
    })
  })
  if (statements.length > 0) await db.batch(statements.map((statement) => bind(db, statement)))
  return statements.length
}

/**
 * Finds each token's picture. `meta` names a metadata file on IPFS whose `image` names the picture; some
 * tokens point `meta` straight at the picture. A token whose metadata cannot be fetched is tried again later,
 * a few times; one with no picture is settled at once.
 */
export async function resolveImages(db: D1Database, chain: ChainConfig, budget: Budget, now: number): Promise<number> {
  if (budget.remaining < 1) return 0
  const pending = await db
    .prepare(
      `SELECT address, meta, image_tries FROM tokens
WHERE chain = ? AND image IS NULL AND meta IS NOT NULL AND meta != '' AND image_tries < ?
  AND (image_checked_at IS NULL OR image_checked_at < ?)
ORDER BY block_number DESC LIMIT ?`,
    )
    .bind(chain.key, IMAGE_MAX_TRIES, now - IMAGE_RETRY_SECONDS, IMAGE_BATCH)
    .all<{ address: string; meta: string; image_tries: number }>()

  const statements: Statement[] = []
  const settle = (address: string, image: string | null, tries: number) =>
    statements.push({
      sql: 'UPDATE tokens SET image = ?, image_checked_at = ?, image_tries = ? WHERE chain = ? AND address = ?',
      params: [image, now, tries, chain.key, address],
    })

  for (const token of pending.results) {
    if (budget.remaining < 1) break
    const path = ipfsPath(token.meta)
    if (!path) {
      settle(token.address, null, IMAGE_MAX_TRIES)
      continue
    }
    const response = await fetchIpfs(path, { allow: () => budget.take() })
    if (!response) {
      // Out of budget is not a failed try: the token is picked up again on the next sync.
      if (budget.remaining < 1) break
      settle(token.address, null, token.image_tries + 1)
      continue
    }
    if ((response.headers.get('content-type') ?? '').toLowerCase().startsWith('image/')) {
      await response.body?.cancel()
      settle(token.address, path, token.image_tries + 1)
      continue
    }
    let image: string | null = null
    try {
      const bytes = await readCapped(response, METADATA_MAX_BYTES)
      const metadata: unknown = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null
      if (metadata !== null && typeof metadata === 'object') image = ipfsPath((metadata as { image?: unknown }).image)
    } catch {
      // Not JSON: this token has no metadata this index can read.
    }
    settle(token.address, image, image ? token.image_tries + 1 : IMAGE_MAX_TRIES)
  }
  if (statements.length > 0) await db.batch(statements.map((statement) => bind(db, statement)))
  return statements.length
}
