import type { Address, Hex } from 'viem'
import type { ChainConfig } from './chains.js'
import { compareEvents, decodePortalLog, type PortalEvent, type RawLog } from './events.js'

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
    readonly url: string,
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

export interface RpcOptions {
  fetch?: typeof fetch
  retries?: number
  timeoutMs?: number
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const hex = (n: number): Hex => `0x${n.toString(16)}`

/** Errors that mean "this node cannot serve this request", so retrying is pointless. */
export function isPermanentRpcError(error: unknown): error is RpcError {
  return error instanceof RpcError && isPermanent(error)
}

function isPermanent(error: RpcError): boolean {
  return /archive|pruned|exceed|max block range|missing trie node/i.test(error.message)
}

/** Minimal JSON-RPC client over fetch: runs unchanged in Node and in a Worker. */
export function createRpc(urls: readonly string[], options: RpcOptions = {}) {
  const doFetch = options.fetch ?? fetch
  const retries = options.retries ?? 6
  const timeoutMs = options.timeoutMs ?? 20_000
  let id = 0

  return async function request<T>(method: string, params: unknown[]): Promise<T> {
    let lastError: unknown
    for (let attempt = 0; attempt <= retries; attempt++) {
      const url = urls[attempt % urls.length]
      if (url === undefined) throw new Error('no RPC url configured')
      try {
        const response = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!response.ok) throw new RpcError(`HTTP ${response.status}`, response.status, url)
        const body = (await response.json()) as { result?: T; error?: { code?: number; message?: string } }
        if (body.error) throw new RpcError(body.error.message ?? 'RPC error', body.error.code, url)
        return body.result as T
      } catch (error) {
        lastError = error
        if (error instanceof RpcError && isPermanent(error)) throw error
        // Public endpoints throttle with 403/429; back off harder for those.
        const throttled = error instanceof RpcError && (error.code === 403 || error.code === 429)
        if (attempt < retries) await sleep((throttled ? 1500 : 250) * 2 ** Math.min(attempt, 4))
      }
    }
    throw lastError
  }
}

export type Rpc = ReturnType<typeof createRpc>

export async function getHead(rpc: Rpc): Promise<number> {
  return Number(BigInt(await rpc<Hex>('eth_blockNumber', [])))
}

async function servesLogsAt(rpc: Rpc, address: Address, block: number): Promise<boolean> {
  try {
    await rpc<RawLog[]>('eth_getLogs', [{ address, fromBlock: hex(block), toBlock: hex(block) }])
    return true
  } catch (error) {
    if (error instanceof RpcError && isPermanent(error)) return false
    throw error
  }
}

/**
 * The oldest block the endpoint still serves logs for. Public BSC nodes prune:
 * anything older needs an archive endpoint.
 */
export async function findOldestServedBlock(rpc: Rpc, address: Address, head: number): Promise<number> {
  if (await servesLogsAt(rpc, address, 1)) return 1
  let lo = 1
  let hi = head
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (await servesLogsAt(rpc, address, mid)) hi = mid
    else lo = mid
  }
  return hi
}

export interface ScanOptions {
  fromBlock: number
  toBlock: number
  concurrency?: number
  onProgress?: (done: number, total: number) => void
}

/** Fetches and decodes every tracked Portal event in [fromBlock, toBlock], in chain order. */
export async function scanPortalEvents(rpc: Rpc, chain: ChainConfig, options: ScanOptions): Promise<PortalEvent[]> {
  const { fromBlock, toBlock } = options
  if (toBlock < fromBlock) return []
  const ranges: Array<[number, number]> = []
  for (let start = fromBlock; start <= toBlock; start += chain.logRange) {
    ranges.push([start, Math.min(start + chain.logRange - 1, toBlock)])
  }

  const events: PortalEvent[] = []
  let next = 0
  let done = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const range = ranges[next++]
      if (!range) return
      const logs = await rpc<RawLog[]>('eth_getLogs', [
        { address: chain.poolLaunch.portal, fromBlock: hex(range[0]), toBlock: hex(range[1]) },
      ])
      for (const log of logs) {
        const event = decodePortalLog(log)
        if (event) events.push(event)
      }
      options.onProgress?.(++done, ranges.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 4, ranges.length) }, worker))
  return events.sort(compareEvents)
}

/** `to` of a transaction, used to link a launch to its Launcher. */
export async function getTransactionTo(rpc: Rpc, txHash: Hex): Promise<Address | null> {
  const tx = await rpc<{ to: Address | null } | null>('eth_getTransactionByHash', [txHash])
  return tx?.to ?? null
}
