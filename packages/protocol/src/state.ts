import type { Address, Hex } from 'viem'
import type { DirectLaunchV2, PortalEvent } from './events.js'

/** Addresses are stored lowercase so they can be used as keys. */
export type Key = Lowercase<string>
export const key = (address: string): Key => address.toLowerCase() as Key

export interface LauncherFactoryRecord {
  address: Key
  /** null until a FlapLauncherFactoryMultiplierSet for it has been seen. */
  enabled: boolean | null
  multiplierBps: number | null
  launcherCount: number
  firstSeenBlock: number
  lastSeenBlock: number
}

export interface VaultFactoryRecord {
  address: Key
  enabled: boolean | null
  official: boolean | null
  riskLevel: number | null
  multiplierBps: number | null
  vaultCount: number
  firstSeenBlock: number
  lastSeenBlock: number
}

export interface LauncherRecord {
  address: Key
  factory: Key
  creator: Key
  description: string
  blockNumber: number
  txHash: Hex
  timestamp: number | null
  /** The token this Launcher launched, once it has. */
  token: Key | null
}

export interface TokenRecord {
  address: Key
  kind: number
  creator: Key
  schemaId: Hex
  launch: DirectLaunchV2 | null
  blockNumber: number
  txHash: Hex
  timestamp: number | null
  vault: Key | null
  vaultFactory: Key | null
  graduated: boolean
  distribution: { target: number; strategy: Key; amount: string } | null
  /** The Launcher that launched it; null for a direct launch. */
  launcher: Key | null
}

export interface IndexState {
  launcherFactories: Record<Key, LauncherFactoryRecord>
  vaultFactories: Record<Key, VaultFactoryRecord>
  launchers: Record<Key, LauncherRecord>
  tokens: Record<Key, TokenRecord>
  creationPaused: boolean | null
}

export function emptyState(): IndexState {
  return { launcherFactories: {}, vaultFactories: {}, launchers: {}, tokens: {}, creationPaused: null }
}

function launcherFactory(state: IndexState, address: Address, block: number): LauncherFactoryRecord {
  const k = key(address)
  const record = (state.launcherFactories[k] ??= {
    address: k,
    enabled: null,
    multiplierBps: null,
    launcherCount: 0,
    firstSeenBlock: block,
    lastSeenBlock: block,
  })
  record.lastSeenBlock = Math.max(record.lastSeenBlock, block)
  return record
}

function vaultFactory(state: IndexState, address: Address, block: number): VaultFactoryRecord {
  const k = key(address)
  const record = (state.vaultFactories[k] ??= {
    address: k,
    enabled: null,
    official: null,
    riskLevel: null,
    multiplierBps: null,
    vaultCount: 0,
    firstSeenBlock: block,
    lastSeenBlock: block,
  })
  record.lastSeenBlock = Math.max(record.lastSeenBlock, block)
  return record
}

/**
 * Applies one event. Events must arrive in chain order. Re-applying an event
 * that created a launcher, token or vault is a no-op, so a scan can safely
 * overlap the previous one.
 */
export function applyEvent(state: IndexState, event: PortalEvent): void {
  switch (event.type) {
    case 'LauncherFactoryMultiplierSet': {
      const record = launcherFactory(state, event.factory, event.blockNumber)
      record.enabled = event.enabled
      record.multiplierBps = event.multiplierBps
      return
    }
    case 'LauncherCreated': {
      const k = key(event.launcher)
      const factory = launcherFactory(state, event.launcherFactory, event.blockNumber)
      if (state.launchers[k]) return
      factory.launcherCount += 1
      state.launchers[k] = {
        address: k,
        factory: factory.address,
        creator: key(event.creator),
        description: event.description,
        blockNumber: event.blockNumber,
        txHash: event.txHash,
        timestamp: event.timestamp ?? null,
        token: null,
      }
      return
    }
    case 'DirectLaunched': {
      const k = key(event.token)
      if (state.tokens[k]) return
      state.tokens[k] = {
        address: k,
        kind: event.kind,
        creator: key(event.creator),
        schemaId: event.schemaId,
        launch: event.launch ?? null,
        blockNumber: event.blockNumber,
        txHash: event.txHash,
        timestamp: event.timestamp ?? event.launch?.ts ?? null,
        vault: null,
        vaultFactory: null,
        graduated: false,
        distribution: null,
        launcher: null,
      }
      return
    }
    case 'VaultCreated': {
      const factory = vaultFactory(state, event.vaultFactory, event.blockNumber)
      const token = state.tokens[key(event.token)]
      if (token && token.vault === null) {
        token.vault = key(event.vault)
        token.vaultFactory = factory.address
        factory.vaultCount += 1
      }
      return
    }
    case 'DistributionExecuted': {
      const token = state.tokens[key(event.token)]
      if (token) token.distribution = { target: event.target, strategy: key(event.strategy), amount: event.amount }
      return
    }
    case 'TokenGraduated': {
      const token = state.tokens[key(event.token)]
      if (token) token.graduated = true
      return
    }
    case 'VaultFactoryRegistered': {
      const record = vaultFactory(state, event.factory, event.blockNumber)
      record.enabled = event.enabled
      record.official = event.official
      record.riskLevel = event.riskLevel
      return
    }
    case 'VaultFactoryMultiplierSet': {
      const record = vaultFactory(state, event.factory, event.blockNumber)
      record.enabled = event.enabled
      record.multiplierBps = event.multiplierBps
      return
    }
    case 'VaultWhitelisted':
      return
    case 'CreationPausedSet':
      state.creationPaused = event.paused
      return
  }
}

/**
 * Links a token to the Launcher that launched it. The Portal has no read for
 * this: a Launcher calls launchTaxTokenV2 itself, so the launch transaction's
 * `to` is the Launcher address.
 */
export function linkTokenToLauncher(state: IndexState, token: Address, txTo: Address | null): void {
  if (txTo === null) return
  const tokenRecord = state.tokens[key(token)]
  const launcher = state.launchers[key(txTo)]
  if (!tokenRecord || !launcher) return
  tokenRecord.launcher = launcher.address
  launcher.token = tokenRecord.address
}

export interface DeployerRecord {
  address: Key
  /** Launchers this wallet created through Portal.newLauncher. */
  launchers: Key[]
  /** Tokens whose FlapDirectLaunched.creator is this wallet. */
  tokens: Key[]
  graduatedTokens: number
  launcherFactories: Key[]
  vaultFactories: Key[]
  firstSeenBlock: number
  lastSeenBlock: number
  firstSeenAt: number | null
  lastSeenAt: number | null
}

/** One row per wallet that created a Launcher or a token, most active first. */
export function aggregateDeployers(state: IndexState): DeployerRecord[] {
  const deployers = new Map<Key, DeployerRecord>()
  const touch = (address: Key, block: number, timestamp: number | null): DeployerRecord => {
    let record = deployers.get(address)
    if (!record) {
      record = {
        address,
        launchers: [],
        tokens: [],
        graduatedTokens: 0,
        launcherFactories: [],
        vaultFactories: [],
        firstSeenBlock: block,
        lastSeenBlock: block,
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
      }
      deployers.set(address, record)
    }
    if (block < record.firstSeenBlock) {
      record.firstSeenBlock = block
      record.firstSeenAt = timestamp
    }
    if (block > record.lastSeenBlock) {
      record.lastSeenBlock = block
      record.lastSeenAt = timestamp
    }
    return record
  }
  const add = (list: Key[], value: Key | null): void => {
    if (value !== null && !list.includes(value)) list.push(value)
  }

  for (const launcher of Object.values(state.launchers)) {
    const record = touch(launcher.creator, launcher.blockNumber, launcher.timestamp)
    record.launchers.push(launcher.address)
    add(record.launcherFactories, launcher.factory)
  }
  for (const token of Object.values(state.tokens)) {
    const record = touch(token.creator, token.blockNumber, token.timestamp)
    record.tokens.push(token.address)
    if (token.graduated) record.graduatedTokens += 1
    add(record.vaultFactories, token.vaultFactory)
    if (token.launcher !== null) add(record.launcherFactories, state.launchers[token.launcher]?.factory ?? null)
  }

  return [...deployers.values()].sort(
    (a, b) =>
      b.tokens.length - a.tokens.length ||
      b.launchers.length - a.launchers.length ||
      a.firstSeenBlock - b.firstSeenBlock ||
      a.address.localeCompare(b.address),
  )
}
