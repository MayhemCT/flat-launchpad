// Plain site constants. Nothing here imports viem, so the aggregator pages stay light.
import manifest from "@launcher-ui/manifest.json";

export type ChainKey = "bsc" | "bscTestnet";

export interface Site {
  key: ChainKey;
  id: number;
  label: string;
  short: string;
  unit: string;
  explorer: string;
  rpcUrl: string;
  /** The chain's name in flap.sh URLs. */
  flapChain: string;
}

export const SITES: Record<ChainKey, Site> = {
  bsc: {
    key: "bsc",
    id: 56,
    label: "BNB Chain",
    short: "Mainnet",
    unit: "BNB",
    explorer: "https://bscscan.com",
    rpcUrl: "https://bsc-rpc.publicnode.com",
    flapChain: "bnb",
  },
  bscTestnet: {
    key: "bscTestnet",
    id: 97,
    label: "BNB Chain Testnet",
    short: "Testnet",
    unit: "tBNB",
    explorer: "https://testnet.bscscan.com",
    rpcUrl: "https://bsc-testnet-rpc.publicnode.com",
    flapChain: "bnb-testnet",
  },
};

/** The chain and factory the RaidPass launch UI package was written for. */
export const RAIDPASS_CHAIN: ChainKey = manifest.chainId === 56 ? "bsc" : "bscTestnet";
export const RAIDPASS: Site = SITES[RAIDPASS_CHAIN];
export const FACTORY = manifest.factoryAddress.toLowerCase();

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** A Launcher's page on Flap, where every factory's own launch UI lives. */
export const flapLauncherUrl = (site: Site, launcher: string) => `https://flap.sh/launcher/${launcher}?chain=${site.flapChain}`;
/** A launched token's page on Flap. */
export const flapTokenUrl = (site: Site, token: string) => `https://flap.sh/${site.flapChain}/${token}`;
export const explorerAddressUrl = (site: Site, address: string) => `${site.explorer}/address/${address}`;
