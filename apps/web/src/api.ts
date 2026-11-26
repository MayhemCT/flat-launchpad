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
  quoteToken: string | null;
  totalSupply: string | null;
  initialPriceWad: string | null;
  timestamp: number | null;
  vault: string | null;
  vaultFactory: string | null;
  graduated: boolean;
  launcher: string | null;
  launcherFactory: string | null;
}

export interface LauncherFactoryRow {
  address: string;
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
