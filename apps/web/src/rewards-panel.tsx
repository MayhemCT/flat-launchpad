// The rewards panel of a token page: what the token's CallZ fees have collected for its callers this round, the
// connected wallet's holdings and snapshot, and the claim. Nothing is staked: the tokens stay in the wallet.
// The callout feed next to it is where links are posted and recorded.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Address, Hex } from "viem";
import { amount } from "./format";
import { claim, loadRewards, type RewardStep, type Rewards } from "./rewards";
import { SITES } from "./site";
import { TradeError, type Market } from "./trade";
import { connect, switchChain, useWallet } from "./wallet";

const SITE = SITES.bsc;
const STEP_TEXT: Record<RewardStep, string> = {
  checking: "Checking it on BNB Chain…",
  confirm: "Confirm in your wallet…",
  pending: "Waiting for BNB Chain to confirm…",
};

interface Outcome {
  kind: "working" | "done" | "error";
  title: string;
  text: string;
  hash?: Hex;
}

/** "5h 12m", "42m", "under a minute". */
function span(seconds: number): string {
  if (seconds < 60) return "under a minute";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function RewardsPanel({ token, market }: { token: Address; market: Market | null }) {
  const wallet = useWallet();
  const account = wallet.account;
  const onChain = wallet.chainId === SITE.id;
  const [data, setData] = useState<Rewards | null>(null);
  const [failed, setFailed] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const busy = outcome?.kind === "working";
  const decimals = market?.decimals ?? 18;
  const symbol = market?.symbol || "token";

  const load = useCallback(() => {
    loadRewards(token, account).then(
      (next) => {
        setData(next);
        setFailed(false);
      },
      () => setFailed(true),
    );
  }, [token, account]);
  useEffect(() => {
    setData(null);
    load();
    const reload = window.setInterval(load, 30_000);
    const tick = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    // A trade on this page pays a fee into the round, and a recorded callout changes it: read again at once.
    window.addEventListener("callz:traded", load);
    window.addEventListener("callz:recorded", load);
    return () => {
      window.clearInterval(reload);
      window.clearInterval(tick);
      window.removeEventListener("callz:traded", load);
      window.removeEventListener("callz:recorded", load);
    };
  }, [load]);

  const mine = data?.mine ?? null;
  const finished = mine?.finished ?? null;
  const claimable = finished ? finished.holderPayout + finished.calloutPayout : 0n;

  const collect = async () => {
    if (!account || !finished) return;
    setOutcome({ kind: "working", title: "Claiming", text: "Starting…" });
    try {
      const hash = await claim(account, token, [finished.epoch], (step, hash) => setOutcome({ kind: "working", title: "Claiming", text: STEP_TEXT[step], hash }));
      setOutcome({ kind: "done", title: "Claimed", text: "Confirmed on BNB Chain.", hash });
    } catch (cause) {
      const failure = cause instanceof TradeError ? cause : new TradeError("NETWORK", "Something went wrong", "It could not be completed. Check your wallet's activity before trying again.");
      setOutcome({ kind: "error", title: failure.title, text: failure.message, hash: failure.hash });
    }
    load();
  };

  let gate: ReactNode = null;
  if (!wallet.available) gate = <p className="trade-note">No browser wallet found. Install MetaMask, Rabby or another wallet to earn and claim.</p>;
  else if (!account) gate = <button type="button" className="button trade-go" onClick={connect}>Connect wallet</button>;
  else if (!onChain) gate = <button type="button" className="button button-warn trade-go" onClick={() => void switchChain(SITE).catch(() => undefined)}>Switch to BNB Chain</button>;

  return (
    <section className="trade-panel rewards-panel" data-testid="rewards-panel" aria-label="Callout rewards">
      <div className="rewards-head">
        <h2>Callout rewards</h2>
        {data?.deployed && <span className="dim num" data-testid="rewards-round">Round ends in {span(Math.max(0, data.epochEnds - now))}</span>}
      </div>

      {!data && !failed && <p className="trade-note" role="status">Reading the rewards vault…</p>}
      {!data && failed && <p className="trade-note" role="alert">The rewards vault could not be read. It will be tried again shortly.</p>}
      {data && !data.deployed && <p className="trade-note" data-testid="rewards-not-deployed">The CallZ rewards vault is not on BNB Chain yet. Once it is, the fees on this token's trades are shared with the people who call it out.</p>}

      {data?.deployed && (
        <>
          <dl className="trade-quote" data-testid="rewards-round-book">
            <div>
              <dt>Callout pool this round</dt>
              <dd className="num">{amount(data.round.calloutPool, 5)} BNB · {data.round.links} verified {data.round.links === 1 ? "callout" : "callouts"}</dd>
            </div>
            <div>
              <dt>Holder share for callers this round</dt>
              <dd className="num">{amount(data.round.holderShare, 5)} BNB</dd>
            </div>
          </dl>

          {gate}
          {!gate && mine && (
            <>
              <dl className="trade-quote" data-testid="rewards-mine">
                <div>
                  <dt>You hold</dt>
                  <dd className="num">{amount(mine.holding, 2, decimals)} {symbol}</dd>
                </div>
                <div>
                  <dt>Your callouts this round</dt>
                  <dd className="num">{mine.links} of {data.rules.maxLinksPerEpoch}</dd>
                </div>
                <div data-testid="rewards-snapshot">
                  <dt>Your snapshot this round</dt>
                  <dd className="num">
                    {mine.snapshot === null
                      ? "Taken when your callout is counted"
                      : `${amount(mine.snapshot, 2, decimals)} ${symbol}${mine.holding < mine.snapshot ? " · you hold less now, so you earn less" : " · still holding"}`}
                  </dd>
                </div>
                {finished && (
                  <div data-testid="rewards-finished">
                    <dt>From the round that just ended · claim within {span(Math.max(0, finished.deadline - now))}</dt>
                    <dd className="num">{amount(claimable, 6)} BNB</dd>
                  </div>
                )}
              </dl>
              <button type="button" className={`button trade-go${claimable === 0n ? " button-quiet" : ""}`} data-testid="rewards-claim" disabled={busy || claimable === 0n} onClick={() => void collect()}>
                Claim {amount(claimable, 5)} BNB
              </button>
            </>
          )}

          {outcome && (
            <p className={`trade-outcome trade-${outcome.kind}`} role={outcome.kind === "error" ? "alert" : "status"}>
              <strong>{outcome.title}.</strong> {outcome.text}{" "}
              {outcome.hash && <a href={`${SITE.explorer}/tx/${outcome.hash}`} target="_blank" rel="noreferrer">View transaction ↗</a>}
            </p>
          )}
          <p className="trade-foot dim">
            Nothing is staked: your tokens stay in your wallet. When your callout is counted, the vault records what you hold (your snapshot)
            and the market cap you called at. Of every CallZ fee on this token, {data.split.holdersBps / 100}% is shared by the round's callers,
            weighted by holdings and by how early they called, on the trading that comes after their callout; {data.split.calloutBps / 100}% is
            split per verified callout; {data.split.platformBps / 100}% is the platform's. Sell, and your part shrinks with what you still hold.
            A round ends at 00:00 UTC and can be claimed for 24 hours; what is not claimed then goes to the team wallet. The vault is new and has
            not been audited.
          </p>
        </>
      )}
    </section>
  );
}
