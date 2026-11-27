import { Suspense, lazy, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { DeployersPage, FactoriesPage, HomePage, LaunchesPage, TokensPage } from "./aggregator";
import { short } from "./format";
import { FLAP_LAUNCH, SITES, type Site } from "./site";
import { connect, switchChain, useWallet } from "./wallet";
import { ScopePage } from "./scope";
import type { PancakeRoute } from "./pancake";
import type { PoolsRoute } from "./pools";
import type { FlapLaunchRoute, Locale } from "./flap-launch";

// The launchpad needs a chain library and the launch UI package: both load only when one of its pages opens.
const FlapLaunchSection = lazy(() => import("./flap-launch"));
// A token's page trades through PancakeSwap, which needs the chain library too.
const TokenPage = lazy(() => import("./token"));
// A token's pop-out window: chart on top, chat under it. Several can be open at once.
const PopPage = lazy(() => import("./token").then((module) => ({ default: module.PopPage })));
// The launchpad on BNB Chain mainnet: pass mints that launch into PancakeSwap.
const PancakeSection = lazy(() => import("./pancake"));
// Pools: Flap's graduated pairs on PancakeSwap, with adding and removing liquidity.
const PoolsSection = lazy(() => import("./pools"));
// The wallet's positions read balances and sell through the same library: loaded when first opened.
const Positions = lazy(() => import("./positions"));
// Where the reviewer wallet approves callouts. Reached by its address, linked from nowhere.
const ReviewPage = lazy(() => import("./callouts").then((module) => ({ default: module.ReviewPage })));

const LOCALES: ReadonlyArray<{ id: Locale; label: string }> = [
  { id: "en", label: "EN" },
  { id: "zh", label: "中文" },
  { id: "ko", label: "한국어" },
];

type AggregatorRoute = { name: "home" | "scope" | "launches" | "tokens" | "factories" | "deployers" };
type Route = AggregatorRoute | FlapLaunchRoute | PancakeRoute | PoolsRoute | { name: "token"; address: string } | { name: "pop"; address: string } | { name: "review" } | { name: "missing" };

function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "") || "/";
  if (path === "/") return { name: "home" };
  if (path === "/scope" || path === "/launches" || path === "/tokens" || path === "/factories" || path === "/deployers") {
    return { name: path.slice(1) as AggregatorRoute["name"] };
  }
  // The launchpad is on BNB Chain. The Flap Pool Launch one on testnet is kept for the hackathon's testnet run:
  // it is reachable by its address and linked from nowhere.
  if (path === "/launch") return { name: "launch" };
  if (path === "/launch/create") return { name: "launch-create" };
  if (path === "/launch/testnet") return { name: "flaplaunch" };
  const mint = /^\/mint\/(0x[0-9a-fA-F]{40})$/.exec(path);
  if (mint?.[1]) return { name: "mint", address: mint[1].toLowerCase() };
  if (path === "/pools") return { name: "pools" };
  const pool = /^\/pool\/(0x[0-9a-fA-F]{40})(?:\/(bnb|usdt))?$/.exec(path);
  if (pool?.[1]) return { name: "pool", address: pool[1].toLowerCase(), ...(pool[2] ? { quote: pool[2] === "usdt" ? ("USDT" as const) : ("BNB" as const) } : {}) };
  const pop = /^\/pop\/(0x[0-9a-fA-F]{40})$/.exec(path);
  if (pop?.[1]) return { name: "pop", address: pop[1].toLowerCase() };
  const token = /^\/token\/(0x[0-9a-fA-F]{40})$/.exec(path);
  if (token?.[1]) return { name: "token", address: token[1].toLowerCase() };
  if (path === "/create") return { name: "create" };
  if (path === "/review") return { name: "review" };
  const launcher = /^\/launcher\/(0x[0-9a-fA-F]{40})$/.exec(path);
  if (launcher?.[1]) return { name: "launcher", address: launcher[1].toLowerCase() };
  return { name: "missing" };
}

function useRoute(): Route {
  const hash = useSyncExternalStore(
    (listener) => {
      window.addEventListener("hashchange", listener);
      return () => window.removeEventListener("hashchange", listener);
    },
    () => window.location.hash,
  );
  return useMemo(() => parseRoute(hash), [hash]);
}

/** True on phone-sized screens, where the page uses its own layout rather than a squeezed desktop one. */
function useIsMobile(): boolean {
  const query = "(max-width: 1023px)";
  return useSyncExternalStore(
    (listener) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", listener);
      return () => media.removeEventListener("change", listener);
    },
    () => window.matchMedia(query).matches,
  );
}

function Backdrop() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let disposed = false;
    let handle: { dispose(): void } | undefined;
    // After first paint, and only then, fetch three.js and start the scene.
    const begin = () => {
      void import("./scene")
        .then(({ startScene }) => {
          if (!disposed && canvas.current) handle = startScene(canvas.current);
        })
        // A browser without WebGL shows the page without the background.
        .catch(() => undefined);
    };
    const idle = window.requestIdleCallback ? window.requestIdleCallback(begin, { timeout: 1200 }) : window.setTimeout(begin, 200);
    return () => {
      disposed = true;
      if (window.cancelIdleCallback) window.cancelIdleCallback(idle);
      else window.clearTimeout(idle);
      handle?.dispose();
    };
  }, []);
  return <canvas ref={canvas} className="backdrop" aria-hidden="true" data-testid="backdrop" />;
}

/** The wallet, and whether it is on the network this page works on. */
function WalletButton({ target }: { target: Site }) {
  const wallet = useWallet();
  if (!wallet.available) return <span className="pill pill-muted" data-testid="wallet">No wallet found</span>;
  if (!wallet.account) return <button type="button" className="button" data-testid="wallet" onClick={connect}>Connect wallet</button>;
  if (wallet.chainId !== target.id) {
    return (
      <button type="button" className="button button-warn" data-testid="wallet" onClick={() => void switchChain(target).catch(() => undefined)}>
        Switch to {target.short}
      </button>
    );
  }
  return <WalletMenu account={wallet.account} chainId={wallet.chainId} unit={target.unit} />;
}

/** "0.4215" from a hex wei balance: four decimals, no chain library. */
function formatBalance(hex: string): string {
  const wei = BigInt(hex);
  const whole = wei / 10n ** 18n;
  const fraction = ((wei % 10n ** 18n) / 10n ** 14n).toString().padStart(4, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}

/** The connected wallet: its balance, and a menu of the positions it can sell. */
function WalletMenu({ account, chainId, unit }: { account: `0x${string}`; chainId: number | null; unit: string }) {
  const [open, setOpen] = useState(false);
  const [balance, setBalance] = useState<string | null>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current = true;
    const read = () =>
      window.ethereum
        ?.request({ method: "eth_getBalance", params: [account, "latest"] })
        .then((value) => current && setBalance(formatBalance(String(value))), () => undefined);
    setBalance(null);
    void read();
    const timer = window.setInterval(() => void read(), 20_000);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [account, chainId, open]);

  // Close on a click anywhere else, and on Escape.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => !menu.current?.contains(event.target as Node) && setOpen(false);
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="wallet-menu" ref={menu}>
      <button type="button" className="wallet-button" data-testid="wallet" aria-expanded={open} aria-haspopup="dialog" title={account} onClick={() => setOpen((value) => !value)}>
        <span className="num">{balance === null ? "…" : balance} {unit}</span>
        <span className="num dim wallet-address">{short(account)}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <Suspense fallback={<div className="positions"><p className="positions-note" role="status">Loading…</p></div>}>
          <Positions account={account} chainId={chainId} onNavigate={() => setOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}

function LocaleSwitch({ locale, onChange }: { locale: Locale; onChange(next: Locale): void }) {
  return (
    <label className="locale">
      <span className="visually-hidden">Language</span>
      <select value={locale} onChange={(event) => onChange(event.target.value as Locale)}>
        {LOCALES.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
      </select>
    </label>
  );
}

// `short` is the label on the phone tab bar, where five tabs share the width.
// `wide` entries are left off the phone tab bar, where five fit: they are linked from the Factories page.
const NAV: ReadonlyArray<{ href: string; label: string; short?: string; wide?: boolean; routes: ReadonlyArray<Route["name"]> }> = [
  { href: "#/scope", label: "Memescope", short: "Scope", routes: ["scope", "launches"] },
  { href: "#/tokens", label: "Tokens", routes: ["tokens", "token"] },
  { href: "#/pools", label: "Pools", routes: ["pools", "pool"] },
  { href: "#/factories", label: "Factories", routes: ["factories"] },
  { href: "#/deployers", label: "Deployers", routes: ["deployers"], wide: true },
  { href: "#/launch", label: "Launch", routes: ["launch", "launch-create", "mint", "flaplaunch", "create", "launcher"] },
];

/** What a page works with: the index, the unlinked testnet launchpad's own network, or the chain itself. All but that one are on BNB Chain. */
type Mode = "board" | "launchpad" | "token";

const isMainnetPage = (route: Route): route is PancakeRoute | PoolsRoute | { name: "token"; address: string } =>
  route.name === "token" || route.name === "launch" || route.name === "launch-create" || route.name === "mint" || route.name === "pools" || route.name === "pool";

interface ShellProps {
  route: Route;
  mode: Mode;
  locale: Locale;
  onLocale(next: Locale): void;
  children: ReactNode;
}

function NavLinks({ route, compact = false }: { route: Route; compact?: boolean }) {
  return (
    <>
      {NAV.filter((item) => !compact || !item.wide).map((item) => (
        <a key={item.href} href={item.href} aria-current={item.routes.includes(route.name) ? "page" : undefined}>
          {compact ? item.short ?? item.label : item.label}
        </a>
      ))}
    </>
  );
}

/** The network the page is on, and on the Flap launch page the language of its launch UI. */
function Controls({ mode, locale, onLocale }: Omit<ShellProps, "route" | "children">) {
  if (mode !== "launchpad") return <span className="pill pill-muted">{SITES.bsc.label}</span>;
  return (
    <>
      <span className="pill pill-muted">{FLAP_LAUNCH.short}</span>
      <LocaleSwitch locale={locale} onChange={onLocale} />
    </>
  );
}

const X_ACCOUNT = "https://x.com/callzfun";

/** CallZ's own account on X, in the top bar of every page. */
function XLink() {
  return (
    <a className="social-link" href={X_ACCOUNT} target="_blank" rel="noreferrer" aria-label="CallZ on X" title="CallZ on X" data-testid="x-link">
      <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
      </svg>
    </a>
  );
}

/** The network a page's wallet button checks for. */
const walletTarget = (mode: Mode): Site => (mode === "launchpad" ? FLAP_LAUNCH : SITES.bsc);

function DesktopShell({ route, children, ...controls }: ShellProps) {
  return (
    <div className="shell shell-desktop" data-testid="desktop-shell">
      <header className="topbar">
        <a className="brand" href="#/"><img src="/callz-logo.svg" alt="" width="30" height="30" />CallZ</a>
        <nav className="nav" aria-label="Main" data-testid="desktop-nav"><NavLinks route={route} /></nav>
        <div className="topbar-end">
          <XLink />
          <Controls {...controls} />
          <WalletButton target={walletTarget(controls.mode)} />
        </div>
      </header>
      <main className="content">{children}</main>
    </div>
  );
}

function MobileShell({ route, children, ...controls }: ShellProps) {
  return (
    <div className="shell shell-mobile" data-testid="mobile-shell">
      <header className="topbar">
        <a className="brand" href="#/"><img src="/callz-logo.svg" alt="" width="28" height="28" />CallZ</a>
        <div className="topbar-end">
          <XLink />
          <Controls {...controls} />
          <WalletButton target={walletTarget(controls.mode)} />
        </div>
      </header>
      <main className="content">{children}</main>
      <nav className="tabbar" aria-label="Main" data-testid="mobile-nav"><NavLinks route={route} compact /></nav>
    </div>
  );
}

const isLaunchpad = (route: Route): route is FlapLaunchRoute =>
  route.name === "flaplaunch" || route.name === "create" || route.name === "launcher";

export function App() {
  const route = useRoute();
  const mobile = useIsMobile();
  const [locale, setLocale] = useState<Locale>("en");
  const site = SITES.bsc;
  const Shell = mobile ? MobileShell : DesktopShell;

  // A pop-out window is only the chart and the chat: no navigation, no background scene.
  if (route.name === "pop") {
    return (
      <Suspense fallback={<p className="note" role="status">Loading…</p>}>
        <PopPage key={route.address} address={route.address} />
      </Suspense>
    );
  }

  return (
    <>
      <Backdrop />
      <Shell route={route} mode={isLaunchpad(route) ? "launchpad" : isMainnetPage(route) ? "token" : "board"} locale={locale} onLocale={setLocale}>
        {route.name === "home" && <HomePage site={site} mobile={mobile} />}
        {route.name === "scope" && <ScopePage site={site} mobile={mobile} />}
        {route.name === "launches" && <LaunchesPage site={site} mobile={mobile} />}
        {route.name === "tokens" && <TokensPage site={site} mobile={mobile} />}
        {route.name === "factories" && <FactoriesPage site={site} mobile={mobile} />}
        {route.name === "deployers" && <DeployersPage site={site} mobile={mobile} />}
        {isLaunchpad(route) && (
          <Suspense fallback={<p className="note" role="status">Loading the launchpad…</p>}>
            <FlapLaunchSection route={route} locale={locale} mobile={mobile} />
          </Suspense>
        )}
        {route.name === "token" && (
          <Suspense fallback={<p className="note" role="status">Loading the token…</p>}>
            <TokenPage key={route.address} address={route.address} mobile={mobile} />
          </Suspense>
        )}
        {(route.name === "launch" || route.name === "launch-create" || route.name === "mint") && (
          <Suspense fallback={<p className="note" role="status">Loading the launchpad…</p>}>
            <PancakeSection route={route} />
          </Suspense>
        )}
        {(route.name === "pools" || route.name === "pool") && (
          <Suspense fallback={<p className="note" role="status">Loading the pools…</p>}>
            <PoolsSection route={route} />
          </Suspense>
        )}
        {route.name === "review" && (
          <Suspense fallback={<p className="note" role="status">Loading the review queue…</p>}>
            <ReviewPage />
          </Suspense>
        )}
        {route.name === "missing" && <p className="note" role="alert">That page does not exist. <a href="#/">Back to the board.</a></p>}
      </Shell>
    </>
  );
}
