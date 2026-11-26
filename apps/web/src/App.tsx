import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { formatEther, isAddress, type Address } from "viem";
import { Launcher, LauncherConfig } from "@launcher-ui/Component";
import i18n from "@launcher-ui/i18n.json";
import { CHAIN_ID, FACTORY, NETWORK, factoryAbi, launcherSummaryAbi } from "./config";
import { belongsToFactory, createHost, publicClient, readSnapshot, type Snapshot } from "./host";
import { connect, switchChain, useWallet } from "./wallet";

type Locale = "en" | "zh" | "ko";
const LOCALES: ReadonlyArray<{ id: Locale; label: string }> = [
  { id: "en", label: "EN" },
  { id: "zh", label: "中文" },
  { id: "ko", label: "한국어" },
];
const messagesByLocale = i18n as Record<Locale, Record<string, string>>;
const identity = { chainId: CHAIN_ID, factoryAddress: FACTORY };

type Route = { name: "home" } | { name: "create" } | { name: "launcher"; address: Address } | { name: "missing" };

function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "") || "/";
  if (path === "/") return { name: "home" };
  if (path === "/create") return { name: "create" };
  const launcher = /^\/launcher\/(0x[0-9a-fA-F]{40})$/.exec(path);
  if (launcher?.[1] && isAddress(launcher[1])) return { name: "launcher", address: launcher[1].toLowerCase() as Address };
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
  const query = "(max-width: 767px)";
  return useSyncExternalStore(
    (listener) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", listener);
      return () => media.removeEventListener("change", listener);
    },
    () => window.matchMedia(query).matches,
  );
}

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

function Backdrop() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let disposed = false;
    let handle: { dispose(): void } | undefined;
    // After first paint, and only then, fetch three.js and start the scene.
    const begin = () => {
      void import("./scene").then(({ startScene }) => {
        if (!disposed && canvas.current) handle = startScene(canvas.current);
      });
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

function WalletButton() {
  const wallet = useWallet();
  if (!wallet.available) {
    return <span className="pill pill-muted" data-testid="wallet">No wallet found</span>;
  }
  if (!wallet.account) {
    return <button type="button" className="button" data-testid="wallet" onClick={connect}>Connect wallet</button>;
  }
  if (wallet.chainId !== NETWORK.chain.id) {
    return (
      <button type="button" className="button button-warn" data-testid="wallet" onClick={() => void switchChain().catch(() => undefined)}>
        Switch to {NETWORK.label}
      </button>
    );
  }
  return <span className="pill" data-testid="wallet" title={wallet.account}>{short(wallet.account)}</span>;
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

const NAV: ReadonlyArray<{ href: string; label: string; route: Route["name"] }> = [
  { href: "#/", label: "Launches", route: "home" },
  { href: "#/create", label: "Create", route: "create" },
];

function DesktopShell({ route, locale, onLocale, children }: ShellProps) {
  return (
    <div className="shell shell-desktop" data-testid="desktop-shell">
      <header className="topbar">
        <a className="brand" href="#/"><img src="/raidpass-logo.svg" alt="" width="28" height="28" />RaidPass</a>
        <nav className="nav" aria-label="Main" data-testid="desktop-nav">
          {NAV.map((item) => (
            <a key={item.href} href={item.href} aria-current={route.name === item.route ? "page" : undefined}>{item.label}</a>
          ))}
        </nav>
        <div className="topbar-end">
          <span className="pill pill-muted">{NETWORK.label}</span>
          <LocaleSwitch locale={locale} onChange={onLocale} />
          <WalletButton />
        </div>
      </header>
      <main className="content">{children}</main>
    </div>
  );
}

function MobileShell({ route, locale, onLocale, children }: ShellProps) {
  return (
    <div className="shell shell-mobile" data-testid="mobile-shell">
      <header className="topbar">
        <a className="brand" href="#/"><img src="/raidpass-logo.svg" alt="" width="26" height="26" />RaidPass</a>
        <div className="topbar-end">
          <LocaleSwitch locale={locale} onChange={onLocale} />
          <WalletButton />
        </div>
      </header>
      <main className="content">{children}</main>
      <nav className="tabbar" aria-label="Main" data-testid="mobile-nav">
        {NAV.map((item) => (
          <a key={item.href} href={item.href} aria-current={route.name === item.route ? "page" : undefined}>{item.label}</a>
        ))}
      </nav>
    </div>
  );
}

interface ShellProps {
  route: Route;
  locale: Locale;
  onLocale(next: Locale): void;
  children: ReactNode;
}

interface LaunchRow {
  address: Address;
  name: string;
  symbol: string;
  minted: bigint;
  maxNFTs: bigint;
  cap: bigint;
  raised: bigint;
  launched: boolean;
  deadline: bigint;
}

type Launches =
  | { state: "loading" }
  | { state: "not-deployed" }
  | { state: "error" }
  | { state: "ready"; rows: LaunchRow[] };

async function loadLaunches(): Promise<Launches> {
  const code = await publicClient.getCode({ address: FACTORY });
  if (!code || code === "0x") return { state: "not-deployed" };
  const count = Number(await publicClient.readContract({ address: FACTORY, abi: factoryAbi, functionName: "launcherCount" }));
  const newest = Array.from({ length: Math.min(count, 50) }, (_, index) => BigInt(count - 1 - index));
  if (newest.length === 0) return { state: "ready", rows: [] };

  const addresses = await publicClient.multicall({
    allowFailure: false,
    contracts: newest.map((index) => ({ address: FACTORY, abi: factoryAbi, functionName: "launchers" as const, args: [index] as const })),
  });
  const fields = ["tokenName", "tokenSymbol", "minted", "maxNFTs", "cap", "raised", "launched", "saleDeadline"] as const;
  const values = await publicClient.multicall({
    allowFailure: false,
    contracts: addresses.flatMap((address) => fields.map((functionName) => ({ address, abi: launcherSummaryAbi, functionName }))),
  });
  const rows = addresses.map((address, row) => {
    const at = (column: number) => values[row * fields.length + column];
    return {
      address: address.toLowerCase() as Address,
      name: at(0) as string,
      symbol: at(1) as string,
      minted: at(2) as bigint,
      maxNFTs: at(3) as bigint,
      cap: at(4) as bigint,
      raised: at(5) as bigint,
      launched: at(6) as boolean,
      deadline: at(7) as bigint,
    };
  });
  return { state: "ready", rows };
}

function statusOf(row: LaunchRow): { label: string; tone: "good" | "gold" | "muted" } {
  if (row.launched) return { label: "Launched", tone: "good" };
  if (BigInt(Math.floor(Date.now() / 1000)) < row.deadline) return { label: "Minting", tone: "gold" };
  return { label: "Refunds open", tone: "muted" };
}

function LaunchList({ mobile }: { mobile: boolean }) {
  const [launches, setLaunches] = useState<Launches>({ state: "loading" });
  useEffect(() => {
    let current = true;
    loadLaunches().then(
      (next) => current && setLaunches(next),
      () => current && setLaunches({ state: "error" }),
    );
    return () => {
      current = false;
    };
  }, []);

  if (launches.state === "loading") return <p className="note" role="status">Reading launches from {NETWORK.label}…</p>;
  if (launches.state === "error") return <p className="note" role="alert">The launches could not be read from {NETWORK.label}. Reload to try again.</p>;
  if (launches.state === "not-deployed") {
    return (
      <p className="note" data-testid="not-deployed">
        The RaidPass Launcher Factory is not deployed on {NETWORK.label} yet. It will be at{" "}
        <a href={`${NETWORK.explorer}/address/${FACTORY}`} target="_blank" rel="noreferrer"><code>{FACTORY}</code></a>.
      </p>
    );
  }
  if (launches.rows.length === 0) return <p className="note">No mints yet. <a href="#/create">Create the first one.</a></p>;

  if (mobile) {
    return (
      <ul className="cards" data-testid="launch-cards">
        {launches.rows.map((row) => {
          const status = statusOf(row);
          return (
            <li key={row.address}>
              <a className="card" href={`#/launcher/${row.address}`}>
                <span className="card-head">
                  <strong>{row.name}</strong>
                  <span className={`tag tag-${status.tone}`}>{status.label}</span>
                </span>
                <span className="card-line">{row.symbol} · {row.minted.toString()} / {row.maxNFTs.toString()} NFTs</span>
                <span className="card-line">{formatEther(row.raised)} of {formatEther(row.cap)} {NETWORK.unit}</span>
              </a>
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <div className="table-wrap">
      <table className="table" data-testid="launch-table">
        <thead>
          <tr><th>Token</th><th>NFTs minted</th><th>Raised</th><th>Cap</th><th>Status</th><th>Launcher</th></tr>
        </thead>
        <tbody>
          {launches.rows.map((row) => {
            const status = statusOf(row);
            return (
              <tr key={row.address}>
                <td><a href={`#/launcher/${row.address}`}><strong>{row.name}</strong> <span className="dim">{row.symbol}</span></a></td>
                <td className="num">{row.minted.toString()} / {row.maxNFTs.toString()}</td>
                <td className="num">{formatEther(row.raised)} {NETWORK.unit}</td>
                <td className="num">{formatEther(row.cap)} {NETWORK.unit}</td>
                <td><span className={`tag tag-${status.tone}`}>{status.label}</span></td>
                <td><code>{short(row.address)}</code></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Home({ mobile }: { mobile: boolean }) {
  return (
    <>
      <section className="hero">
        <p className="eyebrow">Built on Flap Pool Launch · {NETWORK.label}</p>
        <h1>The presale is an NFT mint.</h1>
        <p className="lede">
          Buyers mint RaidPass NFTs at a flat price. The mint that reaches the cap launches the token straight into a
          liquidity pool, with the LP burned. Every NFT then claims an equal share of the supply and stays in your
          wallet as a pass.
        </p>
        <div className="actions">
          <a className="button" href="#/create">Create a mint</a>
          <a className="button button-quiet" href="https://github.com/MayhemCT/flat-launchpad" target="_blank" rel="noreferrer">Source</a>
        </div>
      </section>
      <ol className="steps">
        <li><strong>Mint.</strong> One flat price per NFT, up to a cap of at most 10 {NETWORK.unit}.</li>
        <li><strong>Launch.</strong> The last mint seeds the pool with the whole raise in the same transaction.</li>
        <li><strong>Claim, or refund.</strong> Each NFT claims once. If the cap is missed, burn the NFT for its price.</li>
      </ol>
      <section>
        <h2>Launches</h2>
        <LaunchList mobile={mobile} />
      </section>
    </>
  );
}

function LauncherPage({ address, locale }: { address: Address; locale: Locale }) {
  const wallet = useWallet();
  const [valid, setValid] = useState<boolean | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    let current = true;
    setValid(null);
    setSnapshot(null);
    belongsToFactory(address).then(
      (ok) => current && setValid(ok),
      () => current && setValid(false),
    );
    return () => {
      current = false;
    };
  }, [address]);

  useEffect(() => {
    if (!valid) return;
    let current = true;
    const load = () => {
      readSnapshot(address, wallet.account).then(
        (next) => current && setSnapshot(next),
        () => undefined,
      );
    };
    load();
    const timer = window.setInterval(load, 8000);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [address, valid, wallet.account, tick]);

  const host = useMemo(
    () => createHost({ launcher: address, refresh, openLauncher: (next) => (window.location.hash = `#/launcher/${next}`) }),
    // The host carries the wallet's current state, so it is rebuilt whenever that changes.
    [address, refresh, wallet.account, wallet.chainId, wallet.pendingHash, wallet.available],
  );

  if (valid === null) return <p className="note" role="status">Checking this Launcher with the Portal…</p>;
  if (!valid) {
    return (
      <p className="note" role="alert" data-testid="unknown-launcher">
        <code>{short(address)}</code> is not a Launcher created by the RaidPass factory on {NETWORK.label}.
      </p>
    );
  }
  const token = typeof snapshot?.token === "string" ? snapshot.token : null;
  return (
    <>
      <Launcher context={{ identity, locale, launcherAddress: address, snapshot }} messages={messagesByLocale[locale]} host={host} />
      <p className="links">
        <a href={`${NETWORK.explorer}/address/${address}`} target="_blank" rel="noreferrer">Launcher on the explorer</a>
        {snapshot?.launched === true && token && (
          <a href={`${NETWORK.flapTokenPath}/${token}`} target="_blank" rel="noreferrer">Token on Flap</a>
        )}
      </p>
    </>
  );
}

function CreatePage({ locale }: { locale: Locale }) {
  const wallet = useWallet();
  const host = useMemo(
    () => createHost({ launcher: null, refresh: () => undefined, openLauncher: (next) => (window.location.hash = `#/launcher/${next}`) }),
    [wallet.account, wallet.chainId, wallet.pendingHash, wallet.available],
  );
  return <LauncherConfig context={{ identity, locale }} messages={messagesByLocale[locale]} host={host} />;
}

export function App() {
  const route = useRoute();
  const mobile = useIsMobile();
  const [locale, setLocale] = useState<Locale>("en");
  const Shell = mobile ? MobileShell : DesktopShell;

  return (
    <>
      <Backdrop />
      <Shell route={route} locale={locale} onLocale={setLocale}>
        {route.name === "home" && <Home mobile={mobile} />}
        {route.name === "create" && <CreatePage locale={locale} />}
        {route.name === "launcher" && <LauncherPage address={route.address} locale={locale} />}
        {route.name === "missing" && <p className="note" role="alert">That page does not exist. <a href="#/">Back to launches.</a></p>}
      </Shell>
    </>
  );
}
