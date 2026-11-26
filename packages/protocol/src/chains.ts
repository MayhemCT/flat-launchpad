import type { Address } from 'viem'

/**
 * Flap contract addresses, copied from
 * https://docs.flap.sh/en/flap/v2/developers/deployed-contract-addresses
 * (read 2026-11-26). Pool Launch contracts share one address on BNB Chain and
 * BNB Chain Testnet, except TaxTokenHelper.
 */
export const POOL_LAUNCH_PORTAL: Address = '0x000042108465206185A077Edc3F3fd2b49060000'

export type ChainKey = 'bsc' | 'bscTestnet'

export interface ChainConfig {
  key: ChainKey
  id: number
  name: string
  explorer: string
  /** Public endpoints that serve eth_getLogs. Tried in order. */
  rpcUrls: readonly string[]
  /** Largest block span the endpoints accept for one eth_getLogs call. */
  logRange: number
  poolLaunch: {
    /** Just below the Portal's first event on this chain; scans start here. */
    startBlock: number
    portal: Address
    directTaxTokenImpl: Address
    taxTokenHelper: Address
    allocationStrategy: Address
    tokenDockRouter: Address
    openTokenDock: Address
    verifiedTokenDock: Address
  }
  bondingCurve: {
    portal: Address
    vaultPortal: Address
  }
  infrastructure: {
    triggerService: Address
    aiProvider: Address
    vaultEx: Address
    xVerifier: Address
    candyBox: Address
    tokenLocker: Address
    tokenRegistry: Address
    guardian?: Address
  }
}

const SHARED_POOL_LAUNCH = {
  portal: POOL_LAUNCH_PORTAL,
  directTaxTokenImpl: '0x7777c57ff7dc441c1715b2e36fa581c48B782222',
  allocationStrategy: '0x000051353ef814E4779B692cb2Bb3A6Cb3710000',
  tokenDockRouter: '0x000048E888aBf09f690a952E1b386b2D031a0000',
  openTokenDock: '0x0000E34C74b9eC7b52F35528249Aa9C4AdE00000',
  verifiedTokenDock: '0x00004B06D90Df7a39491264744BF187D90Df0000',
} as const

export const CHAINS: Record<ChainKey, ChainConfig> = {
  bsc: {
    key: 'bsc',
    id: 56,
    name: 'BNB Chain',
    explorer: 'https://bscscan.com',
    rpcUrls: ['https://bsc-rpc.publicnode.com', 'https://public-bsc-mainnet.fastnode.io'],
    logRange: 10_000,
    // First Portal event: block 135,512,524.
    poolLaunch: { ...SHARED_POOL_LAUNCH, startBlock: 135_500_000, taxTokenHelper: '0x53841c73217735F37BC1775538b03b23feFD8346' },
    bondingCurve: {
      portal: '0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0',
      vaultPortal: '0x90497450f2a706f1951b5bdda52B4E5d16f34C06',
    },
    infrastructure: {
      triggerService: '0xcf4EE25035CF883895110f367F5BA8172416a7F9',
      aiProvider: '0xaEe3a7Ca6fe6b53f6c32a3e8407eC5A9dF8B7E39',
      vaultEx: '0x000048Df69f3d2af22Df6DC2d3B01FB592b90000',
      xVerifier: '0xcA8DBE6CAC4BFDc41226b0BaF2359fd99989b3E4',
      candyBox: '0x6255fbd731272a517022e99f6CaCf6A5De9414Ee',
      tokenLocker: '0x0000A8B6741441BB4Ba0DFE313a2bc7b2Cf10000',
      tokenRegistry: '0x0000e9f9F5e469f0EEC27F192B4DdDE04D4c0000',
      guardian: '0x9e27098dcD8844bcc6287a557E0b4D09C86B8a4b',
    },
  },
  bscTestnet: {
    key: 'bscTestnet',
    id: 97,
    name: 'BNB Chain Testnet',
    explorer: 'https://testnet.bscscan.com',
    rpcUrls: ['https://bsc-testnet-rpc.publicnode.com'],
    logRange: 50_000,
    // First Portal event: block 144,549,646.
    poolLaunch: { ...SHARED_POOL_LAUNCH, startBlock: 144_540_000, taxTokenHelper: '0xD64441e5FcD02D342B8cf6eBA10Ef6E40d0dA90f' },
    bondingCurve: {
      portal: '0x5bEacaF7ABCbB3aB280e80D007FD31fcE26510e9',
      vaultPortal: '0x027e3704fC5C16522e9393d04C60A3ac5c0d775f',
    },
    infrastructure: {
      triggerService: '0x560E9830926C9e0EB98a59c6b9902383Fc0D9Eb2',
      aiProvider: '0xFfddcE44e8cFf7703Fd85118524bfC8B2f70b744',
      vaultEx: '0xa35AE5b62bA52d91F4952EbD3eC015B87BceEF00',
      xVerifier: '0x236C4AF8e0674fB22a139DDE4C2A518CBA819932',
      candyBox: '0x8e6C16Bf07022a7Da9398B543f38846E9355Bd70',
      tokenLocker: '0x0000A8B6741441BB4Ba0DFE313a2bc7b2Cf10000',
      tokenRegistry: '0x0000e9f9F5e469f0EEC27F192B4DdDE04D4c0000',
    },
  },
}

export function isChainKey(value: string): value is ChainKey {
  return value === 'bsc' || value === 'bscTestnet'
}
