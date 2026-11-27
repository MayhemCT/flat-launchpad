import { bsc, bscTestnet } from "viem/chains";
import { parseAbi, type Address, type Chain } from "viem";
import manifest from "@launcher-ui/manifest.json";

/** Flap's Pool Launch Portal: the same address on BNB Chain and BNB Chain Testnet. */
export const PORTAL: Address = "0x000042108465206185A077Edc3F3fd2b49060000";
/** The FlapDirectTaxToken implementation the Portal clones. A launch salt must give a token address ending 7777. */
export const TOKEN_IMPLEMENTATION: Address = "0x7777c57ff7dc441c1715b2e36fa581c48B782222";

export interface Network {
  chain: Chain;
  label: string;
  unit: string;
  rpcUrl: string;
  explorer: string;
  /** Flap's site path for a token on this chain. */
  flapTokenPath: string;
}

export const NETWORKS: Record<number, Network> = {
  97: {
    chain: bscTestnet,
    label: "BNB Chain Testnet",
    unit: "tBNB",
    // VITE_RPC_URL points the page at another endpoint, for example a private one or a local fork.
    rpcUrl: import.meta.env.VITE_RPC_URL ?? "https://bsc-testnet-rpc.publicnode.com",
    explorer: "https://testnet.bscscan.com",
    flapTokenPath: "https://flap.sh/bnb-testnet",
  },
  56: {
    chain: bsc,
    label: "BNB Chain",
    unit: "BNB",
    rpcUrl: "https://bsc-rpc.publicnode.com",
    explorer: "https://bscscan.com",
    flapTokenPath: "https://flap.sh/bnb",
  },
};

/** The launch UI package declares the chain and the factory it was written for. */
export const CHAIN_ID: number = manifest.chainId;
export const FACTORY = manifest.factoryAddress as Address;
/**
 * CallZ Launcher Factories from before the current one. A change to the Launcher's code moves the factory to a
 * new address, and the mints created through an earlier factory stay where they are: they are still listed and
 * can still be minted, claimed and refunded here. New mints are created through `FACTORY` only.
 */
export const EARLIER_FACTORIES: readonly Address[] = ["0x873040D38Bd73eF1cE7d8D814278605CF6b697b3"];
export const NETWORK: Network = NETWORKS[CHAIN_ID] ?? NETWORKS[97]!;

export const portalAbi = parseAbi([
  "struct LauncherRecord { address launcherFactory; }",
  "function newLauncher(address launcherFactory, bytes data) payable returns (address launcher)",
  "function SALT_LOCK_FEE() view returns (uint256)",
  "function getLauncher(address launcher) view returns (LauncherRecord record)",
  "event FlapNewLauncherCreated(address launcher, address launcherFactory, address creator, string description)",
]);

export const factoryAbi = parseAbi([
  "function launcherCount() view returns (uint256)",
  "function launchers(uint256 index) view returns (address)",
]);

/** The reads the launcher list shows for each Launcher. */
export const launcherSummaryAbi = parseAbi([
  "function tokenName() view returns (string)",
  "function tokenSymbol() view returns (string)",
  "function minted() view returns (uint256)",
  "function maxNFTs() view returns (uint256)",
  "function cap() view returns (uint256)",
  "function raised() view returns (uint256)",
  "function launched() view returns (bool)",
  "function saleDeadline() view returns (uint256)",
]);
