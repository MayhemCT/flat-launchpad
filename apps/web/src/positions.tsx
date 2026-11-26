// The wallet's positions: tokens from the board it holds on BNB Chain, each with what selling all of it would
// return right now, and a button that sells it. Opens from the wallet button; loaded on first use, because it
// reads balances and trades through the chain library.
import { useCallback, useEffect, useState } from "react";
import type { Address, Hex } from "viem";
import { amount, short } from "./format";
import { TokenImage } from "./scope";
import { SITES } from "./site";
import { TradeError, heldTokens, loadMarket, quoteSell, rememberedTokens, sell, type Market, type TradeStep } from "./trade";
import { switchChain } from "./wallet";

const SITE = SITES.bsc;
/** Slippage for a sell from this menu, on top of the token's own tax. In basis points. */
const SELL_SLIPPAGE_BPS = 500;
const STEP_TEXT: Record<TradeStep, string> = {
  pricing: "Pricing…",
  approving: "Approve in your wallet…",
  checking: "Checking…",
  confirm: "Confirm in your wallet…",
  pending: "Confirming…",
};

interface Indexed {
  address: string;
  symbol: string | null;
  name: string | null;
  image: string | null;
}
interface Position {
  token: Address;
  symbol: string;
  image: string | null;
  balance: bigint;
  decimals: number;
  market: Market | null;
  /** BNB that selling the whole balance returns now, after the token's tax. Null when it has no pool. */
  worth: bigint | null;
}
type Note = { kind: "working" | "done" | "error"; symbol: string; text: string; hash?: Hex };

async function loadPositions(account: Address): Promise<Position[]> {
  // The board's launched tokens, plus any token this browser bought through the site.
  const indexed = await fetch("/api/bsc/tokens?limit=200")
    .then((response) => (response.ok ? (response.json() as Promise<{ items: Indexed[] }>) : { items: [] }))
    .catch(() => ({ items: [] as Indexed[] }));
  const known = new Map(indexed.items.map((token) => [token.address.toLowerCase(), token]));
  const candidates = [...new Set([...known.keys(), ...rememberedTokens()])] as Address[];
  const held = await heldTokens(account, candidates);
  return Promise.all(
    held.map(async ({ token, balance }): Promise<Position> => {
      const row = known.get(token.toLowerCase());
      try {
        const market = await loadMarket(token);
        const quote = await quoteSell(market, balance).catch(() => null);
        return { token, symbol: row?.symbol || market.symbol || short(token), image: row?.image ?? null, balance, decimals: market.decimals, market, worth: quote?.amountOut ?? null };
      } catch {
        return { token, symbol: row?.symbol || short(token), image: row?.image ?? null, balance, decimals: 18, market: null, worth: null };
      }
    }),
  );
}

export default function Positions({ account, chainId, onNavigate }: { account: Address; chainId: number | null; onNavigate(): void }) {
  const [positions, setPositions] = useState<Position[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [notes, setNotes] = useState<Record<string, Note>>({});
  const onChain = chainId === SITE.id;

  const reload = useCallback(() => {
    loadPositions(account).then(
      (next) => {
        setPositions(next.sort((a, b) => ((b.worth ?? 0n) > (a.worth ?? 0n) ? 1 : -1)));
        setFailed(false);
      },
      () => setFailed(true),
    );
  }, [account]);
  useEffect(reload, [reload]);

  const sellAll = async (position: Position) => {
    if (!position.market) return;
    const note = (next: Omit<Note, "symbol">) => setNotes((all) => ({ ...all, [position.token]: { ...next, symbol: position.symbol } }));
    note({ kind: "working", text: "Starting…" });
    try {
      const { hash } = await sell({
        market: position.market,
        account,
        amountIn: position.balance,
        slippageBps: SELL_SLIPPAGE_BPS,
        onStep: (step, hash) => note({ kind: "working", text: STEP_TEXT[step], hash }),
      });
      note({ kind: "done", text: "Sold.", hash });
      reload();
    } catch (cause) {
      const failure = cause instanceof TradeError ? cause : new TradeError("NETWORK", "Not sold", "The sale could not be completed. Check your wallet's activity before trying again.");
      note({ kind: "error", text: `${failure.title}. ${failure.message}`, hash: failure.hash });
    }
  };

  return (
    <div className="positions" data-testid="positions" role="dialog" aria-label="Your positions">
      <p className="positions-head">
        <strong>Positions</strong>
        <span className="dim num">{short(account)}</span>
      </p>
      {!onChain && (
        <p className="positions-note">
          Positions and selling are on BNB Chain.{" "}
          <button type="button" className="button button-warn" onClick={() => void switchChain(SITE).catch(() => undefined)}>Switch to BNB Chain</button>
        </p>
      )}
      {positions === null && !failed && <p className="positions-note" role="status">Reading your balances…</p>}
      {failed && positions === null && <p className="positions-note" role="alert">BNB Chain could not be reached. Close and open this to try again.</p>}
      {/* A position sold in full leaves the list: what happened to it stays here. */}
      {positions !== null &&
        Object.entries(notes)
          .filter(([token]) => !positions.some((position) => position.token === token))
          .map(([token, note]) => (
            <p key={token} className={`positions-outcome trade-${note.kind}`} role={note.kind === "error" ? "alert" : "status"}>
              <strong>{note.symbol}:</strong> {note.text} {note.hash && <a href={`${SITE.explorer}/tx/${note.hash}`} target="_blank" rel="noreferrer">View ↗</a>}
            </p>
          ))}
      {positions !== null && positions.length === 0 && <p className="positions-note" data-testid="positions-empty">No tokens from the board in this wallet{Object.keys(notes).length > 0 ? " now" : " yet"}.</p>}
      {positions !== null && positions.length > 0 && (
        <ul className="positions-list">
          {positions.map((position) => {
            const note = notes[position.token];
            return (
              <li key={position.token}>
                <a className="positions-token" href={`#/token/${position.token.toLowerCase()}`} onClick={onNavigate}>
                  <TokenImage key={position.image ?? "none"} image={position.image} label={position.symbol} colour="var(--line)" size={36} />
                  <span>
                    <strong>{position.symbol}</strong>
                    <span className="dim num">{amount(position.balance, 2, position.decimals)}{position.worth !== null ? ` · ≈ ${amount(position.worth, 5)} BNB` : " · no pool"}</span>
                  </span>
                </a>
                <button type="button" className="positions-sell" disabled={!onChain || !position.market || note?.kind === "working"} onClick={() => void sellAll(position)}>
                  Sell all
                </button>
                {note && (
                  <p className={`positions-outcome trade-${note.kind}`} role={note.kind === "error" ? "alert" : "status"}>
                    {note.text} {note.hash && <a href={`${SITE.explorer}/tx/${note.hash}`} target="_blank" rel="noreferrer">View ↗</a>}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="positions-foot dim">Tokens from the board, and ones bought here, that this wallet holds on BNB Chain. "Sell all" goes through PancakeSwap with 5% slippage; your wallet asks you to confirm.</p>
    </div>
  );
}
