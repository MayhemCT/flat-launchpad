// The read-only Pool Launch index served by this site's Worker under /api (apps/worker/src/api.ts).
import { useEffect, useState } from "react";
import type { ChainKey } from "./site";

export interface Overview {
  sync: { nextBlock: number; head: number; updatedAt: number; lastError: string | null } | null;
  counts: {
    launcherFactories: number;
    enabledLauncherFactories: number;
    vaultFactories: number;
    launchers: number;
    tokens: number;
    graduated: number;
    deployers: number;
  };
}

export interface LauncherRow {
  address: string;
  factory: string;
  creator: string;
  /** The Launcher's own description: v1 JSON, plain text, or "". */
  description: string;
  blockNumber: number;
  timestamp: number | null;
  token: { address: string; symbol: string | null; graduated: boolean } | null;
}

export interface TokenRow {
  address: string;
  creator: string;
  name: string | null;
  symbol: string | null;
  /** IPFS path of the token's picture, when its metadata names one. */
  image: string | null;
  /** IPFS path of the metadata its creator pinned at launch: description and links. */
  meta: string | null;
  /** The token's pool, as its launch recorded it. */
  pool: string | null;
  quoteToken: string | null;
  totalSupply: string | null;
  initialPriceWad: string | null;
  timestamp: number | null;
  vault: string | null;
  vaultFactory: string | null;
  graduated: boolean;
  launcher: string | null;
  launcherFactory: string | null;
  /** The title the Launcher that launched it carries: what its launchpad calls its launches. */
  launcherTitle: string | null;
}

export interface LauncherFactoryRow {
  address: string;
  /** What the factory calls its launches: the title most of its Launchers carry. */
  title: string | null;
  enabled: boolean | null;
  multiplierBps: number | null;
  launchers: number;
  deployers: number;
  tokens: number;
  graduated: number;
}

export interface VaultFactoryRow {
  address: string;
  official: boolean | null;
  riskLevel: number | null;
  vaults: number;
  deployers: number;
  graduated: number;
}

export interface Factories {
  launcher: LauncherFactoryRow[];
  vault: VaultFactoryRow[];
}

export interface DeployerRow {
  address: string;
  launchers: number;
  tokens: number;
  graduated: number;
  factories: number;
  firstSeenAt: number | null;
  lastSeenAt: number | null;
}

export interface ScopeRaise {
  address: string;
  factory: string;
  creator: string;
  name: string | null;
  symbol: string | null;
  quoteToken: string | null;
  targetRaise: string | null;
  poolTokenRatio: string | null;
  /** Quote balance the Launcher holds, in base units. Null until the index has read it. */
  raised: string | null;
  raisedAt: number | null;
  timestamp: number | null;
}

export interface ScopeToken {
  address: string;
  creator: string;
  name: string | null;
  symbol: string | null;
  image: string | null;
  quoteToken: string | null;
  totalSupply: string | null;
  initialPriceWad: string | null;
  timestamp: number | null;
  graduated: boolean;
  vaultFactory: string | null;
  launcher: string | null;
  /** The Launcher Factory it came through; null when it launched straight through the Portal. */
  factory: string | null;
}

/** Everything the Memescope page shows, from /api/<chain>/scope. */
export interface Scope {
  updatedAt: number | null;
  head: number | null;
  platforms: Array<{ factory: string; title: string | null; enabled: boolean | null; launchers: number; tokens: number }>;
  quotes: Record<string, { symbol: string | null; decimals: number | null }>;
  raising: ScopeRaise[];
  launched: ScopeToken[];
}

export interface Page<T> {
  items: T[];
}

export type Loaded<T> = { state: "loading" } | { state: "error" } | { state: "ready"; data: T };

/** Fetches `/api/<chain>/<resource>`, and again every `refreshMs` when given. */
export function useApi<T>(chain: ChainKey, resource: string, refreshMs?: number): Loaded<T> {
  const [result, setResult] = useState<Loaded<T>>({ state: "loading" });
  useEffect(() => {
    let current = true;
    setResult({ state: "loading" });
    const load = () => {
      fetch(`/api/${chain}/${resource}`)
        .then((response) => (response.ok ? (response.json() as Promise<T>) : Promise.reject(new Error(String(response.status)))))
        .then(
          (data) => current && setResult({ state: "ready", data }),
          () => current && setResult((previous) => (previous.state === "ready" ? previous : { state: "error" })),
        );
    };
    load();
    const timer = refreshMs ? window.setInterval(load, refreshMs) : undefined;
    return () => {
      current = false;
      if (timer) window.clearInterval(timer);
    };
  }, [chain, resource, refreshMs]);
  return result;
}
