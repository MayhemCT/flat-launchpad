// The browser wallet's state, over plain EIP-1193. No chain library, so every page can show the wallet button
// without paying for one. Transactions are built in host.ts and trade.ts, which load only where they are used.
import { useSyncExternalStore } from "react";
import { FLAP_LAUNCH, type Site } from "./site";

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

/**
 * Set when the visitor disconnected here. A wallet goes on telling a site about an account it once approved,
 * so without this the page would connect again by itself on the next load.
 */
const DISCONNECTED_KEY = "callz.wallet-disconnected";

function disconnectedHere(): boolean {
  try {
    return window.localStorage.getItem(DISCONNECTED_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberDisconnected(value: boolean) {
  try {
    if (value) window.localStorage.setItem(DISCONNECTED_KEY, "1");
    else window.localStorage.removeItem(DISCONNECTED_KEY);
  } catch {
    // Without storage the choice lasts until the page is reloaded.
  }
}

async function refresh(method: "eth_accounts" | "eth_requestAccounts") {
  const provider = window.ethereum;
  if (!provider) return;
  const accounts = (await provider.request({ method })) as Array<`0x${string}`>;
  const chainId = Number(await provider.request({ method: "eth_chainId" }));
  set({ account: accounts[0] ?? null, chainId });
}

/**
 * Asks the wallet to connect. The wallet shows its own prompt; nothing is signed here. After a disconnect the
 * wallet is first asked for its permission again, which is where it lets the visitor pick another account.
 */
export function connect(): void {
  const provider = window.ethereum;
  if (!provider) return;
  const again = disconnectedHere();
  rememberDisconnected(false);
  void (async () => {
    if (again) {
      try {
        await provider.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
      } catch (cause) {
        // 4001: the visitor closed the prompt, and stays disconnected. Any other answer is a wallet without
        // this method: it is asked the plain way below.
        if ((cause as { code?: number } | null)?.code === 4001) {
          rememberDisconnected(true);
          return;
        }
      }
    }
    await refresh("eth_requestAccounts");
  })().catch(() => undefined);
}

/**
 * Disconnects the wallet from this page: the page forgets the account and stays that way across reloads, and
 * the wallet is asked to take back the permission it gave this site (wallets that cannot simply keep it; the
 * page ignores it all the same). The caller signs the session out as well, so nothing of that wallet's is
 * shown any more.
 */
export function disconnect(): void {
  rememberDisconnected(true);
  set({ account: null, pendingHash: null });
  void window.ethereum?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }).catch(() => undefined);
}

/** Text as the 0x hex of its UTF-8 bytes, the form personal_sign takes a message in. */
export function utf8Hex(text: string): string {
  let hex = "0x";
  for (const byte of new TextEncoder().encode(text)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Asks the wallet for a personal_sign signature over `text`. Throws the message to show when it does not give one. */
export async function personalSign(text: string, account: string): Promise<unknown> {
  const provider = window.ethereum;
  if (!provider) throw new Error("No browser wallet was found.");
  try {
    return await provider.request({ method: "personal_sign", params: [utf8Hex(text), account] });
  } catch (cause) {
    // 4001: the visitor closed the wallet's prompt.
    const rejected = (cause as { code?: number } | null)?.code === 4001;
    throw new Error(rejected ? "The signature request was rejected in the wallet." : "The wallet could not sign the message.");
  }
}

/** Asks the wallet to switch to `target` (the launchpad's network by default), adding it first if the wallet does not know it. */
export async function switchChain(target: Site = FLAP_LAUNCH): Promise<void> {
  const provider = window.ethereum;
  if (!provider) throw new Error("walletUnavailable");
  const chainId = `0x${target.id.toString(16)}`;
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
          chainName: target.label,
          nativeCurrency: { name: "BNB", symbol: target.unit, decimals: 18 },
          rpcUrls: [target.rpcUrl],
          blockExplorerUrls: [target.explorer],
        },
      ],
    });
  }
  await refresh("eth_accounts");
}

if (typeof window !== "undefined" && window.ethereum) {
  // Pick up a wallet that is already connected, and follow account and network changes.
  if (!disconnectedHere()) void refresh("eth_accounts").catch(() => undefined);
  else void window.ethereum.request({ method: "eth_chainId" }).then((chainId) => set({ chainId: Number(chainId) }), () => undefined);
  window.ethereum.on("accountsChanged", ((accounts: string[]) => {
    // Disconnected here: the wallet's own account changes are not this page's business until it connects again.
    if (!disconnectedHere()) set({ account: (accounts[0] as `0x${string}` | undefined) ?? null });
  }) as never);
  window.ethereum.on("chainChanged", ((chainId: string) => set({ chainId: Number(chainId) })) as never);
}
