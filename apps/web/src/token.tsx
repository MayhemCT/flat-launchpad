// One token's page: its chart, its market, a way to trade it, its links and what its team says about it.
// The chart and market numbers come from DexScreener; taxes, the pool and every trade come from the chain,
// through PancakeSwap (trade.ts). Loaded on demand, because trading needs a chain library.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { formatUnits, parseUnits, type Address, type Hex } from "viem";
import { useApi, type Page, type TokenRow } from "./api";
import { TokenChat } from "./chat";
import { chartEmbedUrl, dexPaidStatus, pairLinks, pairPageUrl, tokenPairs, venueName, type DsPair, type TokenLink } from "./dexscreener";
import { ago, amount, short, usd } from "./format";
import { platformOf } from "./platform";
import { QUICK_AMOUNTS, useQuickBuy } from "./quickbuy";
import { PlatformTag, TokenImage } from "./scope";
import { SITES, explorerAddressUrl, flapTokenUrl } from "./site";
import { TradeError, balances, buy, loadMarket, quoteBuy, quoteSell, sell, type Market, type Quote, type TradeStep } from "./trade";
import { TradesTable } from "./trades";
import { connect, switchChain, useWallet } from "./wallet";

const SITE = SITES.bsc;
const INTERVALS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "5", label: "5m" },
  { id: "15", label: "15m" },
  { id: "60", label: "1h" },
  { id: "240", label: "4h" },
  { id: "1D", label: "1D" },
];
const BUY_PRESETS = ["0.01", "0.05", "0.1", "0.5"];
const SELL_PRESETS = [25, 50, 75, 100];
const SLIPPAGES = [100, 300, 500, 1000];
/** DexScreener's embed ends in a footer bar; the frame is this much taller than its window so it is clipped. */
const FOOTER_CROP = 42;
const STEP_TEXT: Record<TradeStep, string> = {
  pricing: "Pricing the pool…",
  approving: "Approve the exact amount in your wallet…",
  checking: "Checking the trade on BNB Chain…",
  confirm: "Confirm in your wallet…",
  pending: "Waiting for confirmation…",
};

/** A token's own metadata, as its creator pinned it on IPFS when launching through Flap. */
interface TokenMeta {
  description?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
}

function useDexScreener(token: string) {
  const [pairs, setPairs] = useState<DsPair[] | null>(null);
  const [paid, setPaid] = useState<"paid" | "review" | "no" | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    const load = () => tokenPairs(token, abort.signal).then(setPairs, () => setPairs((previous) => previous ?? []));
    void load();
    dexPaidStatus(token, abort.signal).then(setPaid, () => undefined);
    const timer = window.setInterval(load, 30_000);
    return () => {
      abort.abort();
      window.clearInterval(timer);
    };
  }, [token]);
  return { pairs, paid };
}

function useMarket(token: Address) {
  const [state, setState] = useState<{ market: Market | null; error: string | null; loading: boolean }>({ market: null, error: null, loading: true });
  const reload = useCallback(() => {
    loadMarket(token).then(
      (market) => setState({ market, error: null, loading: false }),
      (error) => setState((previous) => ({ market: previous.market, error: error instanceof TradeError ? error.message : "BNB Chain could not be reached. Reload to try again.", loading: false })),
    );
  }, [token]);
  useEffect(() => {
    setState({ market: null, error: null, loading: true });
    reload();
    const timer = window.setInterval(reload, 20_000);
    return () => window.clearInterval(timer);
  }, [reload]);
  return { ...state, reload };
}

/** Only plain https links leave this page, and only to where their text says they go. */
function httpsUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password && url.hostname.includes(".") ? url : null;
  } catch {
    return null;
  }
}

/** Links from the token's own metadata: a full https address, or an X or Telegram handle. */
function metaLinks(meta: TokenMeta | null): TokenLink[] {
  if (!meta) return [];
  const links: TokenLink[] = [];
  const site = meta.website ? httpsUrl(meta.website.trim()) : null;
  if (site) links.push({ kind: "website", label: site.hostname.replace(/^www\./, ""), url: site.href });
  const handle = (value: string | undefined, pattern: RegExp, base: string, kind: "x" | "telegram", label: string) => {
    if (!value) return;
    const text = value.trim();
    const url = httpsUrl(text);
    if (url) links.push({ kind, label, url: url.href });
    else if (pattern.test(text.replace(/^@/, ""))) links.push({ kind, label, url: `${base}${text.replace(/^@/, "")}` });
  };
  handle(meta.twitter, /^[A-Za-z0-9_]{1,15}$/, "https://x.com/", "x", "X");
  handle(meta.telegram, /^[A-Za-z0-9_]{5,32}$/, "https://t.me/", "telegram", "Telegram");
  return links;
}

function DexPaid({ status }: { status: "paid" | "review" | "no" | null }) {
  if (status === null) return null;
  if (status === "no") return <span className="tag tag-warn" title="No paid DexScreener profile for this token yet">Dex not paid</span>;
  return (
    <span className="tag tag-good" title={status === "paid" ? "The token's DexScreener profile is paid and live" : "DexScreener profile paid; DexScreener is reviewing it"}>
      ✓ Dex paid{status === "review" ? " · in review" : ""}
    </span>
  );
}

function Stat({ label, children, tone }: { label: string; children: ReactNode; tone?: "good" | "warn" }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={`num${tone ? ` tone-${tone}` : ""}`}>{children}</dd>
    </div>
  );
}

type Side = "buy" | "sell";
interface Outcome {
  kind: "working" | "done" | "error";
  title: string;
  text: string;
  hash?: Hex;
}

function TradePanel({ market, error, loading, onTraded }: { market: Market | null; error: string | null; loading: boolean; onTraded(): void }) {
  const wallet = useWallet();
  const [side, setSide] = useState<Side>("buy");
  const [text, setText] = useState("");
  const [slippage, setSlippage] = useState(500);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [held, setHeld] = useState<{ bnb: bigint; token: bigint } | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const busy = outcome?.kind === "working";
  const onChain = wallet.chainId === SITE.id;
  const account = wallet.account;

  const loadHeld = useCallback(() => {
    if (market && account) balances(market, account).then(setHeld, () => undefined);
    else setHeld(null);
  }, [market, account]);
  useEffect(loadHeld, [loadHeld]);

  const decimals = side === "buy" ? 18 : market?.decimals ?? 18;
  const amountIn = useMemo(() => {
    if (!/^\d*\.?\d+$/.test(text.trim())) return null;
    try {
      const value = parseUnits(text.trim(), decimals);
      return value > 0n ? value : null;
    } catch {
      return null;
    }
  }, [text, decimals]);

  // Price the amount shortly after typing stops, and again every ten seconds while it stands.
  useEffect(() => {
    setQuote(null);
    if (!market || amountIn === null) return;
    let current = true;
    const price = () => (side === "buy" ? quoteBuy(market, amountIn) : quoteSell(market, amountIn)).then((next) => current && setQuote(next), () => current && setQuote(null));
    const first = window.setTimeout(price, 350);
    const timer = window.setInterval(price, 10_000);
    return () => {
      current = false;
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [market, amountIn, side]);

  const balance = held ? (side === "buy" ? held.bnb : held.token) : null;
  const short_ = amountIn !== null && balance !== null && amountIn > balance;
  const symbol = market?.symbol || "token";
  const tax = market ? (side === "buy" ? market.buyTaxBps : market.sellTaxBps) : 0;

  const submit = async () => {
    if (!market || !account || amountIn === null) return;
    setOutcome({ kind: "working", title: side === "buy" ? "Buying" : "Selling", text: "Starting…" });
    try {
      const run = side === "buy" ? buy : sell;
      const { hash } = await run({
        market,
        account,
        amountIn,
        slippageBps: slippage,
        onStep: (step, hash) => setOutcome({ kind: "working", title: side === "buy" ? "Buying" : "Selling", text: STEP_TEXT[step], hash }),
      });
      setOutcome({ kind: "done", title: side === "buy" ? "Bought" : "Sold", text: "The trade confirmed on BNB Chain.", hash });
      setText("");
      loadHeld();
      onTraded();
    } catch (cause) {
      const failure = cause instanceof TradeError ? cause : new TradeError("NETWORK", "Something went wrong", "The trade could not be completed. Check your wallet's activity before trying again.");
      setOutcome({ kind: "error", title: failure.title, text: failure.message, hash: failure.hash });
      loadHeld();
    }
  };

  const preset = (value: string | number) => {
    if (typeof value === "string") setText(value);
    else if (held && market) setText(formatUnits((held.token * BigInt(value)) / 100n, market.decimals));
  };

  let action: ReactNode;
  if (!wallet.available) action = <p className="trade-note">No browser wallet found. Install MetaMask, Rabby or another wallet to trade here.</p>;
  else if (!account) action = <button type="button" className="button trade-go" onClick={connect}>Connect wallet</button>;
  else if (!onChain) action = <button type="button" className="button button-warn trade-go" onClick={() => void switchChain(SITE).catch(() => undefined)}>Switch to BNB Chain</button>;
  else {
    action = (
      <button type="button" className="button trade-go" data-side={side} disabled={busy || !market || amountIn === null || quote === null || short_} onClick={() => void submit()}>
        {short_ ? `Not enough ${side === "buy" ? "BNB" : symbol}` : side === "buy" ? `Buy ${symbol}` : `Sell ${symbol}`}
      </button>
    );
  }

  return (
    <section className="trade-panel" data-testid="trade-panel" aria-label="Trade">
      <div className="seg trade-sides" role="group" aria-label="Side">
        <button type="button" aria-pressed={side === "buy"} onClick={() => { setSide("buy"); setText(""); setOutcome(null); }}>Buy</button>
        <button type="button" aria-pressed={side === "sell"} onClick={() => { setSide("sell"); setText(""); setOutcome(null); }}>Sell</button>
      </div>

      {loading && !market && <p className="trade-note" role="status">Finding the pool…</p>}
      {!market && error && <p className="trade-note" role="alert">{error}</p>}

      <label className="trade-amount">
        <span className="stat-label">{side === "buy" ? "You pay" : "You sell"}</span>
        <span className="trade-input">
          <input name="amount" inputMode="decimal" autoComplete="off" placeholder="0.0" value={text} disabled={!market || busy} onChange={(event) => setText(event.target.value.replace(",", "."))} />
          <span className="num">{side === "buy" ? "BNB" : symbol}</span>
        </span>
      </label>
      <div className="trade-presets" role="group" aria-label="Amount">
        {(side === "buy" ? BUY_PRESETS : SELL_PRESETS).map((value) => (
          <button key={value} type="button" disabled={!market || busy || (side === "sell" && !held)} onClick={() => preset(value)}>{typeof value === "string" ? value : `${value}%`}</button>
        ))}
      </div>
      {held && market && (
        <p className="trade-held dim num">
          Balance {amount(held.bnb, 4)} BNB · {amount(held.token, 2, market.decimals)} {symbol}
        </p>
      )}

      <dl className="trade-quote">
        <div>
          <dt>You receive</dt>
          <dd className="num">{quote && market ? `≈ ${amount(quote.amountOut, side === "buy" ? 2 : 5, side === "buy" ? market.decimals : 18)} ${side === "buy" ? symbol : "BNB"}` : "—"}</dd>
        </div>
        <div>
          <dt>Minimum, or the trade is not sent</dt>
          <dd className="num">{quote && market ? `${amount((quote.amountOut * BigInt(10_000 - slippage)) / 10_000n, side === "buy" ? 2 : 5, side === "buy" ? market.decimals : 18)} ${side === "buy" ? symbol : "BNB"}` : "—"}</dd>
        </div>
        <div>
          <dt>Price impact</dt>
          <dd className={`num${quote && quote.impactBps >= 1500 ? " tone-warn" : ""}`}>{quote ? `${(quote.impactBps / 100).toFixed(2)}%` : "—"}</dd>
        </div>
        <div>
          <dt>Token's own {side} tax</dt>
          <dd className="num">{market ? `${tax / 100}%` : "—"}</dd>
        </div>
      </dl>

      <div className="trade-slippage">
        <span className="stat-label">Slippage</span>
        <div className="seg seg-small" role="group" aria-label="Slippage">
          {SLIPPAGES.map((value) => (
            <button key={value} type="button" aria-pressed={slippage === value} onClick={() => setSlippage(value)}>{value / 100}%</button>
          ))}
        </div>
      </div>

      {action}

      {outcome && (
        <p className={`trade-outcome trade-${outcome.kind}`} role={outcome.kind === "error" ? "alert" : "status"}>
          <strong>{outcome.title}.</strong> {outcome.text}{" "}
          {outcome.hash && <a href={`${SITE.explorer}/tx/${outcome.hash}`} target="_blank" rel="noreferrer">View transaction ↗</a>}
        </p>
      )}
      <p className="trade-foot dim">
        Sent from your wallet straight to PancakeSwap's router{market ? `, through the ${market.quote} pool` : ""}. CallZ adds no fee and never holds your funds. Anyone can launch a token: check it before you buy.
      </p>
    </section>
  );
}

/** Opens a token's chart and chat in a small window of their own. Each token gets its own, so several can be open at once. */
function popOut(token: string) {
  window.open(`${window.location.origin}/#/pop/${token}`, `callz-pop-${token}`, "popup,width=440,height=780");
}

/**
 * The pop-out window: the chart on top, the chat under it, and a one-click buy. Clicking its title brings the
 * token's full page back in the window it was opened from.
 */
export function PopPage({ address }: { address: string }) {
  const token = address.toLowerCase() as Address;
  const indexed = useApi<Page<TokenRow>>("bsc", `tokens?address=${token}`);
  const row = indexed.state === "ready" ? indexed.data.items[0] ?? null : null;
  const { pairs } = useDexScreener(token);
  const { market } = useMarket(token);
  const quick = useQuickBuy();
  const pair = pairs?.find((candidate) => candidate.baseToken.address.toLowerCase() === token) ?? pairs?.[0] ?? null;
  const symbol = row?.symbol || market?.symbol || pair?.baseToken.symbol || short(token);
  const change = pair?.priceChange?.h24;
  const chartId = pair?.pairAddress ?? market?.pair ?? null;

  useEffect(() => {
    document.title = `${symbol} · CallZ`;
  }, [symbol]);

  const expand = () => {
    const page = `#/token/${token}`;
    try {
      // Back to the window this one was opened from, when it is still there.
      if (window.opener && !window.opener.closed) {
        window.opener.location.hash = page;
        window.opener.focus();
        window.close();
        return;
      }
    } catch {
      // The opener has gone elsewhere: open the page here instead.
    }
    window.location.hash = page;
  };

  return (
    <div className="pop" data-testid="pop-page">
      <header className="pop-head">
        <button type="button" className="pop-title" onClick={expand} title="Open this token's full page">
          <TokenImage key={row?.image ?? "none"} image={row?.image ?? null} label={symbol} colour="var(--gold)" size={36} />
          <span>
            <strong>{symbol}</strong>
            <span className="num dim">
              {pair?.priceUsd ? usd(Number(pair.priceUsd)) : "—"}
              {change !== undefined && <span className={change >= 0 ? "tone-good" : "tone-warn"}> {change >= 0 ? "+" : ""}{change.toFixed(1)}%</span>}
            </span>
          </span>
          <span className="pop-expand">Full page ⤢</span>
        </button>
        <div className="pop-buy">
          <select aria-label="One-click buy amount" value={quick.amount} onChange={(event) => quick.setAmount(event.target.value)}>
            {QUICK_AMOUNTS.map((value) => <option key={value} value={value}>{value} BNB</option>)}
          </select>
          <button type="button" className="quick-buy" disabled={quick.buying.has(token)} onClick={() => quick.buy({ address: token, symbol })}>
            {quick.buying.has(token) ? "…" : "⚡ Buy"}
          </button>
        </div>
      </header>
      <div className="pop-chart">
        {chartId ? (
          <iframe key={chartId} title={`${symbol} price chart`} src={chartEmbedUrl(chartId, "5")} referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin" />
        ) : (
          <p className="token-nochart dim">No pool yet.</p>
        )}
      </div>
      <TokenChat chain="bsc" token={token} />
      {quick.layer}
    </div>
  );
}

export default function TokenPage({ address, mobile }: { address: string; mobile: boolean }) {
  const token = address.toLowerCase() as Address;
  const indexed = useApi<Page<TokenRow>>("bsc", `tokens?address=${token}`);
  const row = indexed.state === "ready" ? indexed.data.items[0] ?? null : null;
  const { pairs, paid } = useDexScreener(token);
  const { market, error, loading, reload } = useMarket(token);
  const [interval, setIntervalId] = useState("15");
  const [meta, setMeta] = useState<TokenMeta | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef(0);

  // The token's own description and links, from the metadata its creator pinned at launch.
  useEffect(() => {
    setMeta(null);
    if (!row?.meta) return;
    let current = true;
    fetch(`/api/meta/${row.meta}`)
      .then((response) => (response.ok ? (response.json() as Promise<TokenMeta>) : null))
      .then((value) => current && setMeta(value), () => undefined);
    return () => {
      current = false;
    };
  }, [row?.meta]);

  const pair = useMemo(() => pairs?.find((candidate) => candidate.baseToken.address.toLowerCase() === token) ?? pairs?.[0] ?? null, [pairs, token]);
  const links = useMemo(() => {
    const seen = new Set<string>();
    return [...metaLinks(meta), ...pairLinks(pairs, token)].filter((link) => !seen.has(link.url) && seen.add(link.url));
  }, [meta, pairs, token]);
  const platform = useMemo(() => platformOf(SITE, row?.launcherFactory ?? null, new Map([[row?.launcherFactory ?? "", row?.launcherTitle ?? null]])), [row]);

  const name = row?.name || market?.name || pair?.baseToken.name || short(token);
  const symbol = row?.symbol || market?.symbol || pair?.baseToken.symbol || "";
  const change = pair?.priceChange?.h24;
  const trades = pair?.txns?.h24;
  const chartId = pair?.pairAddress ?? market?.pair ?? null;
  const chartHeight = mobile ? 380 : 480;

  const copy = () => {
    void navigator.clipboard?.writeText(token).then(() => {
      setCopied(true);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1400);
    });
  };

  return (
    <div className="token-page" data-testid="token-page">
      <header className="token-head">
        <TokenImage key={row?.image ?? "none"} image={row?.image ?? null} label={symbol || name} colour={platform.colour} size={64} />
        <div className="token-title">
          <h1>{name} <span className="dim">{symbol}</span></h1>
          <p className="token-tags">
            {row && <PlatformTag platform={platform} />}
            {row && <span className={`tag tag-${row.graduated ? "good" : "muted"}`}>{row.graduated ? "Graduated" : "Live"}</span>}
            <DexPaid status={paid} />
            {pair && <span className="dim">{venueName(pair)}</span>}
            {row?.timestamp ? <span className="dim">launched {ago(row.timestamp)}</span> : null}
          </p>
        </div>
        <div className="token-actions">
          <button type="button" className="button button-quiet" onClick={copy} title={token}>{copied ? "Copied" : <><code>{short(token)}</code>&nbsp;Copy</>}</button>
          <button type="button" className="button button-quiet" data-testid="pop-out" title="Open the chart and chat in a small window of their own" onClick={() => popOut(token)}>Pop out ⧉</button>
          {market && row?.graduated && <a className="button button-quiet" href={`#/pool/${token}`}>Add liquidity</a>}
          <a className="button button-flap" href={flapTokenUrl(SITE, token)} target="_blank" rel="noreferrer">Flap ↗</a>
          <a className="button button-quiet" href={pairPageUrl(pair, chartId ?? token)} target="_blank" rel="noreferrer">DexScreener ↗</a>
          <a className="button button-quiet" href={explorerAddressUrl(SITE, token)} target="_blank" rel="noreferrer">BscScan ↗</a>
        </div>
      </header>

      <dl className="stats token-stats" data-testid="token-stats">
        <Stat label="Price">{pair?.priceUsd ? usd(Number(pair.priceUsd)) : "—"}</Stat>
        <Stat label="Market cap">{pair?.marketCap ?? pair?.fdv ? usd(pair.marketCap ?? pair.fdv ?? 0) : "—"}</Stat>
        <Stat label="Liquidity">{pair?.liquidity?.usd !== undefined ? usd(pair.liquidity.usd) : "—"}</Stat>
        <Stat label="24h volume">{pair?.volume?.h24 !== undefined ? usd(pair.volume.h24) : "—"}</Stat>
        <Stat label="24h change" tone={change === undefined ? undefined : change >= 0 ? "good" : "warn"}>{change === undefined ? "—" : `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`}</Stat>
        <Stat label="24h trades">{trades ? <>{trades.buys + trades.sells} <span className="tone-good">{trades.buys}</span>/<span className="tone-warn">{trades.sells}</span></> : "—"}</Stat>
        <Stat label="Buy / sell tax">{market ? `${market.buyTaxBps / 100}% / ${market.sellTaxBps / 100}%` : "—"}</Stat>
      </dl>

      <div className="token-grid">
        <div className="token-main">
        <section className="token-chart" aria-label="Price chart">
          <div className="token-chart-head">
            <h2>Chart</h2>
            <div className="seg seg-small" role="group" aria-label="Chart interval">
              {INTERVALS.map(({ id, label }) => (
                <button key={id} type="button" aria-pressed={interval === id} onClick={() => setIntervalId(id)}>{label}</button>
              ))}
            </div>
          </div>
          {chartId ? (
            <div className="token-frame" style={{ height: chartHeight } as CSSProperties}>
              <iframe
                key={`${chartId}-${interval}`}
                title={`${symbol || "Token"} price chart`}
                src={chartEmbedUrl(chartId, interval)}
                style={{ height: chartHeight + FOOTER_CROP }}
                referrerPolicy="no-referrer"
                sandbox="allow-scripts allow-same-origin"
                loading="lazy"
              />
            </div>
          ) : (
            <p className="token-nochart dim">{pairs === null && loading ? "Loading the chart…" : "No pool yet. The chart appears once this token has a PancakeSwap pool."}</p>
          )}
        </section>
        {market && <TradesTable market={market} dexScreenerUrl={pairPageUrl(pair, chartId ?? token)} />}
        </div>

        <aside className="token-side">
          <TradePanel market={market} error={error} loading={loading} onTraded={reload} />
          <TokenChat chain="bsc" token={token} />
          {(meta?.description || links.length > 0) && (
            <section className="token-about" aria-label="About this token">
              <h2>About</h2>
              {meta?.description && <p className="token-description">{meta.description}</p>}
              {links.length > 0 && (
                <p className="token-links">
                  {links.map((link) => (
                    <a key={link.url} className="chip-link" href={link.url} target="_blank" rel="noreferrer noopener nofollow">{link.label} ↗</a>
                  ))}
                </p>
              )}
              <p className="dim token-source">Written and submitted by the token's own team, through Flap and DexScreener. Not checked by CallZ.</p>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
