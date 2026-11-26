// Memescope: every launchpad on Pool Launch on one board, in three live columns. A launch moves left to
// right as it fills: New, Final stretch, Launched. Reads this site's own index; needs no wallet.
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useApi, type Scope, type ScopeRaise, type ScopeToken } from "./api";
import { ago, amount, compact, percent, price, short } from "./format";
import { platformOf, type Platform } from "./platform";
import { QUICK_AMOUNTS, useQuickBuy, type QuickBuy } from "./quickbuy";
import { ZERO_ADDRESS, flapLauncherUrl, flapTokenUrl, type Site } from "./site";

/** A raise at or past this share of its target is in the final stretch. In basis points. */
const STRETCH_BPS = 5000;
/** Launchpad chips shown before "more". */
const CHIPS_SHOWN = 7;

type Rank = "smart" | "progress" | "newest";
type ColumnId = "new" | "stretch" | "launched";

const RANKS: ReadonlyArray<{ id: Rank; label: string; hint: string }> = [
  { id: "smart", label: "Smart", hint: "New by time, Final stretch by progress" },
  { id: "progress", label: "Progress", hint: "Closest to launching first" },
  { id: "newest", label: "Newest", hint: "Most recent first" },
];

/** How far a raise has come, in basis points of its target. Null until the index has read its balance. */
function progressOf(row: ScopeRaise): number | null {
  if (row.raised === null || !row.targetRaise) return null;
  const target = BigInt(row.targetRaise);
  if (target === 0n) return null;
  return Number((BigInt(row.raised) * 10_000n) / target);
}

const initials = (text: string) => [...text.trim()].slice(0, 2).join("").toUpperCase() || "··";

/**
 * A token's picture, with its initials until the picture loads, and when it has none. Pictures come through
 * this site's own /api/image, as small thumbnails.
 */
export const TokenImage = memo(function TokenImage({ image, label, colour, size = 52 }: { image: string | null; label: string; colour: string; size?: number }) {
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const style = { "--ring": colour, width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.32)) } as CSSProperties;
  return (
    <span className="token-image" style={style} aria-hidden="true">
      {state !== "ready" && <span>{initials(label)}</span>}
      {image && state !== "failed" && (
        <img
          src={`/api/image/${image}?w=128`}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          data-ready={state === "ready"}
          onLoad={() => setState("ready")}
          onError={() => setState("failed")}
        />
      )}
    </span>
  );
});

export function PlatformTag({ platform }: { platform: Platform }) {
  return (
    <span className="platform-tag" style={{ "--tone": platform.colour } as CSSProperties} title={platform.factory ? `Launcher Factory ${platform.factory}` : "Launched straight through Flap's Portal"}>
      <i aria-hidden="true" />
      {platform.name}
    </span>
  );
}

interface RaiseItem {
  row: ScopeRaise;
  platform: Platform;
  progress: number | null;
}
interface TokenItem {
  row: ScopeToken;
  platform: Platform;
}

function RaiseRow({ site, item, unit, decimals, fresh }: { site: Site; item: RaiseItem; unit: string; decimals: number; fresh: boolean }) {
  const { row, platform, progress } = item;
  const own = platform.kind === "callz";
  const shown = progress === null ? null : Math.min(100, Math.round(progress / 100));
  return (
    <a
      className={`scope-row${fresh ? " scope-fresh" : ""}`}
      data-testid="scope-row"
      style={{ "--tone": platform.colour } as CSSProperties}
      href={own ? `#/launcher/${row.address}` : flapLauncherUrl(site, row.address)}
      {...(own ? {} : { target: "_blank", rel: "noreferrer" })}
    >
      <TokenImage image={null} label={row.symbol || row.name || "?"} colour={platform.colour} />
      <span className="scope-body">
        <span className="scope-line">
          <strong>{row.symbol || row.name || short(row.address)}</strong>
          <span className="scope-name dim">{row.name}</span>
          <span className="scope-age num">{ago(row.timestamp).replace(" ago", "")}</span>
        </span>
        <span className="scope-line scope-meta">
          <PlatformTag platform={platform} />
          <span className="num dim">dev {short(row.creator)}</span>
        </span>
        <span className="scope-line scope-meta">
          <span>Raised <b className="num">{row.raised === null ? "—" : amount(row.raised, 3, decimals)}</b> / <b className="num">{amount(row.targetRaise, 3, decimals)}</b> {unit}</span>
          <span className="dim">{percent(row.poolTokenRatio ? BigInt(row.poolTokenRatio) : undefined)} to pool</span>
        </span>
        <span className="scope-progress" title="Quote balance the Launcher holds, against its target raise">
          <span className="scope-bar"><span style={{ width: `${shown ?? 0}%` }} /></span>
          <span className="num">{shown === null ? "—" : `${shown}%`}</span>
        </span>
      </span>
      <span className="scope-cta" data-flap={!own}>{own ? "Mint →" : "Flap ↗"}</span>
    </a>
  );
}

function TokenRow({ site, item, unit, fresh, quickBuy }: { site: Site; item: TokenItem; unit: string; fresh: boolean; quickBuy: QuickBuy | null }) {
  const { row, platform } = item;
  const content = (
    <>
      <TokenImage key={row.image ?? "none"} image={row.image} label={row.symbol || row.name || "?"} colour={platform.colour} />
      <span className="scope-body">
        <span className="scope-line">
          <strong>{row.symbol || row.name || short(row.address)}</strong>
          <span className="scope-name dim">{row.name}</span>
          <span className="scope-age num">{ago(row.timestamp).replace(" ago", "")}</span>
        </span>
        <span className="scope-line scope-meta">
          <PlatformTag platform={platform} />
          <span className="num dim">dev {short(row.creator)}</span>
        </span>
        <span className="scope-line scope-meta">
          <span>Open <b className="num">{price(row.initialPriceWad)}</b> {unit}</span>
          <span>Supply <b className="num">{compact(row.totalSupply)}</b></span>
          <span className={`tag tag-${row.graduated ? "good" : "muted"}`}>{row.graduated ? "Graduated" : "Live"}</span>
        </span>
      </span>
    </>
  );
  const className = `scope-row${fresh ? " scope-fresh" : ""}`;
  const style = { "--tone": platform.colour } as CSSProperties;
  // On mainnet the token opens on this site (chart, trading, chat) and can be bought in one click.
  if (quickBuy) {
    const busy = quickBuy.buying.has(row.address);
    return (
      <div className={`${className} scope-split`} data-testid="scope-row" style={style}>
        <a className="scope-main" href={`#/token/${row.address}`}>{content}</a>
        <button type="button" className="quick-buy" disabled={busy} title={`Buy ${quickBuy.amount} BNB of ${row.symbol || "this token"} through PancakeSwap`} onClick={() => quickBuy.buy({ address: row.address, symbol: row.symbol })}>
          {busy ? "…" : <>⚡ {quickBuy.amount}</>}
        </button>
      </div>
    );
  }
  return (
    <a className={className} data-testid="scope-row" style={style} href={flapTokenUrl(site, row.address)} target="_blank" rel="noreferrer">
      {content}
      <span className="scope-cta" data-flap="true">Flap ↗</span>
    </a>
  );
}

function Column({ id, title, blurb, count, hidden, children }: { id: ColumnId; title: string; blurb: string; count: number; hidden: boolean; children: ReactNode }) {
  return (
    <section className="scope-column" data-column={id} hidden={hidden} aria-label={title}>
      <header>
        <h2>{title} <span className="scope-count num">{count}</span></h2>
        <span className="live">LIVE</span>
        <p className="dim">{blurb}</p>
      </header>
      <div className="scope-list">
        {count === 0 ? <p className="scope-none dim" data-testid="scope-empty">Nothing here right now.</p> : children}
      </div>
    </section>
  );
}

/** Addresses that were not on the board at the previous poll: they flash once as they arrive. */
function useFresh(addresses: string[] | null): Set<string> {
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!addresses) return;
    const previous = seen.current;
    if (previous) setFresh(new Set(addresses.filter((address) => !previous.has(address))));
    seen.current = new Set(addresses);
  }, [addresses]);
  return fresh;
}

/** The view switch at the top of both launch pages. */
export function LaunchModes({ mode }: { mode: "scope" | "board" }) {
  return (
    <nav className="seg seg-small" aria-label="View" data-testid="launch-modes">
      <a href="#/scope" aria-current={mode === "scope" ? "page" : undefined}>Memescope</a>
      <a href="#/launches" aria-current={mode === "board" ? "page" : undefined}>Board</a>
    </nav>
  );
}

export function ScopePage({ site, mobile }: { site: Site; mobile: boolean }) {
  const result = useApi<Scope>(site.key, "scope", 20_000);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [rank, setRank] = useState<Rank>("smart");
  const [column, setColumn] = useState<ColumnId>("new");
  const [allChips, setAllChips] = useState(false);
  const data = result.state === "ready" ? result.data : null;
  // Trading runs through PancakeSwap on BNB Chain mainnet; testnet tokens open on Flap.
  const quick = useQuickBuy();
  const quickBuy = site.key === "bsc" ? quick : null;

  // A filter picked on one network means nothing on the other.
  useEffect(() => setPicked(new Set()), [site.key]);

  const board = useMemo(() => {
    if (!data) return null;
    const titles = new Map(data.platforms.map((platform) => [platform.factory, platform.title]));
    const raising: RaiseItem[] = data.raising.map((row) => ({ row, platform: platformOf(site, row.factory, titles), progress: progressOf(row) }));
    const launched: TokenItem[] = data.launched.map((row) => ({ row, platform: platformOf(site, row.factory, titles) }));

    // Launchpads with something on the board: Flap first, then CallZ, then by how much they have here.
    const counts = new Map<string, { platform: Platform; count: number }>();
    for (const { platform } of [...raising, ...launched]) {
      const entry = counts.get(platform.key) ?? { platform, count: 0 };
      entry.count++;
      counts.set(platform.key, entry);
    }
    const order = { flap: 0, callz: 1, factory: 2 } as const;
    const platforms = [...counts.values()].sort(
      (a, b) => order[a.platform.kind] - order[b.platform.kind] || Number(b.platform.named) - Number(a.platform.named) || b.count - a.count,
    );
    return { raising, launched, platforms, launchpads: data.platforms.length };
  }, [data, site]);

  const addresses = useMemo(() => (data ? [...data.raising, ...data.launched].map((row) => row.address) : null), [data]);
  const fresh = useFresh(addresses);

  const columns = useMemo(() => {
    if (!board) return null;
    const text = query.trim().toLowerCase();
    const keep = (item: RaiseItem | TokenItem) =>
      (picked.size === 0 || picked.has(item.platform.key)) &&
      (!text ||
        (item.row.symbol ?? "").toLowerCase().includes(text) ||
        (item.row.name ?? "").toLowerCase().includes(text) ||
        item.row.address === text ||
        item.row.creator === text);
    const byTime = (a: RaiseItem, b: RaiseItem) => (b.row.timestamp ?? 0) - (a.row.timestamp ?? 0);
    const byProgress = (a: RaiseItem, b: RaiseItem) => (b.progress ?? -1) - (a.progress ?? -1) || byTime(a, b);
    const raising = board.raising.filter(keep);
    return {
      new: raising.filter((item) => (item.progress ?? 0) < STRETCH_BPS).sort(rank === "progress" ? byProgress : byTime),
      stretch: raising.filter((item) => (item.progress ?? 0) >= STRETCH_BPS).sort(rank === "newest" ? byTime : byProgress),
      launched: board.launched.filter(keep),
    };
  }, [board, query, picked, rank]);

  const toggle = (key: string) =>
    setPicked((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const unitOf = (quote: string | null) => (!quote || quote === ZERO_ADDRESS ? site.unit : data?.quotes[quote]?.symbol ?? "quote");
  const decimalsOf = (quote: string | null) => (!quote || quote === ZERO_ADDRESS ? 18 : data?.quotes[quote]?.decimals ?? 18);
  const chips = board ? (allChips ? board.platforms : board.platforms.slice(0, CHIPS_SHOWN)) : [];
  const more = board ? board.platforms.length - chips.length : 0;
  const graduated = data ? data.launched.filter((token) => token.graduated).length : 0;

  const COLUMNS: ReadonlyArray<{ id: ColumnId; title: string; blurb: string }> = [
    { id: "new", title: "New", blurb: rank === "progress" ? "Raising, under half funded · most funded first" : "Raising, under half funded · newest first" },
    { id: "stretch", title: "Final stretch", blurb: rank === "newest" ? "Half funded or more · newest first" : "Half funded or more · closest to launch first" },
    { id: "launched", title: "Launched", blurb: "Token live in its pool · newest first" },
  ];

  return (
    <div className="scope-page" data-testid="scope-page">
      <div className="scope-head">
        <h1 className="page-title">Memescope</h1>
        <LaunchModes mode="scope" />
      </div>

      <a className="flap-strip" href="https://flap.sh" target="_blank" rel="noreferrer" data-testid="flap-strip">
        <span className="flap-mark">FLAP</span>
        <span className="flap-text">
          <strong>Every launch here runs on Flap's Pool Launch.</strong>{" "}
          {board && data
            ? `${board.launchpads} launchpads build on it on ${site.label}: ${data.raising.length} raising, ${data.launched.length} launched, ${graduated} graduated.`
            : `Reading ${site.label}…`}
        </span>
        <span className="flap-go">Open Flap ↗</span>
      </a>

      <div className="scope-tools">
        <label className="scope-search">
          <span className="visually-hidden">Search launches</span>
          <input type="search" name="q" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, symbol or address" autoComplete="off" spellCheck={false} />
        </label>
        <div className="seg seg-small" role="group" aria-label="Rank by">
          {RANKS.map(({ id, label, hint }) => (
            <button key={id} type="button" aria-pressed={rank === id} title={hint} onClick={() => setRank(id)}>{label}</button>
          ))}
        </div>
        {quickBuy && (
          <div className="quick-amounts">
            <span className="stat-label">⚡ One-click buy</span>
            <div className="seg seg-small" role="group" aria-label="One-click buy amount">
              {QUICK_AMOUNTS.map((value) => (
                <button key={value} type="button" aria-pressed={quickBuy.amount === value} onClick={() => quickBuy.setAmount(value)}>{value} BNB</button>
              ))}
            </div>
          </div>
        )}
        <div className="chips" role="group" aria-label="Filter by launchpad" data-testid="platform-chips">
          <button type="button" className="chip" aria-pressed={picked.size === 0} onClick={() => setPicked(new Set())}><span>All</span></button>
          {chips.map(({ platform, count }) => (
            <button
              key={platform.key}
              type="button"
              className="chip"
              aria-pressed={picked.has(platform.key)}
              style={{ "--tone": platform.colour } as CSSProperties}
              title={platform.factory ? `Launcher Factory ${platform.factory}` : "Launched straight through Flap's Portal"}
              onClick={() => toggle(platform.key)}
            >
              <span><i aria-hidden="true" />{platform.name}<b className="num">{count}</b></span>
            </button>
          ))}
          {(more > 0 || allChips) && board && board.platforms.length > CHIPS_SHOWN && (
            <button type="button" className="chip" onClick={() => setAllChips((all) => !all)}><span>{allChips ? "Fewer" : `+${more} more`}</span></button>
          )}
        </div>
      </div>

      {mobile && (
        <div className="seg" role="group" aria-label="Column">
          {COLUMNS.map(({ id, title }) => (
            <button key={id} type="button" aria-pressed={column === id} onClick={() => setColumn(id)}>
              {title} <span className="num">{columns ? columns[id].length : ""}</span>
            </button>
          ))}
        </div>
      )}

      {result.state === "loading" && <p className="note" role="status">Loading…</p>}
      {result.state === "error" && <p className="note" role="alert">The index could not be reached. Reload to try again.</p>}
      {columns && data && (
        <div className="scope-grid">
          {COLUMNS.map(({ id, title, blurb }) => (
            <Column key={id} id={id} title={title} blurb={blurb} count={columns[id].length} hidden={mobile && column !== id}>
              {id === "launched"
                ? columns.launched.map((item) => <TokenRow key={item.row.address} site={site} item={item} unit={unitOf(item.row.quoteToken)} fresh={fresh.has(item.row.address)} quickBuy={quickBuy} />)
                : columns[id].map((item) => (
                    <RaiseRow key={item.row.address} site={site} item={item} unit={unitOf(item.row.quoteToken)} decimals={decimalsOf(item.row.quoteToken)} fresh={fresh.has(item.row.address)} />
                  ))}
            </Column>
          ))}
        </div>
      )}

      {quickBuy?.layer}

      <p className="scope-source dim">
        Progress is the quote balance each Launcher holds against its target raise, read on-chain every minute.
        Pictures come from each token's own metadata. Launchpads are the Launcher Factories on Flap's Pool Launch
        Portal, named by the title their launches carry.{" "}
        {data?.updatedAt ? `${site.label} · block ${data.head?.toLocaleString("en")} · read ${ago(data.updatedAt)}.` : ""}
      </p>
    </div>
  );
}
