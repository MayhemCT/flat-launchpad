// The browser wallet's state, over plain EIP-1193. No chain library, so every page can show the wallet button
// without paying for one. Transactions are built in host.ts, which loads only on the RaidPass pages.
import { useSyncExternalStore } from "react";
import { RAIDPASS } from "./site";

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  on(event: string, listener: (...args: never[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export interface WalletState {
  available: boolean;
  account: `0x${string}` | null;
  chainId: number | null;
  /** A transaction this page sent that has no receipt yet. */
  pendingHash: `0x${string}` | null;
}

let state: WalletState = {
  available: typeof window !== "undefined" && !!window.ethereum,
  account: null,
  chainId: null,
  pendingHash: null,
};
const listeners = new Set<() => void>();

function set(next: Partial<WalletState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export function setPendingHash(hash: `0x${string}` | null) {
  set({ pendingHash: hash });
}

export function getWallet(): WalletState {
  return state;
}

export function useWallet(): WalletState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

async function refresh(method: "eth_accounts" | "eth_requestAccounts") {
  const provider = window.ethereum;
  if (!provider) return;
  const accounts = (await provider.request({ method })) as Array<`0x${string}`>;
  const chainId = Number(await provider.request({ method: "eth_chainId" }));
  set({ account: accounts[0] ?? null, chainId });
}

/** Asks the wallet to connect. The wallet shows its own prompt; nothing is signed here. */
export function connect(): void {
  void refresh("eth_requestAccounts").catch(() => undefined);
}

/** Asks the wallet to switch to RaidPass's network, adding it first if the wallet does not know it. */
export async function switchChain(): Promise<void> {
  const provider = window.ethereum;
  if (!provider) throw new Error("walletUnavailable");
  const chainId = `0x${RAIDPASS.id.toString(16)}`;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (cause) {
    // 4902: the wallet does not have this chain yet.
    if ((cause as { code?: number }).code !== 4902) throw new Error("walletRejected");
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: RAIDPASS.label,
          nativeCurrency: { name: "BNB", symbol: RAIDPASS.unit, decimals: 18 },
          rpcUrls: [RAIDPASS.rpcUrl],
          blockExplorerUrls: [RAIDPASS.explorer],
        },
      ],
    });
  }
  await refresh("eth_accounts");
}

if (typeof window !== "undefined" && window.ethereum) {
  // Pick up a wallet that is already connected, and follow account and network changes.
  void refresh("eth_accounts").catch(() => undefined);
  window.ethereum.on("accountsChanged", ((accounts: string[]) => set({ account: (accounts[0] as `0x${string}` | undefined) ?? null })) as never);
  window.ethereum.on("chainChanged", ((chainId: string) => set({ chainId: Number(chainId) })) as never);
}
