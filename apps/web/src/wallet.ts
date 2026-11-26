import { useSyncExternalStore } from "react";
import { createWalletClient, custom, type Address, type EIP1193Provider, type Hex, type WalletClient } from "viem";
import { NETWORK } from "./config";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

export interface WalletState {
  available: boolean;
  account: Address | null;
  chainId: number | null;
  /** A transaction this page sent that has no receipt yet. */
  pendingHash: Hex | null;
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

export function setPendingHash(hash: Hex | null) {
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

export function walletClient(): WalletClient | null {
  const provider = window.ethereum;
  return provider ? createWalletClient({ chain: NETWORK.chain, transport: custom(provider) }) : null;
}

async function refresh(request: "eth_accounts" | "eth_requestAccounts") {
  const provider = window.ethereum;
  if (!provider) return;
  const accounts = (await provider.request({ method: request })) as Address[];
  const chainId = Number(await provider.request({ method: "eth_chainId" }));
  set({ account: accounts[0] ?? null, chainId });
}

/** Asks the wallet to connect. The wallet shows its own prompt; nothing is signed here. */
export function connect(): void {
  void refresh("eth_requestAccounts").catch(() => undefined);
}

/** Asks the wallet to switch to the network this page targets, adding it first if the wallet does not know it. */
export async function switchChain(): Promise<void> {
  const provider = window.ethereum;
  if (!provider) throw new Error("walletUnavailable");
  const chainId = `0x${NETWORK.chain.id.toString(16)}` as Hex;
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
          chainName: NETWORK.label,
          nativeCurrency: NETWORK.chain.nativeCurrency,
          rpcUrls: [NETWORK.rpcUrl],
          blockExplorerUrls: [NETWORK.explorer],
        },
      ],
    });
  }
  await refresh("eth_accounts");
}

if (typeof window !== "undefined" && window.ethereum) {
  // Pick up a wallet that is already connected, and follow account and network changes.
  void refresh("eth_accounts").catch(() => undefined);
  window.ethereum.on("accountsChanged", (accounts) => set({ account: (accounts[0] as Address | undefined) ?? null }));
  window.ethereum.on("chainChanged", (chainId) => set({ chainId: Number(chainId) }));
}
