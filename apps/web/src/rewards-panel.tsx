// The rewards panel of a token page: what the token's CallZ fees have collected this round, staking for the
// holder share, and claiming. The callout feed next to it is where links are posted and recorded.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { formatUnits, parseUnits, type Address, type Hex } from "viem";
import { amount } from "./format";
import { claim, loadRewards, stake, unstake, type RewardStep, type Rewards } from "./rewards";
import { SITES } from "./site";
import { TradeError, type Market } from "./trade";
import { connect, switchChain, useWallet } from "./wallet";

const SITE = SITES.bsc;
const STEP_TEXT: Record<RewardStep, string> = {
  approving: "Approve the vault for this amount in your wallet…",
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
  const [text, setText] = useState("");
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

  const run = async (title: string, done: string, action: (onStep: (step: RewardStep, hash?: Hex) => void) => Promise<Hex>) => {
    setOutcome({ kind: "working", title, text: "Starting…" });
    try {
      const hash = await action((step, hash) => setOutcome({ kind: "working", title, text: STEP_TEXT[step], hash }));
      setOutcome({ kind: "done", title: done, text: "Confirmed on BNB Chain.", hash });
      setText("");
    } catch (cause) {
      const failure = cause instanceof TradeError ? cause : new TradeError("NETWORK", "Something went wrong", "It could not be completed. Check your wallet's activity before trying again.");
      setOutcome({ kind: "error", title: failure.title, text: failure.message, hash: failure.hash });
    }
    load();
  };

  let value: bigint | null = null;
  if (/^\d*\.?\d+$/.test(text.trim())) {
    try {
      const parsed = parseUnits(text.trim(), decimals);
      value = parsed > 0n ? parsed : null;
    } catch {
      value = null; // more decimal places than the token has
    }
  }
  const mine = data?.mine ?? null;
  const finished = mine?.finished ?? null;
  /** Everything one claim would pay: the stake's earnings and the round that just ended. */
  const claimable = mine ? mine.earned + (finished ? finished.unlockedPayout + finished.calloutPayout : 0n) : 0n;

  let gate: ReactNode = null;
  if (!wallet.available) gate = <p className="trade-note">No browser wallet found. Install MetaMask, Rabby or another wallet to stake and claim.</p>;
  else if (!account) gate = <button type="button" className="button trade-go" onClick={connect}>Connect wallet</button>;
  else if (!onChain) gate = <button type="button" className="button button-warn trade-go" onClick={() => void switchChain(SITE).catch(() => undefined)}>Switch to BNB Chain</button>;

  return (
    <section className="trade-panel rewards-panel" data-testid="rewards-panel" aria-label="Rewards">
      <div className="rewards-head">
        <h2>Rewards</h2>
        {data?.deployed && <span className="dim num" data-testid="rewards-round">Round ends in {span(Math.max(0, data.epochEnds - now))}</span>}
      </div>

      {!data && !failed && <p className="trade-note" role="status">Reading the rewards vault…</p>}
      {!data && failed && <p className="trade-note" role="alert">The rewards vault could not be read. It will be tried again shortly.</p>}
      {data && !data.deployed && <p className="trade-note" data-testid="rewards-not-deployed">The CallZ rewards vault is not on BNB Chain yet. Once it is, the fees on this token's trades are shared here.</p>}

      {data?.deployed && (
        <>
          <dl className="trade-quote" data-testid="rewards-round-book">
            <div>
              <dt>Callout pool this round</dt>
              <dd className="num">{amount(data.round.pool30, 5)} BNB · {data.round.links} verified {data.round.links === 1 ? "callout" : "callouts"}</dd>
            </div>
            <div>
              <dt>Holder share unlocked by callouts</dt>
              <dd className="num">{amount(data.round.pot10, 5)} BNB</dd>
            </div>
            <div>
              <dt>Streaming to stakers</dt>
              <dd className="num">{amount(data.stream.rate * 86_400n, 5)} BNB a day</dd>
            </div>
            <div>
              <dt>Staked</dt>
              <dd className="num">{amount(data.stream.totalStaked, 2, decimals)} {symbol}</dd>
            </div>
          </dl>

          {gate}
          {!gate && mine && (
            <>
              <dl className="trade-quote" data-testid="rewards-mine">
                <div>
                  <dt>Your stake</dt>
                  <dd className="num">{amount(mine.staked, 2, decimals)} {symbol}</dd>
                </div>
                <div>
                  <dt>Earned by your stake</dt>
                  <dd className="num">{amount(mine.earned, 6)} BNB</dd>
                </div>
                <div>
                  <dt>Your callouts this round</dt>
                  <dd className="num">{mine.links} of {data.rules.maxLinksPerEpoch}{mine.unlocked ? " · holder share unlocked" : ""}</dd>
                </div>
                {finished && (
                  <div data-testid="rewards-finished">
                    <dt>From the round that just ended · claim within {span(Math.max(0, finished.deadline - now))}</dt>
                    <dd className="num">{amount(finished.unlockedPayout + finished.calloutPayout, 6)} BNB</dd>
                  </div>
                )}
              </dl>

              <label className="trade-amount">
                <span className="stat-label">Stake or unstake</span>
                <span className="trade-input">
                  <input name="stake" inputMode="decimal" autoComplete="off" placeholder="0.0" value={text} disabled={busy} onChange={(event) => setText(event.target.value.replace(",", "."))} />
                  <span className="num">{symbol}</span>
                </span>
              </label>
              <p className="trade-held dim num">
                In wallet {amount(mine.wallet, 2, decimals)} {symbol}{" "}
                <button type="button" className="link-button" disabled={busy || mine.wallet === 0n} onClick={() => setText(formatUnits(mine.wallet, decimals))}>Max</button>
              </p>
              <div className="rewards-actions">
                <button type="button" className="button" data-testid="rewards-stake" disabled={busy || value === null || value > mine.wallet} onClick={() => void run("Staking", "Staked", (onStep) => stake(account!, token, value!, onStep))}>Stake</button>
                <button type="button" className="button button-quiet" data-testid="rewards-unstake" disabled={busy || value === null || value > mine.staked} onClick={() => void run("Unstaking", "Unstaked", (onStep) => unstake(account!, token, value!, onStep))}>Unstake</button>
                <button type="button" className={`button${claimable === 0n ? " button-quiet" : ""}`} data-testid="rewards-claim" disabled={busy || claimable === 0n} onClick={() => void run("Claiming", "Claimed", (onStep) => claim(account!, token, finished ? [finished.epoch] : [], onStep))}>Claim {amount(claimable, 5)} BNB</button>
              </div>
            </>
          )}

          {outcome && (
            <p className={`trade-outcome trade-${outcome.kind}`} role={outcome.kind === "error" ? "alert" : "status"}>
              <strong>{outcome.title}.</strong> {outcome.text}{" "}
              {outcome.hash && <a href={`${SITE.explorer}/tx/${outcome.hash}`} target="_blank" rel="noreferrer">View transaction ↗</a>}
            </p>
          )}
          <p className="trade-foot dim">
            Of every CallZ fee on this token, {data.split.holdersBps / 100}% streams to its stakers, {data.split.unlockedBps / 100}% is shared by
            holders with a verified callout that round, {data.split.calloutBps / 100}% is the callout pool, split per verified callout, and{" "}
            {data.split.platformBps / 100}% is the platform's. A round ends at 00:00 UTC, and its callout rewards and holder share can be claimed
            for 24 hours after that; what is not claimed then goes to the team wallet. One claim collects everything. A stake can be taken back
            in full at any time. The vault is new and has not been audited.
          </p>
        </>
      )}
    </section>
  );
}
