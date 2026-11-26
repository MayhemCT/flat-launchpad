// Pools: the PancakeSwap pools of the tokens that graduated on Flap, and a way to add liquidity to one or
// take it out again. Reads the pools from the chain; loaded on demand, because it needs the chain library.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { formatUnits, parseUnits, type Address, type Hex } from "viem";
import { useApi, type Page, type TokenRow } from "./api";
import { amount, short } from "./format";
import { platformOf } from "./platform";
import { PlatformTag, TokenImage } from "./scope";
import { SITES, explorerAddressUrl } from "./site";
import {
  TradeError,
  addLiquidity,
  loadMarket,
  majorPools,
  poolChecks,
  poolPosition,
  poolSummaries,
  removeLiquidity,
  tokensFor,
  type Market,
  type PoolChecks,
  type PoolPosition,
  type PoolSummary,
  type TradeStep,
} from "./trade";
import { connect, switchChain, useWallet } from "./wallet";

const SITE = SITES.bsc;
const SLIPPAGES = [100, 300, 500, 1000];
const STEP_TEXT: Record<TradeStep, string> = {
  pricing: "Reading the pool…",
  approving: "Approve the exact amount in your wallet…",
  checking: "Checking on BNB Chain…",
  confirm: "Confirm in your wallet…",
  pending: "Waiting for confirmation…",
};

export type PoolsRoute = { name: "pools" } | { name: "pool"; address: string; quote?: "BNB" | "USDT" };

const graduatedRows = (page: Page<TokenRow>) => page.items.filter((token) => token.graduated && token.pool);

function PoolsList() {
  const indexed = useApi<Page<TokenRow>>("bsc", "tokens?limit=200", 60_000);
  const rows = useMemo(() => (indexed.state === "ready" ? graduatedRows(indexed.data) : null), [indexed]);
  const [pools, setPools] = useState<PoolSummary[] | null>(null);
  const [majors, setMajors] = useState<Array<PoolSummary & { symbol: string }> | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let current = true;
    const load = () => majorPools().then((next) => current && setMajors(next), () => undefined);
    void load();
    const timer = window.setInterval(load, 60_000);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!rows) return;
    let current = true;
    const load = () =>
      poolSummaries(rows.map((row) => ({ token: row.address as Address, pair: row.pool as Address, quoteToken: row.quoteToken }))).then(
        (next) => current && (setPools(next), setFailed(false)),
        () => current && setFailed(true),
      );
    void load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [rows]);

  const byToken = useMemo(() => new Map((rows ?? []).map((row) => [row.address, row])), [rows]);

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Pools</h1>
        <p className="lede">
          The PancakeSwap pools of the tokens that graduated on Flap, and PancakeSwap's major pairs. Add liquidity to one to earn its trading
          fees, and take it out whenever you like. Only pools that pass the checks on their page can be added to.
        </p>
      </div>
      <h2 className="pool-heading">Graduated on Flap <span className="dim">{pools ? pools.length : ""}</span></h2>
      {(indexed.state === "loading" || (rows && pools === null && !failed)) && <p className="note" role="status">Reading the pools from BNB Chain…</p>}
      {(indexed.state === "error" || (failed && pools === null)) && <p className="note" role="alert">The pools could not be read. Reload to try again.</p>}
      {pools !== null && pools.length === 0 && <p className="note" data-testid="pools-empty">No token has graduated on Flap's Pool Launch here yet.</p>}
      {pools !== null && pools.length > 0 && (
        <ul className="cards pool-cards" data-testid="pool-list">
          {pools.map((pool) => {
            const row = byToken.get(pool.token.toLowerCase());
            const platform = platformOf(SITE, row?.launcherFactory ?? null, new Map([[row?.launcherFactory ?? "", row?.launcherTitle ?? null]]));
            return (
              <li key={pool.pair}>
                <a className="card pool-card" href={`#/pool/${pool.token.toLowerCase()}`}>
                  <span className="pool-pair">
                    <TokenImage key={row?.image ?? "none"} image={row?.image ?? null} label={row?.symbol || "?"} colour={platform.colour} size={44} />
                    <span>
                      <strong>{row?.symbol || short(pool.token)} / {pool.quote}</strong>
                      <span className="dim">{row?.name}</span>
                    </span>
                  </span>
                  <span className="pool-figures">
                    <PlatformTag platform={platform} />
                    <span className="tag tag-good">Graduated</span>
                    <span className="num">{amount(pool.reserveQuote, 3)} {pool.quote} + {amount(pool.reserveToken, 2)} {row?.symbol}</span>
                    <span className="num dim">≈ {amount(pool.liquidityBnb, 3)} BNB of liquidity</span>
                  </span>
                  <span className="pool-go">Add liquidity →</span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
      <h2 className="pool-heading">Major PancakeSwap pairs <span className="dim">{majors ? majors.length : ""}</span></h2>
      {majors === null && <p className="note" role="status">Reading PancakeSwap's major pairs…</p>}
      {majors !== null && (
        <ul className="cards pool-cards" data-testid="major-pools">
          {majors.map((pool) => (
            <li key={pool.pair}>
              <a className="card pool-card" href={`#/pool/${pool.token.toLowerCase()}/${pool.quote.toLowerCase()}`}>
                <span className="pool-pair">
                  <TokenImage image={null} label={pool.symbol} colour="var(--gold)" size={44} />
                  <span>
                    <strong>{pool.symbol} / {pool.quote}</strong>
                    <span className="dim">PancakeSwap V2</span>
                  </span>
                </span>
                <span className="pool-figures">
                  <span className="tag tag-gold">Major pair</span>
                  <span className="num">{amount(pool.reserveQuote, 2)} {pool.quote} + {amount(pool.reserveToken, 2)} {pool.symbol}</span>
                  <span className="num dim">≈ {amount(pool.liquidityBnb, 0)} BNB of liquidity</span>
                </span>
                <span className="pool-go">Add liquidity →</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      <p className="scope-source dim">
        Pools are PancakeSwap V2 pairs, read from BNB Chain. Major pairs are between BNB and the assets on PancakeSwap's own default token list. Adding liquidity puts in both the token and BNB (or USDT) at the pool's price and
        gives you LP tokens; the value of what they return moves with the price. CallZ adds no fee and never holds your funds.
      </p>
    </>
  );
}

type Side = "add" | "remove";
interface Outcome {
  kind: "working" | "done" | "error";
  title: string;
  text: string;
  hash?: Hex;
}

function LiquidityPanel({ market, position, checks, reload }: { market: Market; position: PoolPosition | null; checks: PoolChecks | null; reload(): void }) {
  const wallet = useWallet();
  const account = wallet.account;
  const [side, setSide] = useState<Side>("add");
  const [text, setText] = useState("");
  const [slippage, setSlippage] = useState(500);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const busy = outcome?.kind === "working";
  const symbol = market.symbol || "token";

  const value = useMemo(() => {
    if (!/^\d*\.?\d+$/.test(text.trim())) return null;
    try {
      const parsed = parseUnits(text.trim(), 18);
      return parsed > 0n ? parsed : null;
    } catch {
      return null;
    }
  }, [text]);

  const tokensIn = side === "add" && value !== null && position ? tokensFor(position, value) : null;
  const out = side === "remove" && value !== null && position && position.lpSupply > 0n
    ? { token: (position.reserveToken * value) / position.lpSupply, quote: (position.reserveQuote * value) / position.lpSupply }
    : null;
  // Adding waits for the pool's checks, and stays closed when one fails. Taking liquidity out is never blocked.
  const closed = side === "add" && checks !== null && !checks.ok;
  let problem: string | null = null;
  if (side === "add" && checks === null) problem = "Checking the pool…";
  else if (closed) problem = "Adding is closed for this pool";
  else if (position && value !== null && account) {
    if (side === "add" && value > position.quoteBalance) problem = `Not enough ${market.quote}`;
    else if (side === "add" && tokensIn !== null && tokensIn > position.tokenBalance) problem = `Not enough ${symbol}`;
    else if (side === "remove" && value > position.lpBalance) problem = "More than your LP tokens";
  }

  const submit = async () => {
    if (!account || value === null) return;
    const title = side === "add" ? "Adding liquidity" : "Removing liquidity";
    setOutcome({ kind: "working", title, text: "Starting…" });
    try {
      const request = { market, account, amount: value, slippageBps: slippage, onStep: (step: TradeStep, hash?: Hex) => setOutcome({ kind: "working", title, text: STEP_TEXT[step], hash }) };
      const { hash } = side === "add" ? await addLiquidity(request) : await removeLiquidity(request);
      setOutcome({ kind: "done", title: side === "add" ? "Liquidity added" : "Liquidity removed", text: "Confirmed on BNB Chain.", hash });
      setText("");
      reload();
    } catch (cause) {
      const failure = cause instanceof TradeError ? cause : new TradeError("NETWORK", "Something went wrong", "It could not be completed. Check your wallet's activity before trying again.");
      setOutcome({ kind: "error", title: failure.title, text: failure.message, hash: failure.hash });
      reload();
    }
  };

  let action: ReactNode;
  if (!wallet.available) action = <p className="trade-note">No browser wallet found. Install MetaMask, Rabby or another wallet to use pools.</p>;
  else if (!account) action = <button type="button" className="button trade-go" onClick={connect}>Connect wallet</button>;
  else if (wallet.chainId !== SITE.id) action = <button type="button" className="button button-warn trade-go" onClick={() => void switchChain(SITE).catch(() => undefined)}>Switch to BNB Chain</button>;
  else {
    action = (
      <button type="button" className="button trade-go" data-side={side === "remove" ? "sell" : "buy"} disabled={busy || value === null || !position || problem !== null} onClick={() => void submit()}>
        {problem ?? (side === "add" ? "Add liquidity" : "Remove liquidity")}
      </button>
    );
  }

  const percent = (share: number) => {
    if (!position) return;
    setText(formatUnits(side === "add" ? (position.quoteBalance * BigInt(share)) / 100n : (position.lpBalance * BigInt(share)) / 100n, 18));
  };

  return (
    <section className="trade-panel" data-testid="liquidity-panel" aria-label="Liquidity">
      <div className="seg trade-sides" role="group" aria-label="Add or remove">
        <button type="button" aria-pressed={side === "add"} onClick={() => { setSide("add"); setText(""); setOutcome(null); }}>Add</button>
        <button type="button" aria-pressed={side === "remove"} onClick={() => { setSide("remove"); setText(""); setOutcome(null); }}>Remove</button>
      </div>

      {closed && <p className="trade-outcome trade-error" role="alert" data-testid="liquidity-closed"><strong>Adding liquidity is closed here.</strong> {checks?.reason}</p>}

      <label className="trade-amount">
        <span className="stat-label">{side === "add" ? `${market.quote} to put in` : "LP tokens to take out"}</span>
        <span className="trade-input">
          <input name="amount" inputMode="decimal" autoComplete="off" placeholder="0.0" value={text} disabled={busy} onChange={(event) => setText(event.target.value.replace(",", "."))} />
          <span className="num">{side === "add" ? market.quote : "LP"}</span>
        </span>
      </label>
      <div className="trade-presets" role="group" aria-label="Share of your balance">
        {(side === "add" ? [10, 25, 50, 75] : [25, 50, 75, 100]).map((share) => (
          <button key={share} type="button" disabled={busy || !position || !account} onClick={() => percent(share)}>{share}%</button>
        ))}
      </div>
      {position && account && (
        <p className="trade-held dim num">
          {side === "add"
            ? `Balance ${amount(position.quoteBalance, 4)} ${market.quote} · ${amount(position.tokenBalance, 2, market.decimals)} ${symbol}`
            : `Your LP tokens ${amount(position.lpBalance, 6)}`}
        </p>
      )}

      <dl className="trade-quote">
        {side === "add" ? (
          <>
            <div><dt>{symbol} that goes in with it</dt><dd className="num">{tokensIn !== null ? `${amount(tokensIn, 2, market.decimals)} ${symbol}` : "—"}</dd></div>
            <div><dt>Share of the pool you get</dt><dd className="num">{value !== null && position && position.reserveQuote > 0n ? `≈ ${(Number((value * 1_000_000n) / (position.reserveQuote + value)) / 10_000).toFixed(2)}%` : "—"}</dd></div>
            {market.sellTaxBps > 0 && <div><dt>Token's tax on what goes in</dt><dd className="num">{market.sellTaxBps / 100}%</dd></div>}
          </>
        ) : (
          <>
            <div><dt>You receive</dt><dd className="num">{out ? `≈ ${amount(out.quote, 5)} ${market.quote}` : "—"}</dd></div>
            <div><dt>and</dt><dd className="num">{out ? `≈ ${amount(out.token, 2, market.decimals)} ${symbol}` : "—"}</dd></div>
            {market.buyTaxBps > 0 && <div><dt>Token's tax on what comes out</dt><dd className="num">{market.buyTaxBps / 100}%</dd></div>}
          </>
        )}
      </dl>

      <div className="trade-slippage">
        <span className="stat-label">Slippage</span>
        <div className="seg seg-small" role="group" aria-label="Slippage">
          {SLIPPAGES.map((option) => (
            <button key={option} type="button" aria-pressed={slippage === option} onClick={() => setSlippage(option)}>{option / 100}%</button>
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
        Sent from your wallet straight to PancakeSwap's router. The transaction is checked on BNB Chain before your wallet opens. A token that
        taxes transfers takes its tax on tokens entering or leaving the pool. CallZ adds no fee and never holds your funds.
      </p>
    </section>
  );
}

function PoolPage({ address, quote }: { address: string; quote?: "BNB" | "USDT" }) {
  const token = address as Address;
  const wallet = useWallet();
  const account = wallet.account;
  const indexed = useApi<Page<TokenRow>>("bsc", `tokens?address=${token}`);
  const row = indexed.state === "ready" ? indexed.data.items[0] ?? null : null;
  const [market, setMarket] = useState<Market | null>(null);
  const [position, setPosition] = useState<PoolPosition | null>(null);
  const [checks, setChecks] = useState<PoolChecks | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    loadMarket(token, quote)
      .then(async (next) => {
        setMarket(next);
        const [nextPosition, nextChecks] = await Promise.all([poolPosition(next, account), poolChecks(next)]);
        setPosition(nextPosition);
        setChecks(nextChecks);
        setError(null);
      })
      .catch((cause) => setError(cause instanceof TradeError ? cause.message : "BNB Chain could not be reached. Reload to try again."));
  }, [token, quote, account]);
  useEffect(() => {
    reload();
    const timer = window.setInterval(reload, 15_000);
    return () => window.clearInterval(timer);
  }, [reload]);

  const platform = platformOf(SITE, row?.launcherFactory ?? null, new Map([[row?.launcherFactory ?? "", row?.launcherTitle ?? null]]));
  const symbol = row?.symbol || market?.symbol || short(token);
  const share = position && position.lpSupply > 0n ? Number((position.lpBalance * 1_000_000n) / position.lpSupply) / 10_000 : 0;

  return (
    <div className="token-page" data-testid="pool-page">
      <header className="token-head">
        <TokenImage key={row?.image ?? "none"} image={row?.image ?? null} label={symbol} colour={platform.colour} size={64} />
        <div className="token-title">
          <h1>{symbol} <span className="dim">/ {market?.quote ?? "…"} pool</span></h1>
          <p className="token-tags">
            {row && <PlatformTag platform={platform} />}
            {row?.graduated && <span className="tag tag-good">Graduated</span>}
            <span className="dim">PancakeSwap V2</span>
          </p>
        </div>
        <div className="token-actions">
          <a className="button button-quiet" href="#/pools">← All pools</a>
          <a className="button button-quiet" href={`#/token/${token}`}>Chart and trading</a>
          {market && <a className="button button-quiet" href={explorerAddressUrl(SITE, market.pair)} target="_blank" rel="noreferrer">Pool on BscScan ↗</a>}
        </div>
      </header>

      {error && !market && <p className="note" role="alert" data-testid="pool-error">{error}</p>}
      {!market && !error && <p className="note" role="status">Reading the pool from BNB Chain…</p>}
      {market && (
        <>
          <dl className="stats token-stats" data-testid="pool-stats">
            <div><dt>{market.quote} in the pool</dt><dd className="num">{position ? amount(position.reserveQuote, 3) : "—"}</dd></div>
            <div><dt>{symbol} in the pool</dt><dd className="num">{position ? amount(position.reserveToken, 2, market.decimals) : "—"}</dd></div>
            <div><dt>Your share</dt><dd className="num">{account && position ? `${share.toFixed(2)}%` : "—"}</dd></div>
            <div><dt>Yours in {market.quote}</dt><dd className="num">{account && position ? amount(position.quoteShare, 5) : "—"}</dd></div>
            <div><dt>Yours in {symbol}</dt><dd className="num">{account && position ? amount(position.tokenShare, 2, market.decimals) : "—"}</dd></div>
            <div><dt>Buy / sell tax</dt><dd className="num">{market.buyTaxBps / 100}% / {market.sellTaxBps / 100}%</dd></div>
          </dl>
          <div className="pool-grid">
            <LiquidityPanel market={market} position={position} checks={checks} reload={reload} />
            <section className="token-about">
              <h2>Pool checks</h2>
              <ul className="pool-checks" data-testid="pool-checks">
                {checks ? checks.items.map((check) => <li key={check.label} data-ok={check.ok}>{check.label}</li>) : <li>Checking the pool…</li>}
              </ul>
              <p className="dim token-source">Liquidity can be added only when every check passes. These are read from BNB Chain and this site's index, not taken from the page's address. Taking your own liquidity out is never blocked.</p>
              <h2>How this works</h2>
              <p className="token-description">
                Adding liquidity puts {market.quote} and {symbol} into the pool in the pool's own ratio, and gives you LP tokens for your share.
                Every trade in the pool pays a fee that stays in it, so a share grows with trading.
              </p>
              <p className="token-description">
                Your LP tokens always return your share of what the pool holds at that moment. If the price has moved since you added, that is
                more of one side and less of the other than you put in, and can be worth less than simply holding.
              </p>
              <p className="dim token-source">The LP that a launch itself burns stays burned. What you add here is yours to take out.</p>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

export default function PoolsSection({ route }: { route: PoolsRoute }) {
  return route.name === "pool" ? <PoolPage key={`${route.address}-${route.quote ?? ""}`} address={route.address} quote={route.quote} /> : <PoolsList />;
}
