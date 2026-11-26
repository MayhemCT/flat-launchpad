// One-click buys from the board: the ⚡ button on a launched token.
//
// The same engine and checks as the token page's trade panel (trade.ts): the token's own PancakeSwap pool,
// priced by PancakeSwap's router with the token's tax taken off, simulated before the wallet opens, then
// followed to a definite outcome. The wallet still shows the transaction for the buyer to confirm.
// The trading code loads the first time it is used, so the board itself stays light.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { SITES } from "./site";
import { connect, getWallet, switchChain } from "./wallet";

export const QUICK_AMOUNTS = ["0.01", "0.05", "0.1", "0.5"] as const;
const DEFAULT_AMOUNT = "0.05";
/** Slippage for one-click buys, on top of the token's own tax. In basis points. */
const QUICK_SLIPPAGE_BPS = 500;
const AMOUNT_KEY = "callz.quickBuy.amount";
const CONSENT_KEY = "callz.quickBuy.accepted";

interface Target {
  address: string;
  symbol: string | null;
}
interface Toast {
  id: number;
  kind: "working" | "done" | "error";
  title: string;
  text: string;
  hash?: string;
  token?: string;
}

export interface QuickBuy {
  amount: string;
  setAmount(next: string): void;
  /** Tokens with a buy in flight. */
  buying: ReadonlySet<string>;
  buy(target: Target): void;
  /** The consent dialog and the progress messages: render once on the page. */
  layer: ReactNode;
}

const stored = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null; // storage blocked: fall back to the defaults
  }
};
const store = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // storage blocked: the choice lasts for this visit
  }
};

/** "0.05" as wei, without a chain library. */
function toWei(text: string): bigint {
  const [whole = "0", fraction = ""] = text.split(".");
  return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0").slice(0, 18));
}

export function useQuickBuy(): QuickBuy {
  const [amount, setAmountState] = useState<string>(DEFAULT_AMOUNT);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [buying, setBuying] = useState<ReadonlySet<string>>(new Set());
  const [asking, setAsking] = useState<Target | null>(null);
  const nextId = useRef(0);

  useEffect(() => {
    const saved = stored(AMOUNT_KEY);
    if (saved && (QUICK_AMOUNTS as readonly string[]).includes(saved)) setAmountState(saved);
  }, []);

  const setAmount = useCallback((next: string) => {
    setAmountState(next);
    store(AMOUNT_KEY, next);
  }, []);

  const patch = (id: number, next: Partial<Toast>) => setToasts((all) => all.map((toast) => (toast.id === id ? { ...toast, ...next } : toast)));
  const drop = (id: number) => setToasts((all) => all.filter((toast) => toast.id !== id));

  const run = useCallback(
    async (target: Target) => {
      const id = ++nextId.current;
      const symbol = target.symbol || "token";
      const title = `${amount} BNB of ${symbol}`;
      setToasts((all) => [...all.slice(-3), { id, kind: "working", title, text: "Starting…", token: target.address }]);
      setBuying((all) => new Set(all).add(target.address));
      try {
        if (!window.ethereum) throw new Error("No browser wallet found. Install MetaMask, Rabby or another wallet to buy here.");
        let wallet = getWallet();
        if (!wallet.account) {
          patch(id, { text: "Connect your wallet…" });
          const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as string[];
          connect();
          if (!accounts[0]) throw new Error("No wallet account was connected. Nothing was sent.");
        }
        if (Number(await window.ethereum.request({ method: "eth_chainId" })) !== SITES.bsc.id) {
          patch(id, { text: "Switch to BNB Chain in your wallet…" });
          await switchChain(SITES.bsc);
        }
        wallet = getWallet();
        const account = wallet.account ?? (((await window.ethereum.request({ method: "eth_accounts" })) as Array<`0x${string}`>)[0] ?? null);
        if (!account) throw new Error("No wallet account was connected. Nothing was sent.");

        const { buy, loadMarket } = await import("./trade");
        patch(id, { text: "Finding the pool…" });
        const market = await loadMarket(target.address as `0x${string}`);
        const steps = { pricing: "Pricing the pool…", approving: "Approve in your wallet…", checking: "Checking the trade on BNB Chain…", confirm: "Confirm the buy in your wallet…", pending: "Waiting for confirmation…" } as const;
        const { hash } = await buy({ market, account, amountIn: toWei(amount), slippageBps: QUICK_SLIPPAGE_BPS, onStep: (step, hash) => patch(id, { text: steps[step], hash }) });
        patch(id, { kind: "done", text: "Bought. The trade confirmed on BNB Chain.", hash });
        window.setTimeout(() => drop(id), 12_000);
      } catch (cause) {
        const failure = cause as { title?: string; message?: string; hash?: string; code?: number };
        const text = failure.code === 4001 ? "You cancelled the request in your wallet. Nothing was sent." : failure.message ?? "The buy could not be completed. Nothing was sent.";
        patch(id, { kind: "error", title: failure.title ? `${failure.title}: ${title}` : title, text, hash: failure.hash });
        window.setTimeout(() => drop(id), 14_000);
      } finally {
        setBuying((all) => {
          const next = new Set(all);
          next.delete(target.address);
          return next;
        });
      }
    },
    [amount],
  );

  const buy = useCallback(
    (target: Target) => {
      if (stored(CONSENT_KEY) === "1") void run(target);
      else setAsking(target);
    },
    [run],
  );

  const layer = (
    <>
      {asking && (
        <div className="quick-consent" role="dialog" aria-modal="true" aria-labelledby="quick-consent-title">
          <div>
            <h2 id="quick-consent-title">One-click buys</h2>
            <p>
              The ⚡ button buys <strong>{amount} BNB</strong> of a token straight away, through PancakeSwap, with 5% slippage on top of the
              token's own tax. Your wallet still asks you to confirm each buy.
            </p>
            <p>Anyone can launch a token, and many are worth nothing. Open a token's page to check it first. Each buy carries the CallZ fee (2% of the BNB), which goes to the rewards vault. CallZ never holds your funds.</p>
            <div className="actions">
              <button
                type="button"
                className="button"
                onClick={() => {
                  store(CONSENT_KEY, "1");
                  const target = asking;
                  setAsking(null);
                  void run(target);
                }}
              >
                Turn on and buy
              </button>
              <button type="button" className="button button-quiet" onClick={() => setAsking(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      <div className="toasts" aria-live="polite">
        {toasts.map((toast) => (
          <p key={toast.id} className={`toast toast-${toast.kind}`}>
            <strong>{toast.title}</strong>
            <span>{toast.text}</span>
            {toast.hash && <a href={`${SITES.bsc.explorer}/tx/${toast.hash}`} target="_blank" rel="noreferrer">View transaction ↗</a>}
            {toast.kind === "error" && toast.token && <a href={`#/token/${toast.token}`}>Open the token's page →</a>}
          </p>
        ))}
      </div>
    </>
  );

  return { amount, setAmount, buying, buy, layer };
}
