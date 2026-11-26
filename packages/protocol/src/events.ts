import { decodeAbiParameters, decodeEventLog, toEventSelector, type Address, type Hex } from 'viem'
import { DIRECT_LAUNCH_V2_SCHEMA_ID, directLaunchV2DataParams, portalEventsAbi } from './abi.js'

/** A log as returned by eth_getLogs. `blockTimestamp` is present on current BSC nodes. */
export interface RawLog {
  address: Address
  topics: Hex[]
  data: Hex
  blockNumber: Hex
  transactionHash: Hex
  logIndex: Hex
  blockTimestamp?: Hex
  removed?: boolean
}

export interface EventPosition {
  blockNumber: number
  logIndex: number
  txHash: Hex
  /** Unix seconds; undefined when the node did not return it. */
  timestamp: number | undefined
}

export interface DirectLaunchV2 {
  nonce: string
  ts: number
  tokenVersion: number
  quoteToken: Address
  migratorType: number
  initialPriceWad: string
  name: string
  symbol: string
  meta: string
  pool: Address
  totalSupply: string
  antiSniperMode: number
  maxBuyBps: number
}

export type PortalEvent = EventPosition &
  (
    | { type: 'LauncherCreated'; launcher: Address; launcherFactory: Address; creator: Address; description: string }
    | { type: 'LauncherFactoryMultiplierSet'; factory: Address; multiplierBps: number; enabled: boolean }
    | {
        type: 'DirectLaunched'
        token: Address
        kind: number
        creator: Address
        schemaId: Hex
        /** undefined when schemaId is a layout this code does not know. */
        launch: DirectLaunchV2 | undefined
      }
    | { type: 'VaultCreated'; token: Address; vault: Address; vaultFactory: Address; creator: Address }
    | { type: 'DistributionExecuted'; token: Address; target: number; strategy: Address; amount: string }
    | { type: 'TokenGraduated'; token: Address }
    | { type: 'VaultFactoryRegistered'; factory: Address; enabled: boolean; official: boolean; riskLevel: number }
    | { type: 'VaultFactoryMultiplierSet'; factory: Address; multiplierBps: number; enabled: boolean }
    | { type: 'VaultWhitelisted'; token: Address; vault: Address }
    | { type: 'CreationPausedSet'; paused: boolean }
  )

export function decodeDirectLaunchV2(data: Hex): DirectLaunchV2 {
  const [d] = decodeAbiParameters(directLaunchV2DataParams, data)
  return {
    nonce: d.nonce.toString(),
    ts: Number(d.ts),
    tokenVersion: d.tokenVersion,
    quoteToken: d.quoteToken,
    migratorType: d.migratorType,
    initialPriceWad: d.initialPriceWad.toString(),
    name: d.name,
    symbol: d.symbol,
    meta: d.meta,
    pool: d.pool,
    totalSupply: d.totalSupply.toString(),
    antiSniperMode: d.antiSniperMode,
    maxBuyBps: d.maxBuyBps,
  }
}

/** Selector → single-event ABI, built once so decoding a log costs no hashing. */
const EVENT_BY_SELECTOR = new Map(portalEventsAbi.map((item) => [toEventSelector(item), [item] as const]))

/**
 * Decodes one Portal log. Returns undefined for events this indexer does not
 * track (the Portal emits others, e.g. salt locks and quote configuration).
 */
export function decodePortalLog(log: RawLog): PortalEvent | undefined {
  if (log.removed) return undefined
  const [signature, ...rest] = log.topics
  if (signature === undefined) return undefined

  const abi = EVENT_BY_SELECTOR.get(signature)
  if (!abi) return undefined

  let decoded
  try {
    decoded = decodeEventLog({ abi, topics: [signature, ...rest], data: log.data, strict: true })
  } catch {
    return undefined
  }

  const position: EventPosition = {
    blockNumber: Number(BigInt(log.blockNumber)),
    logIndex: Number(BigInt(log.logIndex)),
    txHash: log.transactionHash,
    timestamp: log.blockTimestamp === undefined ? undefined : Number(BigInt(log.blockTimestamp)),
  }

  switch (decoded.eventName) {
    case 'FlapNewLauncherCreated':
      return { ...position, type: 'LauncherCreated', ...decoded.args }
    case 'FlapLauncherFactoryMultiplierSet':
      return { ...position, type: 'LauncherFactoryMultiplierSet', ...decoded.args }
    case 'FlapDirectLaunched': {
      const { token, kind, creator, schemaId, data } = decoded.args
      let launch: DirectLaunchV2 | undefined
      if (schemaId.toLowerCase() === DIRECT_LAUNCH_V2_SCHEMA_ID) {
        try {
          launch = decodeDirectLaunchV2(data)
        } catch {
          launch = undefined
        }
      }
      return { ...position, type: 'DirectLaunched', token, kind, creator, schemaId, launch }
    }
    case 'FlapNewVaultCreated':
      return { ...position, type: 'VaultCreated', ...decoded.args }
    case 'FlapDistributionExecuted': {
      const { token, target, strategy, amount } = decoded.args
      return { ...position, type: 'DistributionExecuted', token, target, strategy, amount: amount.toString() }
    }
    case 'FlapTokenGraduated':
      return { ...position, type: 'TokenGraduated', ...decoded.args }
    case 'FlapVaultFactoryRegistered':
      return { ...position, type: 'VaultFactoryRegistered', ...decoded.args }
    case 'FlapVaultFactoryMultiplierSet':
      return { ...position, type: 'VaultFactoryMultiplierSet', ...decoded.args }
    case 'FlapVaultWhitelisted':
      return { ...position, type: 'VaultWhitelisted', ...decoded.args }
    case 'FlapCreationPausedSet':
      return { ...position, type: 'CreationPausedSet', ...decoded.args }
  }
}

export function compareEvents(a: EventPosition, b: EventPosition): number {
  return a.blockNumber - b.blockNumber || a.logIndex - b.logIndex
}
