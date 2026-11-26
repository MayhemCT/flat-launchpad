// The aggregator: every Pool Launch launch, token, factory and deployer, across all factories.
// Data comes from this site's own index (/api). These pages need no wallet and import no chain library.
import { useMemo, useState, type ReactNode } from "react";
import { localized, parseLauncherDescription } from "@flat/protocol/description";
import {
  useApi,
  type DeployerRow,
  type Factories,
  type LauncherRow,
  type Loaded,
  type Overview,
  type Page,
  type TokenRow,
} from "./api";
import { ago, amount, compact, percent, price, short } from "./format";
import { platformOf } from "./platform";
import { LaunchModes, PlatformTag, TokenImage } from "./scope";
import { FACTORY, RAIDPASS_CHAIN, ZERO_ADDRESS, explorerAddressUrl, flapLauncherUrl, flapTokenUrl, type Site } from "./site";

interface PageProps {
  site: Site;
  mobile: boolean;
}

function Status<T>({ result, children }: { result: Loaded<T>; children(data: T): ReactNode }) {
  if (result.state === "loading") return <p className="note" role="status">Loading…</p>;
  if (result.state === "error") return <p className="note" role="alert">The index could not be reached. Reload to try again.</p>;
  return <>{children(result.data)}</>;
}

const isRaidPass = (site: Site, factory: string | null) => site.key === RAIDPASS_CHAIN && factory === FACTORY;

/** Where a Launcher opens: our own mint page for a CallZ mint, its page on Flap for any other factory. */
function launcherLink(site: Site, row: LauncherRow) {
  return isRaidPass(site, row.factory)
    ? { href: `#/launcher/${row.address}`, external: false }
    : { href: flapLauncherUrl(site, row.address), external: true };
}

function LaunchCard({ site, row }: { site: Site; row: LauncherRow }) {
  const parsed = useMemo(() => parseLauncherDescription(row.description), [row.description]);
  const description = parsed.kind === "v1" ? parsed.description : null;
  const name = description?.name ?? row.token?.symbol ?? short(row.address);
  const symbol = description?.symbol ?? row.token?.symbol ?? "";
  const title = description ? localized(description.titles, "en") : undefined;
  const summary = description ? localized(description.summaries, "en") : parsed.kind === "text" ? parsed.text : undefined;
  const nativeQuote = !description?.quoteToken || description.quoteToken === ZERO_ADDRESS;
  const link = launcherLink(site, row);
  const status = row.token ? (row.token.graduated ? "Graduated" : "Launched") : "Raising";
  const tone = row.token ? (row.token.graduated ? "good" : "gold") : "muted";

  return (
    <a className="launch-card" data-testid="launch-card" href={link.href} {...(link.external ? { target: "_blank", rel: "noreferrer" } : {})}>
      <span className="launch-head">
        <span className="avatar" aria-hidden="true">{[...(symbol || name)][0] ?? "?"}</span>
        <span className="launch-name">
          <strong>{name}</strong>
          <span className="dim">{symbol}</span>
        </span>
        <span className={`tag tag-${tone}`}>{status}</span>
      </span>
      {title && <span className="launch-title">{title}</span>}
      {summary && <span className="launch-summary">{summary}</span>}
      <span className="launch-stats">
        <span>
          <span className="stat-label">Target</span>
          <span className="num">{amount(description?.targetRaise)} {nativeQuote ? site.unit : "quote"}</span>
        </span>
        <span>
          <span className="stat-label">In pool</span>
          <span className="num">{percent(description?.poolTokenRatio)}</span>
        </span>
        <span>
          <span className="stat-label">Created</span>
          <span className="num">{ago(row.timestamp)}</span>
        </span>
      </span>
      <span className="launch-foot">
        {isRaidPass(site, row.factory) ? <span className="tag tag-gold">CallZ</span> : <span className="dim">Factory {short(row.factory)}</span>}
        <span className="dim">{link.external ? "Open on Flap ↗" : "Open mint →"}</span>
      </span>
    </a>
  );
}

function LaunchGrid({ site, rows }: { site: Site; rows: LauncherRow[] }) {
  if (rows.length === 0) return <p className="note" data-testid="empty">No launches here yet.</p>;
  return (
    <div className="grid" data-testid="launch-grid">
      {rows.map((row) => <LaunchCard key={row.address} site={site} row={row} />)}
    </div>
  );
}

function StatStrip({ site }: { site: Site }) {
  const overview = useApi<Overview>(site.key, "overview", 30_000);
  const counts = overview.state === "ready" ? overview.data.counts : null;
  const sync = overview.state === "ready" ? overview.data.sync : null;
  const stats: Array<[string, number | undefined]> = [
    ["Launchers", counts?.launchers],
    ["Tokens launched", counts?.tokens],
    ["Graduated", counts?.graduated],
    ["Launcher factories", counts?.launcherFactories],
    ["Deployers", counts?.deployers],
  ];
  return (
    <section aria-label={`${site.label} totals`}>
      <dl className="stats" data-testid="stats">
        {stats.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className="num">{value === undefined ? "—" : value.toLocaleString("en")}</dd>
          </div>
        ))}
      </dl>
      <p className="sync">
        <span className="live">LIVE</span>
        {sync ? `${site.label} · indexed to block ${sync.head.toLocaleString("en")} · ${ago(sync.updatedAt)}` : `${site.label} · waiting for the index`}
      </p>
    </section>
  );
}

export function HomePage({ site, mobile }: PageProps) {
  const newest = useApi<Page<LauncherRow>>(site.key, `launchers?limit=${mobile ? 4 : 6}`, 30_000);
  return (
    <>
      <section className="hero">
        <p className="eyebrow">Built on Flap Pool Launch · BNB Chain</p>
        <h1>Mint the pass. <span className="accent">Make the call.</span></h1>
        <p className="lede">
          Mint an NFT pass to help fund a token's first liquidity pool. After launch, use the same pass to join the
          holder room and earn rewards for verified callouts.
        </p>
        <div className="actions">
          <a className="button" href="#/scope">Open Memescope</a>
          <a className="button button-quiet" href="#/launch">Launch a pass mint</a>
          <a className="button button-quiet" href="https://flap.sh" target="_blank" rel="noreferrer">Flap ↗</a>
        </div>
      </section>
      <StatStrip site={site} />
      <section>
        <div className="section-head">
          <h2>Newest launches</h2>
          <a href="#/launches">See all →</a>
        </div>
        <Status result={newest}>{(data) => <LaunchGrid site={site} rows={data.items} />}</Status>
      </section>
    </>
  );
}

type LaunchFilter = "all" | "raising" | "launched" | "raidpass";
const FILTERS: ReadonlyArray<{ id: LaunchFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "raising", label: "Raising" },
  { id: "launched", label: "Launched" },
  { id: "raidpass", label: "CallZ" },
];

export function LaunchesPage({ site }: PageProps) {
  const [filter, setFilter] = useState<LaunchFilter>("all");
  const launches = useApi<Page<LauncherRow>>(site.key, "launchers?limit=200", 30_000);
  return (
    <>
      <div className="page-head">
        <div className="scope-head">
          <h1 className="page-title">Launches</h1>
          <LaunchModes mode="board" />
        </div>
        <p className="lede">Every Launcher created through the Pool Launch Portal on {site.label}, newest first.</p>
      </div>
      <div className="seg" role="tablist" aria-label="Filter launches">
        {FILTERS.map(({ id, label }) => (
          <button key={id} type="button" role="tab" aria-selected={filter === id} onClick={() => setFilter(id)}>{label}</button>
        ))}
      </div>
      <Status result={launches}>
        {(data) => (
          <LaunchGrid
            site={site}
            rows={data.items.filter((row) =>
              filter === "raising" ? !row.token : filter === "launched" ? !!row.token : filter === "raidpass" ? isRaidPass(site, row.factory) : true,
            )}
          />
        )}
      </Status>
    </>
  );
}

/** A launched token's page: this site's own on mainnet (chart, trading, chat), Flap's on testnet. */
function tokenLink(site: Site, token: string) {
  return site.key === "bsc" ? { href: `#/token/${token}` } : { href: flapTokenUrl(site, token), target: "_blank", rel: "noreferrer" };
}

function ExternalAddress({ site, address }: { site: Site; address: string }) {
  return <a href={explorerAddressUrl(site, address)} target="_blank" rel="noreferrer"><code>{short(address)}</code></a>;
}

export function TokensPage({ site, mobile }: PageProps) {
  const tokens = useApi<Page<TokenRow>>(site.key, "tokens?limit=200", 30_000);
  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Tokens</h1>
        <p className="lede">Every token launched through Pool Launch on {site.label}. A token graduates when its pool clears Flap's floor at launch.{site.key === "bsc" ? " Open one for its chart, trading and chat." : ""}</p>
      </div>
      <Status result={tokens}>
        {(data) => {
          if (data.items.length === 0) return <p className="note" data-testid="empty">No tokens have launched here yet.</p>;
          if (mobile) {
            return (
              <ul className="cards" data-testid="token-cards">
                {data.items.map((token) => (
                  <li key={token.address}>
                    <a className="card" {...tokenLink(site, token.address)}>
                      <span className="card-head">
                        <span className="token-cell">
                          <TokenImage key={token.image ?? "none"} image={token.image} label={token.symbol || token.name || "?"} colour="var(--line)" size={32} />
                          <strong>{token.name ?? short(token.address)}</strong>
                        </span>
                        <span className={`tag tag-${token.graduated ? "good" : "muted"}`}>{token.graduated ? "Graduated" : "New"}</span>
                      </span>
                      <span className="card-line">{token.symbol} · supply {compact(token.totalSupply)}</span>
                      <span className="card-line">Opening price {price(token.initialPriceWad)} · {ago(token.timestamp)}</span>
                    </a>
                  </li>
                ))}
              </ul>
            );
          }
          return (
            <div className="table-wrap">
              <table className="table" data-testid="token-table">
                <thead>
                  <tr><th>Token</th><th>Supply</th><th>Opening price</th><th>Status</th><th>Launched via</th><th>Vault</th><th>Launched</th><th>Creator</th></tr>
                </thead>
                <tbody>
                  {data.items.map((token) => (
                    <tr key={token.address}>
                      <td>
                        <a className="token-cell" {...tokenLink(site, token.address)}>
                          <TokenImage key={token.image ?? "none"} image={token.image} label={token.symbol || token.name || "?"} colour="var(--line)" size={32} />
                          <strong>{token.name ?? short(token.address)}</strong> <span className="dim">{token.symbol}</span>
                        </a>
                      </td>
                      <td className="num">{compact(token.totalSupply)}</td>
                      <td className="num">{price(token.initialPriceWad)}</td>
                      <td><span className={`tag tag-${token.graduated ? "good" : "muted"}`}>{token.graduated ? "Graduated" : "New"}</span></td>
                      <td>{token.launcherFactory ? (isRaidPass(site, token.launcherFactory) ? "CallZ" : <>Launcher <code>{short(token.launcherFactory)}</code></>) : "Direct"}</td>
                      <td>{token.vault ? "Yes" : "—"}</td>
                      <td className="num">{ago(token.timestamp)}</td>
                      <td><ExternalAddress site={site} address={token.creator} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }}
      </Status>
    </>
  );
}

const RISK = ["Unverified", "Low", "Low to medium", "Medium", "High"];

export function FactoriesPage({ site, mobile }: PageProps) {
  const factories = useApi<Factories>(site.key, "factories", 60_000);
  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Factories</h1>
        <p className="lede">The launchpads built on Pool Launch. Each Launcher Factory is one launchpad's contract: it deploys one Launcher per launch, and is named here by the title its launches carry. A Vault Factory deploys a token's vault. <a href="#/deployers">See who deploys →</a></p>
      </div>
      <Status result={factories}>
        {(data) => {
          const titles = new Map(data.launcher.map((factory) => [factory.address, factory.title]));
          return (
          <>
            <section>
              <h2>Launchpads <span className="dim">{data.launcher.length} Launcher Factories</span></h2>
              {data.launcher.length === 0 ? <p className="note" data-testid="empty">None yet.</p> : mobile ? (
                <ul className="cards" data-testid="factory-cards">
                  {data.launcher.map((factory) => (
                    <li key={factory.address}>
                      <a className="card" href={explorerAddressUrl(site, factory.address)} target="_blank" rel="noreferrer">
                        <span className="card-head">
                          <PlatformTag platform={platformOf(site, factory.address, titles)} />
                          <span className={`tag tag-${factory.enabled ? "good" : "muted"}`}>{factory.enabled ? "Enabled" : "Not enabled"}</span>
                        </span>
                        <span className="card-line">{short(factory.address)}</span>
                        <span className="card-line">{factory.launchers} launchers · {factory.tokens} launched · {factory.graduated} graduated</span>
                        <span className="card-line">{factory.deployers} deployers · floor {factory.multiplierBps === null ? "—" : `${factory.multiplierBps / 100}%`}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="table-wrap">
                  <table className="table" data-testid="factory-table">
                    <thead>
                      <tr><th>Launchpad</th><th>Factory</th><th>Status</th><th>Floor multiplier</th><th>Launchers</th><th>Launched</th><th>Graduated</th><th>Deployers</th></tr>
                    </thead>
                    <tbody>
                      {data.launcher.map((factory) => (
                        <tr key={factory.address}>
                          <td><PlatformTag platform={platformOf(site, factory.address, titles)} /></td>
                          <td><ExternalAddress site={site} address={factory.address} /></td>
                          <td><span className={`tag tag-${factory.enabled ? "good" : "muted"}`}>{factory.enabled ? "Enabled" : "Not enabled"}</span></td>
                          <td className="num">{factory.multiplierBps === null ? "—" : `${factory.multiplierBps / 100}%`}</td>
                          <td className="num">{factory.launchers}</td>
                          <td className="num">{factory.tokens}</td>
                          <td className="num">{factory.graduated}</td>
                          <td className="num">{factory.deployers}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <section>
              <h2>Vault factories <span className="dim">{data.vault.length}</span></h2>
              {data.vault.length === 0 ? <p className="note">None yet.</p> : mobile ? (
                <ul className="cards">
                  {data.vault.map((factory) => (
                    <li key={factory.address}>
                      <a className="card" href={explorerAddressUrl(site, factory.address)} target="_blank" rel="noreferrer">
                        <span className="card-head">
                          <strong>{short(factory.address)}</strong>
                          <span className="tag tag-muted">{RISK[factory.riskLevel ?? 0] ?? "Unverified"}</span>
                        </span>
                        <span className="card-line">{factory.vaults} vaults · {factory.graduated} graduated · {factory.deployers} deployers</span>
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>Factory</th><th>Risk</th><th>Vaults</th><th>Graduated</th><th>Deployers</th></tr></thead>
                    <tbody>
                      {data.vault.map((factory) => (
                        <tr key={factory.address}>
                          <td><ExternalAddress site={site} address={factory.address} /></td>
                          <td>{RISK[factory.riskLevel ?? 0] ?? "Unverified"}</td>
                          <td className="num">{factory.vaults}</td>
                          <td className="num">{factory.graduated}</td>
                          <td className="num">{factory.deployers}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
          );
        }}
      </Status>
    </>
  );
}

export function DeployersPage({ site, mobile }: PageProps) {
  const deployers = useApi<Page<DeployerRow>>(site.key, "deployers?limit=200", 60_000);
  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Deployers</h1>
        <p className="lede">Every wallet that created a Launcher or launched a token on {site.label}, most active first.</p>
      </div>
      <Status result={deployers}>
        {(data) => {
          if (data.items.length === 0) return <p className="note" data-testid="empty">No deployers yet.</p>;
          if (mobile) {
            return (
              <ul className="cards" data-testid="deployer-cards">
                {data.items.map((deployer, index) => (
                  <li key={deployer.address}>
                    <a className="card" href={explorerAddressUrl(site, deployer.address)} target="_blank" rel="noreferrer">
                      <span className="card-head">
                        <strong>#{index + 1} <code>{short(deployer.address)}</code></strong>
                        <span className="dim">{ago(deployer.lastSeenAt)}</span>
                      </span>
                      <span className="card-line">{deployer.launchers} launchers · {deployer.tokens} tokens · {deployer.graduated} graduated</span>
                    </a>
                  </li>
                ))}
              </ul>
            );
          }
          return (
            <div className="table-wrap">
              <table className="table" data-testid="deployer-table">
                <thead>
                  <tr><th>#</th><th>Wallet</th><th>Launchers</th><th>Tokens</th><th>Graduated</th><th>Factories used</th><th>First seen</th><th>Last seen</th></tr>
                </thead>
                <tbody>
                  {data.items.map((deployer, index) => (
                    <tr key={deployer.address}>
                      <td className="num">{index + 1}</td>
                      <td><ExternalAddress site={site} address={deployer.address} /></td>
                      <td className="num">{deployer.launchers}</td>
                      <td className="num">{deployer.tokens}</td>
                      <td className="num">{deployer.graduated}</td>
                      <td className="num">{deployer.factories}</td>
                      <td className="num">{ago(deployer.firstSeenAt)}</td>
                      <td className="num">{ago(deployer.lastSeenAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }}
      </Status>
    </>
  );
}
