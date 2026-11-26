import { keccak256, parseAbi, parseAbiParameters, toHex } from 'viem'

/**
 * Pool Launch Portal events, from
 * https://docs.flap.sh/en/flap/v2/developers/pool-launch/build-an-indexer
 * Fields are not indexed unless marked.
 */
export const portalEventsAbi = parseAbi([
  'event FlapNewLauncherCreated(address launcher, address launcherFactory, address creator, string description)',
  'event FlapLauncherFactoryMultiplierSet(address factory, uint16 multiplierBps, bool enabled)',
  'event FlapDirectLaunched(address token, uint8 kind, address creator, bytes32 schemaId, bytes data)',
  'event FlapNewVaultCreated(address token, address vault, address vaultFactory, address creator)',
  'event FlapDistributionExecuted(address token, uint8 target, address strategy, uint256 amount)',
  'event FlapTokenGraduated(address token)',
  'event FlapVaultFactoryRegistered(address factory, bool enabled, bool official, uint8 riskLevel)',
  'event FlapVaultFactoryMultiplierSet(address factory, uint16 multiplierBps, bool enabled)',
  'event FlapVaultWhitelisted(address indexed token, address indexed vault)',
  'event FlapCreationPausedSet(bool paused)',
])

export const portalReadsAbi = parseAbi([
  'struct LauncherRecord { address launcherFactory; }',
  'function getLauncher(address launcher) view returns (LauncherRecord record)',
  'function launcherFactoryMultiplier(address factory) view returns (bool enabled, uint16 multiplierBps)',
  'function getLaunchVault(address token) view returns (address vault, address vaultFactory)',
  'function launchQuoteConfig(uint8 kind, address quoteToken) view returns (bool enabled, uint256 quotePriceUsd)',
])

export const launcherFactoryAbi = parseAbi(['function factorySpecVersion() pure returns (string)'])

/** schemaId of the only FlapDirectLaunched layout that exists today. */
export const DIRECT_LAUNCH_V2_SCHEMA_ID = keccak256(toHex('DirectLaunchV2(DirectLaunchV2Data)'))

/** `data` of FlapDirectLaunched when schemaId is DIRECT_LAUNCH_V2_SCHEMA_ID. */
export const directLaunchV2DataParams = parseAbiParameters(
  '(uint256 nonce, uint256 ts, uint8 tokenVersion, address quoteToken, uint8 migratorType, uint256 initialPriceWad, string name, string symbol, string meta, address pool, uint256 totalSupply, uint8 antiSniperMode, uint16 maxBuyBps)',
)
