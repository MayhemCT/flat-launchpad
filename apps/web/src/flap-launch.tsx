// The CallZ launchpad: our own section of the site. It talks to the chain and the visitor's wallet, so it
// (and the chain library it needs) loads only when one of its pages is opened.
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatEther, type Address } from "viem";
import { Launcher, LauncherConfig } from "@launcher-ui/Component";
import i18n from "@launcher-ui/i18n.json";
import { CHAIN_ID, EARLIER_FACTORIES, FACTORY, NETWORK, factoryAbi, launcherSummaryAbi } from "./config";
import { formatMinimum, readFloorGuide, readLaunchability, type FloorGuide, type Launchability } from "./floor";
import { short } from "./format";
import { belongsToFactory, createHost, deployFactory, publicClient, readSnapshot, type Snapshot } from "./host";
import { useWallet } from "./wallet";

export type Locale = "en" | "zh" | "ko";
const messagesByLocale = i18n as Record<Locale, Record<string, string>>;
const identity = { chainId: CHAIN_ID, factoryAddress: FACTORY };
const openLauncher = (address: string) => {
  window.location.hash = `#/launcher/${address}`;
};

export type FlapLaunchRoute = { name: "flaplaunch" } | { name: "create" } | { name: "launcher"; address: string };

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

/** `deployed` is whether the current factory has code. The rows are its mints and the earlier factories'. */
type Launches = { state: "loading" } | { state: "error" } | { state: "ready"; deployed: boolean; rows: LaunchRow[] };

/** The newest 50 Launchers of one factory, newest first, or `null` when the factory has no code on this network. */
async function launchersOf(factory: Address): Promise<Address[] | null> {
  const code = await publicClient.getCode({ address: factory });
  if (!code || code === "0x") return null;
  const count = Number(await publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "launcherCount" }));
  const newest = Array.from({ length: Math.min(count, 50) }, (_, index) => BigInt(count - 1 - index));
  if (newest.length === 0) return [];
  return [
    ...(await publicClient.multicall({
      allowFailure: false,
      contracts: newest.map((index) => ({ address: factory, abi: factoryAbi, functionName: "launchers" as const, args: [index] as const })),
    })),
  ];
}

/**
 * CallZ mints, read straight from the factories' own lists: current to the block, with no indexer in between.
 * The current factory's mints come first, then those of each earlier factory.
 */
async function loadLaunches(): Promise<Launches> {
  const lists = await Promise.all([FACTORY, ...EARLIER_FACTORIES].map(launchersOf));
  const deployed = lists[0] !== null;
  const addresses = lists.flatMap((list) => list ?? []);
  if (addresses.length === 0) return { state: "ready", deployed, rows: [] };

  const fields = ["tokenName", "tokenSymbol", "minted", "maxNFTs", "cap", "raised", "launched", "saleDeadline"] as const;
  const values = await publicClient.multicall({
    allowFailure: false,
    contracts: addresses.flatMap((address) => fields.map((functionName) => ({ address, abi: launcherSummaryAbi, functionName }))),
  });
  return {
    state: "ready",
    deployed,
    rows: addresses.map((address, row) => {
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
    }),
  };
}

function statusOf(row: LaunchRow): { label: string; tone: "good" | "gold" | "muted" } {
  if (row.launched) return { label: "Launched", tone: "good" };
  if (BigInt(Math.floor(Date.now() / 1000)) < row.deadline) return { label: "Minting", tone: "gold" };
  return { label: "Refunds open", tone: "muted" };
}

const DEPLOY_ERRORS: Record<string, string> = {
  walletUnavailable: "No browser wallet was found.",
  connectWallet: "Connect your wallet first.",
  wrongChain: `Switch your wallet to ${NETWORK.label} first.`,
  walletRejected: "The request was rejected in the wallet.",
  simulationFailed: "The deployment would revert. The factory may already be deployed: reload the page.",
};

/** Shown while the factory has no code on this network: one transaction from any wallet deploys it. */
function DeployFactory({ onDeployed }: { onDeployed(): void }) {
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const ready = wallet.available && !!wallet.account && wallet.chainId === NETWORK.chain.id;

  const deploy = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await deployFactory();
      if (result.status === "success") onDeployed();
      else if (result.status === "reverted") setMessage("The deployment transaction reverted.");
      else setMessage("The transaction was sent but has no receipt yet. Reload the page in a moment.");
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "";
      setMessage(DEPLOY_ERRORS[code] ?? "The deployment could not be sent.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="note" data-testid="not-deployed">
      <p>
        The CallZ Launcher Factory is not deployed on {NETWORK.label} yet. It will be at{" "}
        <a href={`${NETWORK.explorer}/address/${FACTORY}`} target="_blank" rel="noreferrer"><code>{FACTORY}</code></a>,
        whoever deploys it.
      </p>
      <div className="actions">
        <button type="button" className="button" disabled={busy || !ready} onClick={() => void deploy()}>
          {busy ? "Deploying…" : "Deploy the factory"}
        </button>
      </div>
      {!ready && <p className="dim">Connect a wallet on {NETWORK.label} to deploy it. It is one transaction and costs only gas.</p>}
      {message && <p role="alert">{message}</p>}
    </div>
  );
}

function MintList({ mobile }: { mobile: boolean }) {
  const [launches, setLaunches] = useState<Launches>({ state: "loading" });
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let current = true;
    loadLaunches().then(
      (next) => current && setLaunches(next),
      () => current && setLaunches({ state: "error" }),
    );
    return () => {
      current = false;
    };
  }, [reload]);

  if (launches.state === "loading") return <p className="note" role="status">Reading CallZ mints from {NETWORK.label}…</p>;
  if (launches.state === "error") return <p className="note" role="alert">The mints could not be read from {NETWORK.label}. Reload to try again.</p>;
  // While the current factory has no code, one transaction deploys it. Mints of an earlier factory are listed
  // under that note either way.
  const deploy = launches.deployed ? null : <DeployFactory onDeployed={() => setReload((value) => value + 1)} />;
  if (launches.rows.length === 0) return deploy ?? <p className="note">No mints yet. <a href="#/create">Create the first one.</a></p>;
  return (
    <>
      {deploy}
      <MintRows rows={launches.rows} mobile={mobile} />
    </>
  );
}

function MintRows({ rows, mobile }: { rows: LaunchRow[]; mobile: boolean }) {
  if (mobile) {
    return (
      <ul className="cards" data-testid="mint-cards">
        {rows.map((row) => {
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
      <table className="table" data-testid="mint-table">
        <thead>
          <tr><th>Token</th><th>NFTs minted</th><th>Raised</th><th>Cap</th><th>Status</th><th>Launcher</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => {
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

function FlapLaunchHome({ mobile }: { mobile: boolean }) {
  return (
    <>
      <section className="hero">
        <p className="eyebrow">Our launchpad · {NETWORK.label}</p>
        <h1>The presale is an <span className="accent">NFT mint.</span></h1>
        <p className="lede">
          Buyers mint CallZ pass NFTs at a flat price. The mint that reaches the cap launches the token straight into a
          liquidity pool on Flap Pool Launch, with the LP burned. Every NFT then claims an equal share of the supply
          and stays in your wallet as a pass.
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
        <h2>CallZ mints</h2>
        <MintList mobile={mobile} />
      </section>
    </>
  );
}

const GUIDE_POOL_SHARES = [5000, 7500, 9000] as const;

/** The smallest cap that can launch, read from the Portal, so a creator does not open a mint that never can. */
function FloorGuidePanel() {
  const [guide, setGuide] = useState<FloorGuide | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    readFloorGuide(GUIDE_POOL_SHARES).then(
      (next) => current && setGuide(next),
      () => current && setFailed(true),
    );
    return () => {
      current = false;
    };
  }, []);

  if (failed) {
    return <p className="note" role="alert">The Portal's liquidity floor could not be read. Check the cap against Flap's floor before creating a mint.</p>;
  }
  if (!guide) return <p className="note" role="status">Reading the Portal's liquidity floor…</p>;
  return (
    <section className="note" data-testid="floor-guide">
      <h2>Minimum raise to launch</h2>
      <p>
        The Portal rejects a launch whose pool is too small, and a mint whose cap is under that floor can never
        launch. At the Portal's current price, the cap must be at least:
      </p>
      <dl className="floor-rows">
        {guide.rows.map((row) => (
          <div key={row.poolShareBps}>
            <dt>{row.poolShareBps / 100}% of supply in the pool</dt>
            <dd className="num">{formatMinimum(row.minRaiseWei)} {NETWORK.unit}</dd>
          </div>
        ))}
      </dl>
      <p className="dim">
        This factory's floor multiplier is {guide.multiplierBps / 100}%. Flap sets it per factory and can lower it.
      </p>
    </section>
  );
}

function CreatePage({ locale }: { locale: Locale }) {
  const wallet = useWallet();
  const host = useMemo(
    () => createHost({ launcher: null, refresh: () => undefined, openLauncher }),
    // The host carries the wallet's current state, so it is rebuilt whenever that changes.
    [wallet.account, wallet.chainId, wallet.pendingHash, wallet.available],
  );
  return (
    <>
      <LauncherConfig context={{ identity, locale }} messages={messagesByLocale[locale]} host={host} />
      <FloorGuidePanel />
    </>
  );
}

function LauncherPage({ address, locale }: { address: Address; locale: Locale }) {
  const wallet = useWallet();
  const [valid, setValid] = useState<boolean | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [launchability, setLaunchability] = useState<Launchability | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    let current = true;
    setValid(null);
    setSnapshot(null);
    setLaunchability(null);
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
    readLaunchability(address).then(
      (next) => current && setLaunchability(next),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [address, valid]);

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
    () => createHost({ launcher: address, refresh, openLauncher }),
    [address, refresh, wallet.account, wallet.chainId, wallet.pendingHash, wallet.available],
  );

  if (valid === null) return <p className="note" role="status">Checking this Launcher with the Portal…</p>;
  if (!valid) {
    return (
      <p className="note" role="alert" data-testid="unknown-launcher">
        <code>{short(address)}</code> is not a Launcher created by the CallZ factory on {NETWORK.label}.
      </p>
    );
  }
  const token = typeof snapshot?.token === "string" ? snapshot.token : null;
  const blocked = launchability !== null && !launchability.canLaunch && snapshot?.launched !== true;
  return (
    <>
      {blocked && (
        <p className="note note-warn" role="alert" data-testid="floor-warning">
          This mint cannot launch as it is configured. Its cap is {formatEther(launchability.capWei)} {NETWORK.unit}, and
          the Portal's liquidity floor for its pool share is {formatMinimum(launchability.floorWei)} {NETWORK.unit}. NFTs
          become refundable after the deadline.
        </p>
      )}
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

export default function FlapLaunchSection({ route, locale, mobile }: { route: FlapLaunchRoute; locale: Locale; mobile: boolean }) {
  if (route.name === "create") return <CreatePage locale={locale} />;
  if (route.name === "launcher") return <LauncherPage address={route.address as Address} locale={locale} />;
  return <FlapLaunchHome mobile={mobile} />;
}
