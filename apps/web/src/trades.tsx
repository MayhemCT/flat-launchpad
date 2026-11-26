// A token's latest trades, read from its PancakeSwap pool's own Swap events and shown in the site's style.
import { useEffect, useRef, useState } from "react";
import { amount } from "./format";
import { SITES } from "./site";
import { poolTrades, type Market, type PoolTrade } from "./trade";

const SITE = SITES.bsc;
const SHOWN = 40;

/** "12s", "4m", "3h": how long ago, from unix seconds. */
function since(time: number, now: number): string {
  const seconds = Math.max(0, Math.floor(now / 1000) - time);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/** Quote per token, to four significant figures. Display only. */
function priceOf(trade: PoolTrade, decimals: number): string {
  if (trade.tokenAmount === 0n) return "—";
  const value = (Number(trade.quoteAmount) / 1e18) / (Number(trade.tokenAmount) / 10 ** decimals);
  return value >= 1 ? value.toLocaleString("en", { maximumFractionDigits: 4 }) : value.toPrecision(4).replace(/\.?0+$/, "");
}

export function TradesTable({ market, dexScreenerUrl }: { market: Market; dexScreenerUrl: string }) {
  const [trades, setTrades] = useState<PoolTrade[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(Date.now());
  const latest = useRef<bigint | null>(null);

  useEffect(() => {
    let current = true;
    latest.current = null;
    setTrades(null);
    const load = () =>
      poolTrades(market, latest.current, SHOWN).then(
        ({ trades: fresh, head }) => {
          if (!current) return;
          latest.current = head;
          setFailed(false);
          setNow(Date.now());
          setTrades((previous) => [...fresh, ...(previous ?? [])].slice(0, SHOWN));
        },
        () => current && setFailed(true),
      );
    void load();
    const timer = window.setInterval(load, 12_000);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [market.pair, market.token]);

  return (
    <section className="token-trades" data-testid="token-trades" aria-label="Trades">
      <div className="token-chart-head">
        <h2>Trades</h2>
        <span className="live">LIVE</span>
      </div>
      {trades === null && !failed && <p className="token-nochart dim" role="status">Reading the pool's trades…</p>}
      {trades === null && failed && <p className="token-nochart dim" role="alert">The pool's trades could not be read right now.</p>}
      {trades !== null && trades.length === 0 && (
        <p className="token-nochart dim">No trades in the last few hours. <a href={dexScreenerUrl} target="_blank" rel="noreferrer">Older trades on DexScreener ↗</a></p>
      )}
      {trades !== null && trades.length > 0 && (
        <div className="trades-wrap">
          <table className="trades">
            <thead>
              <tr><th>Age</th><th>Side</th><th>{market.symbol || "Token"}</th><th>{market.quote}</th><th className="trades-wide">Price</th><th>Tx</th></tr>
            </thead>
            <tbody>
              {trades.map((trade) => (
                <tr key={`${trade.hash}-${trade.logIndex}`} data-side={trade.side}>
                  <td className="num dim">{since(trade.time, now)}</td>
                  <td><strong>{trade.side === "buy" ? "Buy" : "Sell"}</strong></td>
                  <td className="num">{amount(trade.tokenAmount, 2, market.decimals)}</td>
                  <td className="num">{amount(trade.quoteAmount, 4)}</td>
                  <td className="num trades-wide">{priceOf(trade, market.decimals)}</td>
                  <td><a href={`${SITE.explorer}/tx/${trade.hash}`} target="_blank" rel="noreferrer" aria-label="Transaction on BscScan">↗</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
