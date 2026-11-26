import { CHAINS, isChainKey, type ChainKey } from '@flat/protocol'
import { localized, parseLauncherDescription } from '@flat/protocol/description'

const MAX_LIMIT = 200
const DEFAULT_LIMIT = 50
const ADDRESS = /^0x[0-9a-f]{40}$/

function json(body: unknown, status = 200, maxAge = 15): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': status === 200 ? `public, max-age=${maxAge}` : 'no-store',
      'access-control-allow-origin': '*',
    },
  })
}

const notFound = (message: string) => json({ error: message }, 404)
const badRequest = (message: string) => json({ error: message }, 400)

function page(url: URL): { limit: number; offset: number } {
  const limit = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT)
  const offset = Number(url.searchParams.get('offset') ?? 0)
  return {
    limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT,
    offset: Number.isInteger(offset) && offset > 0 ? offset : 0,
  }
}

/** An optional address filter. Returns null when the parameter is present but malformed. */
function addressParam(url: URL, name: string): string | undefined | null {
  const raw = url.searchParams.get(name)
  if (raw === null) return undefined
  const value = raw.toLowerCase()
  return ADDRESS.test(value) ? value : null
}

async function overview(db: D1Database, chain: ChainKey): Promise<Response> {
  const [sync, counts] = await db.batch<Record<string, number | string | null>>([
    db.prepare('SELECT next_block, head, creation_paused, updated_at, last_error, last_error_at FROM sync_state WHERE chain = ?').bind(chain),
    db
      .prepare(
        `SELECT
  (SELECT COUNT(*) FROM launcher_factories WHERE chain = ?1) AS launcher_factories,
  (SELECT COUNT(*) FROM launcher_factories WHERE chain = ?1 AND enabled = 1) AS enabled_launcher_factories,
  (SELECT COUNT(*) FROM vault_factories WHERE chain = ?1) AS vault_factories,
  (SELECT COUNT(*) FROM launchers WHERE chain = ?1) AS launchers,
  (SELECT COUNT(*) FROM tokens WHERE chain = ?1) AS tokens,
  (SELECT COUNT(*) FROM tokens WHERE chain = ?1 AND graduated = 1) AS graduated,
  (SELECT COUNT(*) FROM (
     SELECT creator FROM launchers WHERE chain = ?1 UNION SELECT creator FROM tokens WHERE chain = ?1
   )) AS deployers`,
      )
      .bind(chain),
  ])
  const state = sync?.results[0]
  const c = counts?.results[0]
  const config = CHAINS[chain]
  return json({
    chain: { key: chain, id: config.id, name: config.name, explorer: config.explorer, portal: config.poolLaunch.portal },
    sync: state
      ? {
          nextBlock: state.next_block,
          head: state.head,
          updatedAt: state.updated_at,
          creationPaused: state.creation_paused === null ? null : state.creation_paused === 1,
          lastError: state.last_error ?? null,
          lastErrorAt: state.last_error_at ?? null,
        }
      : null,
    counts: {
      launcherFactories: c?.launcher_factories ?? 0,
      enabledLauncherFactories: c?.enabled_launcher_factories ?? 0,
      vaultFactories: c?.vault_factories ?? 0,
      launchers: c?.launchers ?? 0,
      tokens: c?.tokens ?? 0,
      graduated: c?.graduated ?? 0,
      deployers: c?.deployers ?? 0,
    },
  })
}

/**
 * What each Launcher Factory calls its launches: the title most of its Launchers carry. A factory whose
 * Launchers each carry a different title (the creator typed it) has no name of its own, and gets none.
 */
function factoryTitles(rows: ReadonlyArray<Record<string, string | number | null>>): Map<string, string> {
  const counts = new Map<string, Map<string, number>>()
  const totals = new Map<string, number>()
  for (const row of rows) {
    const factory = String(row.factory)
    totals.set(factory, (totals.get(factory) ?? 0) + 1)
    const parsed = parseLauncherDescription(String(row.description ?? ''))
    const title = parsed.kind === 'v1' ? localized(parsed.description.titles, 'en') : undefined
    if (!title) continue
    const byTitle = counts.get(factory) ?? new Map<string, number>()
    byTitle.set(title, (byTitle.get(title) ?? 0) + 1)
    counts.set(factory, byTitle)
  }
  const titles = new Map<string, string>()
  for (const [factory, byTitle] of counts) {
    const [title, count] = [...byTitle].sort((a, b) => b[1] - a[1])[0]!
    const total = totals.get(factory) ?? count
    if (total === 1 || count * 2 > total) titles.set(factory, title)
  }
  return titles
}

const TITLE_ROWS = 'SELECT factory, description FROM launchers WHERE chain = ?'

async function factories(db: D1Database, chain: ChainKey): Promise<Response> {
  const [launcher, vault, described] = await db.batch<Record<string, string | number | null>>([
    db
      .prepare(
        `SELECT f.address, f.enabled, f.multiplier_bps, f.first_seen_block,
  (SELECT COUNT(*) FROM launchers l WHERE l.chain = f.chain AND l.factory = f.address) AS launchers,
  (SELECT COUNT(DISTINCT l.creator) FROM launchers l WHERE l.chain = f.chain AND l.factory = f.address) AS deployers,
  (SELECT COUNT(*) FROM tokens t JOIN launchers l ON l.chain = t.chain AND l.address = t.launcher
     WHERE l.chain = f.chain AND l.factory = f.address) AS tokens,
  (SELECT COUNT(*) FROM tokens t JOIN launchers l ON l.chain = t.chain AND l.address = t.launcher
     WHERE l.chain = f.chain AND l.factory = f.address AND t.graduated = 1) AS graduated
FROM launcher_factories f WHERE f.chain = ?
ORDER BY launchers DESC, f.first_seen_block, f.address`,
      )
      .bind(chain),
    db
      .prepare(
        `SELECT f.address, f.enabled, f.official, f.risk_level, f.multiplier_bps, f.first_seen_block,
  (SELECT COUNT(*) FROM tokens t WHERE t.chain = f.chain AND t.vault_factory = f.address) AS vaults,
  (SELECT COUNT(DISTINCT t.creator) FROM tokens t WHERE t.chain = f.chain AND t.vault_factory = f.address) AS deployers,
  (SELECT COUNT(*) FROM tokens t WHERE t.chain = f.chain AND t.vault_factory = f.address AND t.graduated = 1) AS graduated
FROM vault_factories f WHERE f.chain = ?
ORDER BY vaults DESC, f.first_seen_block, f.address`,
      )
      .bind(chain),
    db.prepare(TITLE_ROWS).bind(chain),
  ])
  const flag = (value: string | number | null | undefined) => (value === null || value === undefined ? null : value === 1)
  const titles = factoryTitles(described?.results ?? [])
  return json({
    launcher: (launcher?.results ?? []).map((r) => ({
      address: r.address,
      title: titles.get(String(r.address)) ?? null,
      enabled: flag(r.enabled),
      multiplierBps: r.multiplier_bps,
      firstSeenBlock: r.first_seen_block,
      launchers: r.launchers,
      deployers: r.deployers,
      tokens: r.tokens,
      graduated: r.graduated,
    })),
    vault: (vault?.results ?? []).map((r) => ({
      address: r.address,
      enabled: flag(r.enabled),
      official: flag(r.official),
      riskLevel: r.risk_level,
      multiplierBps: r.multiplier_bps,
      firstSeenBlock: r.first_seen_block,
      vaults: r.vaults,
      deployers: r.deployers,
      graduated: r.graduated,
    })),
  })
}

async function deployers(db: D1Database, chain: ChainKey, url: URL): Promise<Response> {
  const { limit, offset } = page(url)
  const rows = await db
    .prepare(
      `WITH activity AS (
  SELECT creator, 1 AS launchers, 0 AS tokens, 0 AS graduated, timestamp, factory AS launcher_factory
    FROM launchers WHERE chain = ?1
  UNION ALL
  SELECT creator, 0, 1, graduated, timestamp, NULL FROM tokens WHERE chain = ?1
)
SELECT creator AS address,
  SUM(launchers) AS launchers,
  SUM(tokens) AS tokens,
  SUM(graduated) AS graduated,
  COUNT(DISTINCT launcher_factory) AS factories,
  MIN(timestamp) AS first_seen_at,
  MAX(timestamp) AS last_seen_at
FROM activity GROUP BY creator
ORDER BY tokens DESC, launchers DESC, first_seen_at, address
LIMIT ?2 OFFSET ?3`,
    )
    .bind(chain, limit, offset)
    .all<Record<string, string | number | null>>()
  return json({
    limit,
    offset,
    items: rows.results.map((r) => ({
      address: r.address,
      launchers: r.launchers,
      tokens: r.tokens,
      graduated: r.graduated,
      factories: r.factories,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
    })),
  })
}

async function launchers(db: D1Database, chain: ChainKey, url: URL): Promise<Response> {
  const { limit, offset } = page(url)
  const factory = addressParam(url, 'factory')
  const creator = addressParam(url, 'creator')
  if (factory === null || creator === null) return badRequest('factory and creator must be 0x addresses')

  const where = ['l.chain = ?']
  const params: Array<string | number> = [chain]
  if (factory) {
    where.push('l.factory = ?')
    params.push(factory)
  }
  if (creator) {
    where.push('l.creator = ?')
    params.push(creator)
  }
  const rows = await db
    .prepare(
      `SELECT l.address, l.factory, l.creator, l.description, l.block_number, l.tx_hash, l.timestamp,
  t.address AS token, t.symbol AS token_symbol, t.graduated AS token_graduated
FROM launchers l
LEFT JOIN tokens t ON t.chain = l.chain AND t.launcher = l.address
WHERE ${where.join(' AND ')}
ORDER BY l.block_number DESC, l.address
LIMIT ? OFFSET ?`,
    )
    .bind(...params, limit, offset)
    .all<Record<string, string | number | null>>()
  return json({
    limit,
    offset,
    items: rows.results.map((r) => ({
      address: r.address,
      factory: r.factory,
      creator: r.creator,
      description: r.description,
      blockNumber: r.block_number,
      txHash: r.tx_hash,
      timestamp: r.timestamp,
      token:
        r.token === null ? null : { address: r.token, symbol: r.token_symbol, graduated: r.token_graduated === 1 },
    })),
  })
}

async function tokens(db: D1Database, chain: ChainKey, url: URL): Promise<Response> {
  const { limit, offset } = page(url)
  const creator = addressParam(url, 'creator')
  const vaultFactory = addressParam(url, 'vaultFactory')
  if (creator === null || vaultFactory === null) return badRequest('creator and vaultFactory must be 0x addresses')

  const where = ['t.chain = ?']
  const params: Array<string | number> = [chain]
  if (creator) {
    where.push('t.creator = ?')
    params.push(creator)
  }
  if (vaultFactory) {
    where.push('t.vault_factory = ?')
    params.push(vaultFactory)
  }
  const rows = await db
    .prepare(
      `SELECT t.address, t.kind, t.creator, t.name, t.symbol, t.meta, t.image, t.pool, t.quote_token, t.total_supply,
  t.initial_price_wad, t.block_number, t.tx_hash, t.timestamp, t.vault, t.vault_factory, t.graduated,
  t.dist_target, t.dist_amount, t.launcher, l.factory AS launcher_factory
FROM tokens t
LEFT JOIN launchers l ON l.chain = t.chain AND l.address = t.launcher
WHERE ${where.join(' AND ')}
ORDER BY t.block_number DESC, t.address
LIMIT ? OFFSET ?`,
    )
    .bind(...params, limit, offset)
    .all<Record<string, string | number | null>>()
  return json({
    limit,
    offset,
    items: rows.results.map((r) => ({
      address: r.address,
      kind: r.kind,
      creator: r.creator,
      name: r.name,
      symbol: r.symbol,
      meta: r.meta,
      image: r.image,
      pool: r.pool,
      quoteToken: r.quote_token,
      totalSupply: r.total_supply,
      initialPriceWad: r.initial_price_wad,
      blockNumber: r.block_number,
      txHash: r.tx_hash,
      timestamp: r.timestamp,
      vault: r.vault,
      vaultFactory: r.vault_factory,
      graduated: r.graduated === 1,
      distribution: r.dist_target === null ? null : { target: r.dist_target, amount: r.dist_amount },
      launcher: r.launcher,
      launcherFactory: r.launcher_factory,
    })),
  })
}

const SCOPE_RAISING = 300
const SCOPE_LAUNCHED = 150

/**
 * Everything the Memescope page shows, in one response: Launchers still raising with how far they have come,
 * tokens that launched, the launchpad (Launcher Factory) behind each, and the quote tokens they raise in.
 */
async function scope(db: D1Database, chain: ChainKey): Promise<Response> {
  const [sync, raising, launched, platforms, described, quotes] = await db.batch<Record<string, string | number | null>>([
    db.prepare('SELECT head, updated_at FROM sync_state WHERE chain = ?').bind(chain),
    db
      .prepare(
        `SELECT l.address, l.factory, l.creator, l.description, l.timestamp, l.raised, l.raised_at FROM launchers l
WHERE l.chain = ?1 AND NOT EXISTS (SELECT 1 FROM tokens t WHERE t.chain = l.chain AND t.launcher = l.address)
ORDER BY l.block_number DESC, l.address LIMIT ?2`,
      )
      .bind(chain, SCOPE_RAISING),
    db
      .prepare(
        `SELECT t.address, t.creator, t.name, t.symbol, t.image, t.quote_token, t.total_supply, t.initial_price_wad,
  t.timestamp, t.graduated, t.vault_factory, t.launcher, l.factory AS launcher_factory
FROM tokens t LEFT JOIN launchers l ON l.chain = t.chain AND l.address = t.launcher
WHERE t.chain = ?1 ORDER BY t.block_number DESC, t.address LIMIT ?2`,
      )
      .bind(chain, SCOPE_LAUNCHED),
    db
      .prepare(
        `SELECT f.address, f.enabled,
  (SELECT COUNT(*) FROM launchers l WHERE l.chain = f.chain AND l.factory = f.address) AS launchers,
  (SELECT COUNT(*) FROM tokens t JOIN launchers l ON l.chain = t.chain AND l.address = t.launcher
     WHERE l.chain = f.chain AND l.factory = f.address) AS tokens
FROM launcher_factories f WHERE f.chain = ? ORDER BY launchers DESC, f.first_seen_block, f.address`,
      )
      .bind(chain),
    db.prepare(TITLE_ROWS).bind(chain),
    db.prepare('SELECT address, symbol, decimals FROM quote_tokens WHERE chain = ?').bind(chain),
  ])
  const titles = factoryTitles(described?.results ?? [])
  const state = sync?.results[0]
  return json({
    updatedAt: state?.updated_at ?? null,
    head: state?.head ?? null,
    platforms: (platforms?.results ?? []).map((r) => ({
      factory: r.address,
      title: titles.get(String(r.address)) ?? null,
      enabled: r.enabled === null ? null : r.enabled === 1,
      launchers: r.launchers,
      tokens: r.tokens,
    })),
    quotes: Object.fromEntries((quotes?.results ?? []).map((r) => [r.address, { symbol: r.symbol, decimals: r.decimals }])),
    raising: (raising?.results ?? []).map((r) => {
      const parsed = parseLauncherDescription(String(r.description ?? ''))
      const d = parsed.kind === 'v1' ? parsed.description : null
      return {
        address: r.address,
        factory: r.factory,
        creator: r.creator,
        name: d?.name ?? null,
        symbol: d?.symbol ?? null,
        quoteToken: d?.quoteToken ?? null,
        targetRaise: d?.targetRaise?.toString() ?? null,
        poolTokenRatio: d?.poolTokenRatio?.toString() ?? null,
        raised: r.raised,
        raisedAt: r.raised_at,
        timestamp: r.timestamp,
      }
    }),
    launched: (launched?.results ?? []).map((r) => ({
      address: r.address,
      creator: r.creator,
      name: r.name,
      symbol: r.symbol,
      image: r.image,
      quoteToken: r.quote_token,
      totalSupply: r.total_supply,
      initialPriceWad: r.initial_price_wad,
      timestamp: r.timestamp,
      graduated: r.graduated === 1,
      vaultFactory: r.vault_factory,
      launcher: r.launcher,
      factory: r.launcher_factory,
    })),
  })
}

/** Routes `/api/:chain/:resource`. Read-only. */
export async function handleApi(request: Request, db: D1Database): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'method not allowed' }, 405)
  const url = new URL(request.url)
  const [, api, chain, resource, extra] = url.pathname.split('/')
  if (api !== 'api' || extra !== undefined) return notFound('not found')

  if (chain === 'chains' && resource === undefined) {
    return json(
      Object.values(CHAINS).map((c) => ({ key: c.key, id: c.id, name: c.name, explorer: c.explorer })),
      200,
      3600,
    )
  }
  if (chain === undefined || !isChainKey(chain)) return notFound(`unknown chain; use one of: ${Object.keys(CHAINS).join(', ')}`)

  switch (resource) {
    case 'overview':
      return overview(db, chain)
    case 'factories':
      return factories(db, chain)
    case 'deployers':
      return deployers(db, chain, url)
    case 'launchers':
      return launchers(db, chain, url)
    case 'tokens':
      return tokens(db, chain, url)
    case 'scope':
      return scope(db, chain)
    default:
      return notFound('unknown resource')
  }
}
