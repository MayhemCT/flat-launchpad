import { Suspense, lazy, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { DeployersPage, FactoriesPage, HomePage, LaunchesPage, TokensPage } from "./aggregator";
import { short } from "./format";
import { RAIDPASS, SITES, type ChainKey, type Site } from "./site";
import { connect, switchChain, useWallet } from "./wallet";
import { ScopePage } from "./scope";
import type { Locale, RaidPassRoute } from "./raidpass";

// The launchpad needs a chain library and the launch UI package: both load only when one of its pages opens.
const RaidPassSection = lazy(() => import("./raidpass"));
// A token's page trades through PancakeSwap, which needs the chain library too.
const TokenPage = lazy(() => import("./token"));

const LOCALES: ReadonlyArray<{ id: Locale; label: string }> = [
  { id: "en", label: "EN" },
  { id: "zh", label: "中文" },
  { id: "ko", label: "한국어" },
];

type AggregatorRoute = { name: "home" | "scope" | "launches" | "tokens" | "factories" | "deployers" };
type Route = AggregatorRoute | RaidPassRoute | { name: "token"; address: string } | { name: "missing" };

function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "") || "/";
  if (path === "/") return { name: "home" };
  if (path === "/scope" || path === "/launches" || path === "/tokens" || path === "/factories" || path === "/deployers") {
    return { name: path.slice(1) as AggregatorRoute["name"] };
  }
  if (path === "/launch" || path === "/raidpass") return { name: "raidpass" };
  const token = /^\/token\/(0x[0-9a-fA-F]{40})$/.exec(path);
  if (token?.[1]) return { name: "token", address: token[1].toLowerCase() };
  if (path === "/create") return { name: "create" };
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
  return <span className="pill" data-testid="wallet" title={wallet.account}>{short(wallet.account)}</span>;
}

/** Which chain the aggregator shows. The launchpad pages are always on RaidPass's own network. */
function ChainSwitch({ chain, onChange }: { chain: ChainKey; onChange(next: ChainKey): void }) {
  return (
    <div className="seg seg-small" role="group" aria-label="Network" data-testid="chain-switch">
      {(Object.keys(SITES) as ChainKey[]).map((key) => (
        <button key={key} type="button" aria-pressed={chain === key} onClick={() => onChange(key)}>{SITES[key].short}</button>
      ))}
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
const NAV: ReadonlyArray<{ href: string; label: string; short?: string; routes: ReadonlyArray<Route["name"]> }> = [
  { href: "#/scope", label: "Memescope", short: "Scope", routes: ["scope", "launches"] },
  { href: "#/tokens", label: "Tokens", routes: ["tokens"] },
  { href: "#/factories", label: "Factories", routes: ["factories"] },
  { href: "#/deployers", label: "Deployers", routes: ["deployers"] },
  { href: "#/launch", label: "Launch", routes: ["raidpass", "create", "launcher"] },
];

/** What a page works with: the index for either network, the launchpad's own network, or one mainnet token. */
type Mode = "board" | "launchpad" | "token";

interface ShellProps {
  route: Route;
  mode: Mode;
  chain: ChainKey;
  onChain(next: ChainKey): void;
  locale: Locale;
  onLocale(next: Locale): void;
  children: ReactNode;
}

function NavLinks({ route, compact = false }: { route: Route; compact?: boolean }) {
  return (
    <>
      {NAV.map((item) => (
        <a key={item.href} href={item.href} aria-current={item.routes.includes(route.name) ? "page" : undefined}>
          {compact ? item.short ?? item.label : item.label}
        </a>
      ))}
    </>
  );
}

/** The board picks its chain; the launchpad shows the one network it runs on and its language; a token page is on mainnet. */
function Controls({ mode, chain, onChain, locale, onLocale }: Omit<ShellProps, "route" | "children">) {
  if (mode === "token") return <span className="pill pill-muted">{SITES.bsc.label}</span>;
  return mode === "launchpad" ? (
    <>
      <span className="pill pill-muted">{RAIDPASS.short}</span>
      <LocaleSwitch locale={locale} onChange={onLocale} />
    </>
  ) : (
    <ChainSwitch chain={chain} onChange={onChain} />
  );
}

/** The network a page's wallet button checks for. */
const walletTarget = (mode: Mode, chain: ChainKey): Site => (mode === "launchpad" ? RAIDPASS : mode === "token" ? SITES.bsc : SITES[chain]);

function DesktopShell({ route, children, ...controls }: ShellProps) {
  return (
    <div className="shell shell-desktop" data-testid="desktop-shell">
      <header className="topbar">
        <a className="brand" href="#/"><img src="/callz-logo.svg" alt="" width="30" height="30" />CallZ</a>
        <nav className="nav" aria-label="Main" data-testid="desktop-nav"><NavLinks route={route} /></nav>
        <div className="topbar-end">
          <Controls {...controls} />
          <WalletButton target={walletTarget(controls.mode, controls.chain)} />
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
          <Controls {...controls} />
          {controls.mode !== "board" && <WalletButton target={walletTarget(controls.mode, controls.chain)} />}
        </div>
      </header>
      <main className="content">{children}</main>
      <nav className="tabbar" aria-label="Main" data-testid="mobile-nav"><NavLinks route={route} compact /></nav>
    </div>
  );
}

const isLaunchpad = (route: Route): route is RaidPassRoute =>
  route.name === "raidpass" || route.name === "create" || route.name === "launcher";

export function App() {
  const route = useRoute();
  const mobile = useIsMobile();
  const [locale, setLocale] = useState<Locale>("en");
  const [chain, setChain] = useState<ChainKey>("bsc");
  const site = SITES[chain];
  const Shell = mobile ? MobileShell : DesktopShell;

  return (
    <>
      <Backdrop />
      <Shell route={route} mode={isLaunchpad(route) ? "launchpad" : route.name === "token" ? "token" : "board"} chain={chain} onChain={setChain} locale={locale} onLocale={setLocale}>
        {route.name === "home" && <HomePage site={site} mobile={mobile} />}
        {route.name === "scope" && <ScopePage site={site} mobile={mobile} />}
        {route.name === "launches" && <LaunchesPage site={site} mobile={mobile} />}
        {route.name === "tokens" && <TokensPage site={site} mobile={mobile} />}
        {route.name === "factories" && <FactoriesPage site={site} mobile={mobile} />}
        {route.name === "deployers" && <DeployersPage site={site} mobile={mobile} />}
        {isLaunchpad(route) && (
          <Suspense fallback={<p className="note" role="status">Loading the launchpad…</p>}>
            <RaidPassSection route={route} locale={locale} mobile={mobile} />
          </Suspense>
        )}
        {route.name === "token" && (
          <Suspense fallback={<p className="note" role="status">Loading the token…</p>}>
            <TokenPage key={route.address} address={route.address} mobile={mobile} />
          </Suspense>
        )}
        {route.name === "missing" && <p className="note" role="alert">That page does not exist. <a href="#/">Back to the board.</a></p>}
      </Shell>
    </>
  );
}
