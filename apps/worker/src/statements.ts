import type { ChainKey, PortalEvent } from '@flat/protocol'

/** One SQL statement and its positional parameters. Runs on D1 and on any SQLite. */
export interface Statement {
  sql: string
  params: Array<string | number | null>
}

const lower = (value: string): string => value.toLowerCase()
const bool = (value: boolean): number => (value ? 1 : 0)

const ENSURE_LAUNCHER_FACTORY = `INSERT INTO launcher_factories (chain, address, first_seen_block)
VALUES (?, ?, ?) ON CONFLICT (chain, address) DO NOTHING`

const ENSURE_VAULT_FACTORY = `INSERT INTO vault_factories (chain, address, first_seen_block)
VALUES (?, ?, ?) ON CONFLICT (chain, address) DO NOTHING`

/**
 * The writes for one Portal event. They mirror `applyEvent` in @flat/protocol
 * and are idempotent, so a scan may overlap the previous one.
 */
export function eventStatements(chain: ChainKey, event: PortalEvent): Statement[] {
  switch (event.type) {
    case 'LauncherFactoryMultiplierSet':
      return [
        {
          sql: `INSERT INTO launcher_factories (chain, address, enabled, multiplier_bps, first_seen_block)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT (chain, address) DO UPDATE SET enabled = excluded.enabled, multiplier_bps = excluded.multiplier_bps`,
          params: [chain, lower(event.factory), bool(event.enabled), event.multiplierBps, event.blockNumber],
        },
      ]
    case 'LauncherCreated':
      return [
        { sql: ENSURE_LAUNCHER_FACTORY, params: [chain, lower(event.launcherFactory), event.blockNumber] },
        {
          sql: `INSERT INTO launchers (chain, address, factory, creator, description, block_number, tx_hash, timestamp)
VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (chain, address) DO NOTHING`,
          params: [
            chain,
            lower(event.launcher),
            lower(event.launcherFactory),
            lower(event.creator),
            event.description,
            event.blockNumber,
            lower(event.txHash),
            event.timestamp ?? null,
          ],
        },
      ]
    case 'DirectLaunched': {
      const launch = event.launch
      return [
        {
          sql: `INSERT INTO tokens (chain, address, kind, creator, schema_id, name, symbol, meta, pool, quote_token,
  total_supply, initial_price_wad, nonce, block_number, tx_hash, timestamp)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (chain, address) DO NOTHING`,
          params: [
            chain,
            lower(event.token),
            event.kind,
            lower(event.creator),
            lower(event.schemaId),
            launch?.name ?? null,
            launch?.symbol ?? null,
            launch?.meta ?? null,
            launch ? lower(launch.pool) : null,
            launch ? lower(launch.quoteToken) : null,
            launch?.totalSupply ?? null,
            launch?.initialPriceWad ?? null,
            launch?.nonce ?? null,
            event.blockNumber,
            lower(event.txHash),
            event.timestamp ?? launch?.ts ?? null,
          ],
        },
      ]
    }
    case 'VaultCreated':
      return [
        { sql: ENSURE_VAULT_FACTORY, params: [chain, lower(event.vaultFactory), event.blockNumber] },
        {
          sql: `UPDATE tokens SET vault = ?, vault_factory = ? WHERE chain = ? AND address = ? AND vault IS NULL`,
          params: [lower(event.vault), lower(event.vaultFactory), chain, lower(event.token)],
        },
      ]
    case 'DistributionExecuted':
      return [
        {
          sql: `UPDATE tokens SET dist_target = ?, dist_strategy = ?, dist_amount = ? WHERE chain = ? AND address = ?`,
          params: [event.target, lower(event.strategy), event.amount, chain, lower(event.token)],
        },
      ]
    case 'TokenGraduated':
      return [
        { sql: `UPDATE tokens SET graduated = 1 WHERE chain = ? AND address = ?`, params: [chain, lower(event.token)] },
      ]
    case 'VaultFactoryRegistered':
      return [
        {
          sql: `INSERT INTO vault_factories (chain, address, enabled, official, risk_level, first_seen_block)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT (chain, address) DO UPDATE SET
  enabled = excluded.enabled, official = excluded.official, risk_level = excluded.risk_level`,
          params: [
            chain,
            lower(event.factory),
            bool(event.enabled),
            bool(event.official),
            event.riskLevel,
            event.blockNumber,
          ],
        },
      ]
    case 'VaultFactoryMultiplierSet':
      return [
        {
          sql: `INSERT INTO vault_factories (chain, address, enabled, multiplier_bps, first_seen_block)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT (chain, address) DO UPDATE SET enabled = excluded.enabled, multiplier_bps = excluded.multiplier_bps`,
          params: [chain, lower(event.factory), bool(event.enabled), event.multiplierBps, event.blockNumber],
        },
      ]
    case 'CreationPausedSet':
      return [
        {
          sql: `UPDATE sync_state SET creation_paused = ? WHERE chain = ?`,
          params: [bool(event.paused), chain],
        },
      ]
    case 'VaultWhitelisted':
      return []
  }
}

/** Creates the chain's sync row if it is missing, so later updates always hit a row. */
export function ensureSyncStatement(chain: ChainKey, startBlock: number, now: number): Statement {
  return {
    sql: `INSERT INTO sync_state (chain, next_block, head, updated_at) VALUES (?, ?, ?, ?)
ON CONFLICT (chain) DO NOTHING`,
    params: [chain, startBlock, startBlock, now],
  }
}

export function checkpointStatement(chain: ChainKey, nextBlock: number, head: number, now: number): Statement {
  return {
    sql: `UPDATE sync_state SET next_block = ?, head = ?, updated_at = ? WHERE chain = ?`,
    params: [nextBlock, head, now, chain],
  }
}

/**
 * Records which Launcher launched a token. `txTo` is the launch transaction's
 * recipient; it only counts when it is a Launcher the Portal recorded.
 */
export function linkStatement(chain: ChainKey, token: string, txTo: string | null): Statement {
  return {
    sql: `UPDATE tokens SET launcher_checked = 1,
  launcher = (SELECT address FROM launchers WHERE chain = ? AND address = ?)
WHERE chain = ? AND address = ?`,
    params: [chain, txTo === null ? null : lower(txTo), chain, lower(token)],
  }
}

export function factoryStatusStatement(
  chain: ChainKey,
  factory: string,
  enabled: boolean,
  multiplierBps: number,
  now: number,
): Statement {
  return {
    sql: `UPDATE launcher_factories SET enabled = ?, multiplier_bps = ?, status_checked_at = ?
WHERE chain = ? AND address = ?`,
    params: [bool(enabled), multiplierBps, now, chain, lower(factory)],
  }
}
