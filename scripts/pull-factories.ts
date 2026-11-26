/**
 * Pulls every Pool Launch factory, Launcher, token and deployer from the Pool
 * Launch Portal's events and writes one snapshot per chain to data/.
 *
 *   npm run pull                    # both chains
 *   npm run pull -- bscTestnet      # one chain
 *   BSC_RPC_URL=https://... npm run pull -- bsc   # archive endpoint for full mainnet history
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { decodeFunctionResult, encodeFunctionData, type Hex } from 'viem'
import {
  CHAINS,
  aggregateDeployers,
  applyEvent,
  createRpc,
  emptyState,
  findOldestServedBlock,
  getHead,
  getTransactionTo,
  isChainKey,
  isPermanentRpcError,
  linkTokenToLauncher,
  portalReadsAbi,
  scanPortalEvents,
  type ChainConfig,
  type ChainKey,
  type Rpc,
} from '@flat/protocol'

const RPC_ENV: Record<ChainKey, string> = { bsc: 'BSC_RPC_URL', bscTestnet: 'BSC_TESTNET_RPC_URL' }

async function readFactoryStatus(rpc: Rpc, chain: ChainConfig, factory: string) {
  const data = encodeFunctionData({
    abi: portalReadsAbi,
    functionName: 'launcherFactoryMultiplier',
    args: [factory as Hex],
  })
  const result = await rpc<Hex>('eth_call', [{ to: chain.poolLaunch.portal, data }, 'latest'])
  const [enabled, multiplierBps] = decodeFunctionResult({
    abi: portalReadsAbi,
    functionName: 'launcherFactoryMultiplier',
    data: result,
  })
  return { enabled, multiplierBps }
}

async function pull(chain: ChainConfig): Promise<void> {
  const override = process.env[RPC_ENV[chain.key]]
  const rpc = createRpc(override ? [override] : chain.rpcUrls)
  const head = await getHead(rpc)
  const startBlock = chain.poolLaunch.startBlock
  // Only look for the pruning boundary when the node refuses the start block.
  let oldestServed = startBlock
  try {
    await rpc('eth_getLogs', [
      { address: chain.poolLaunch.portal, fromBlock: `0x${startBlock.toString(16)}`, toBlock: `0x${startBlock.toString(16)}` },
    ])
  } catch (error) {
    if (!isPermanentRpcError(error)) throw error
    oldestServed = await findOldestServedBlock(rpc, chain.poolLaunch.portal, head)
  }
  const fromBlock = Math.max(startBlock, oldestServed)
  const historyComplete = oldestServed <= startBlock

  console.log(`\n${chain.name}: scanning ${fromBlock} → ${head} (${head - fromBlock + 1} blocks)`)
  if (!historyComplete) {
    console.log(
      `  ! endpoint only serves logs from block ${oldestServed}; the Portal's first event is at ${startBlock}.` +
        ` Set ${RPC_ENV[chain.key]} to an archive endpoint for the full history.`,
    )
  }

  let lastPrinted = 0
  const events = await scanPortalEvents(rpc, chain, {
    fromBlock,
    toBlock: head,
    onProgress: (done, total) => {
      const percent = Math.floor((done / total) * 100)
      if (percent >= lastPrinted + 10) {
        lastPrinted = percent
        console.log(`  ${percent}%`)
      }
    },
  })

  const state = emptyState()
  for (const event of events) applyEvent(state, event)
  for (const event of events) {
    if (event.type !== 'DirectLaunched') continue
    linkTokenToLauncher(state, event.token, await getTransactionTo(rpc, event.txHash))
  }
  // The Portal is the authority on whether a factory is enabled right now.
  for (const factory of Object.values(state.launcherFactories)) {
    const status = await readFactoryStatus(rpc, chain, factory.address)
    factory.enabled = status.enabled
    factory.multiplierBps = status.multiplierBps
  }

  const deployers = aggregateDeployers(state)
  const snapshot = {
    chain: { key: chain.key, id: chain.id, name: chain.name, portal: chain.poolLaunch.portal },
    generatedAt: new Date().toISOString(),
    scannedFrom: fromBlock,
    scannedTo: head,
    historyComplete,
    eventCount: events.length,
    state,
    deployers,
  }

  const dir = fileURLToPath(new URL('../data/', import.meta.url))
  await mkdir(dir, { recursive: true })
  const file = `${dir}${chain.key}.json`
  await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`)

  const launcherFactories = Object.values(state.launcherFactories)
  const vaultFactories = Object.values(state.vaultFactories)
  console.log(`  events            ${events.length}`)
  console.log(`  launcher factories ${launcherFactories.length}`)
  for (const f of launcherFactories.sort((a, b) => b.launcherCount - a.launcherCount)) {
    console.log(`    ${f.address}  enabled=${f.enabled}  multiplier=${f.multiplierBps}  launchers=${f.launcherCount}`)
  }
  console.log(`  vault factories    ${vaultFactories.length}`)
  for (const f of vaultFactories.sort((a, b) => b.vaultCount - a.vaultCount)) {
    console.log(`    ${f.address}  enabled=${f.enabled}  official=${f.official}  risk=${f.riskLevel}  vaults=${f.vaultCount}`)
  }
  console.log(`  launchers          ${Object.keys(state.launchers).length}`)
  console.log(`  tokens             ${Object.keys(state.tokens).length}`)
  console.log(`  deployers          ${deployers.length}`)
  console.log(`  creation paused    ${state.creationPaused}`)
  console.log(`  wrote ${file}`)
}

const requested = process.argv.slice(2)
const keys: ChainKey[] = requested.length > 0 ? requested.filter(isChainKey) : ['bscTestnet', 'bsc']
if (requested.length > 0 && keys.length !== requested.length) {
  console.error(`unknown chain; use one of: ${Object.keys(CHAINS).join(', ')}`)
  process.exit(1)
}
for (const k of keys) await pull(CHAINS[k])
