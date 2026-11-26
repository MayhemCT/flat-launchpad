/**
 * Captures real Portal logs from BNB Chain into the test fixture, so the
 * decoder, reducer and SQL writer are tested against what the chain emits.
 *
 *   npx tsx scripts/capture-fixture.ts
 */
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { CHAINS, createRpc, decodePortalLog, getTransactionTo, type RawLog } from '@flat/protocol'

const chain = CHAINS.bsc
const FROM = 135_500_000
const TO = 135_850_000

const rpc = createRpc(chain.rpcUrls)
const logs: RawLog[] = []
for (let start = FROM; start <= TO; start += chain.logRange) {
  const end = Math.min(start + chain.logRange - 1, TO)
  const batch = await rpc<RawLog[]>('eth_getLogs', [
    { address: chain.poolLaunch.portal, fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}` },
  ])
  for (const log of batch) {
    logs.push({
      address: log.address,
      topics: log.topics,
      data: log.data,
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      logIndex: log.logIndex,
      ...(log.blockTimestamp === undefined ? {} : { blockTimestamp: log.blockTimestamp }),
    })
  }
}

const txTo: Record<string, string | null> = {}
for (const log of logs) {
  const event = decodePortalLog(log)
  if (event?.type === 'DirectLaunched') txTo[event.txHash] = await getTransactionTo(rpc, event.txHash)
}

const file = fileURLToPath(new URL('../packages/protocol/test/fixtures/bsc-portal-logs.json', import.meta.url))
await writeFile(file, `${JSON.stringify({ chain: chain.key, fromBlock: FROM, toBlock: TO, logs, txTo })}\n`)
console.log(`captured ${logs.length} logs, ${Object.keys(txTo).length} launch transactions → ${file}`)
