// The wallet's positions: tokens from the board it holds on BNB Chain, each with what selling all of it would
// return right now, and a button that sells it. Opens from the wallet button; loaded on first use, because it
// reads balances and trades through the chain library.
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import type { Address, Hex } from "viem";
import { loadDisplayName, saveDisplayName, useDisplayName } from "./display-name";
import { amount, short } from "./format";
import { displayNameError } from "./names";
import { claimMany, loadWalletRewards, type WalletRewards } from "./rewards";
import { TokenImage } from "./scope";
import { SITES } from "./site";
import { TradeError, callzTokens, heldTokens, loadMarket, quoteSell, rememberedTokens, sell, type Market, type TradeStep } from "./trade";
import { switchChain } from "./wallet";

const SITE = SITES.bsc;
/** Slippage for a sell from this menu, on top of the token's own tax. In basis points. */
const SELL_SLIPPAGE_BPS = 500;
const STEP_TEXT: Record<TradeStep, string> = {
  pricing: "Pricing…",
  approving: "Approve in your wallet…",
  checking: "Checking…",
  confirm: "Confirm in your wallet…",
  pending: "Confirming…",
};

interface Indexed {
  address: string;
  symbol: string | null;
  name: string | null;
  image: string | null;
}
interface Position {
  token: Address;
  symbol: string;
  image: string | null;
  balance: bigint;
  decimals: number;
  market: Market | null;
  /** BNB that selling the whole balance returns now, after the token's tax. Null when it has no pool. */
  worth: bigint | null;
}
type Note = { kind: "working" | "done" | "error"; symbol: string; text: string; hash?: Hex };

async function loadPositions(account: Address): Promise<Position[]> {
  // The board's launched tokens, the tokens launched through CallZ's own launchpad (which a holder gets by
  // claiming, not buying), and any token this browser bought through the site.
  const [indexed, launched] = await Promise.all([
    fetch("/api/bsc/tokens?limit=200")
      .then((response) => (response.ok ? (response.json() as Promise<{ items: Indexed[] }>) : { items: [] }))
      .catch(() => ({ items: [] as Indexed[] })),
    callzTokens().catch(() => [] as Address[]),
  ]);
  const known = new Map(indexed.items.map((token) => [token.address.toLowerCase(), token]));
  const candidates = [...new Set([...known.keys(), ...launched, ...rememberedTokens()])] as Address[];
  const held = await heldTokens(account, candidates);
  return Promise.all(
    held.map(async ({ token, balance }): Promise<Position> => {
      const row = known.get(token.toLowerCase());
      try {
        const market = await loadMarket(token);
        const quote = await quoteSell(market, balance).catch(() => null);
        return { token, symbol: row?.symbol || market.symbol || short(token), image: row?.image ?? null, balance, decimals: market.decimals, market, worth: quote?.amountOut ?? null };
      } catch {
        return { token, symbol: row?.symbol || short(token), image: row?.image ?? null, balance, decimals: 18, market: null, worth: null };
      }
    }),
  );
}

const NAME_STEP_TEXT = { signing: "Sign in wallet…", saving: "Saving…" } as const;
const NAME_RULES = "3 to 20 letters, digits or underscores, starting with a letter. Shown beside your address in chat and on callouts.";

/**
 * The wallet's display name: what it is now, and a small form that sets, changes or removes it. The wallet
 * signs each change and the Worker decides (apps/worker/src/names.ts); the rules are said here first, while
 * the name is typed, and whatever the Worker answers to a refused change is shown as it is.
 */
function DisplayNameRow({ account }: { account: Address }) {
  const own = useDisplayName(account);
  const hintId = useId();
  const [draft, setDraft] = useState("");
  const [working, setWorking] = useState<{ action: "save" | "remove"; step: keyof typeof NAME_STEP_TEXT } | null>(null);
  const [outcome, setOutcome] = useState<{ kind: "done" | "error"; text: string } | null>(null);

  // Read again each time the menu opens: the name may have been changed from another device.
  useEffect(() => {
    void loadDisplayName(account);
  }, [account]);
  // What was typed, and what came of it, belong to the wallet they were for.
  useEffect(() => {
    setDraft("");
    setOutcome(null);
  }, [account]);

  const typed = draft.trim();
  const problem = typed === "" ? null : displayNameError(typed);
  const unchanged = own.name !== null && typed === own.name;

  const change = async (action: "save" | "remove", name: string | null) => {
    if (working) return;
    setOutcome(null);
    try {
      await saveDisplayName(account, name, (step) => setWorking({ action, step }));
      setDraft("");
      setOutcome({ kind: "done", text: name === null ? "Removed. Your address is shown on its own again." : "Saved. You can change it again in 10 minutes." });
    } catch (cause) {
      setOutcome({ kind: "error", text: cause instanceof Error && cause.message ? cause.message : "The name could not be saved. Try again." });
    } finally {
      setWorking(null);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (typed === "" || problem !== null || unchanged) return;
    void change("save", typed);
  };

  return (
    <section className="positions-name" data-testid="display-name" aria-label="Display name">
      <p className="positions-head">
        <strong>Display name</strong>
        {own.name !== null ? (
          <span className="positions-name-current" data-testid="display-name-current">
            <span className="author-name">{own.name}</span>{" "}
            <span className="author-address">{short(account)}</span>
          </span>
        ) : (
          <span className="dim" data-testid="display-name-current">{own.state === "loading" ? "…" : own.state === "error" ? "Could not be read" : "Not set"}</span>
        )}
      </p>
      <form className="positions-name-form" onSubmit={submit} noValidate>
        <label className="positions-name-input">
          <span className="visually-hidden">{own.name !== null ? "New display name" : "Display name"}</span>
          <input
            type="text"
            name="display-name"
            data-testid="display-name-input"
            value={draft}
            maxLength={64}
            placeholder={own.name !== null ? "New name" : "Choose a name"}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
            readOnly={working !== null}
            aria-invalid={problem !== null}
            aria-describedby={hintId}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <button type="submit" className="button positions-name-save" data-testid="display-name-save" disabled={working !== null || typed === "" || problem !== null || unchanged}>
          {working?.action === "save" ? NAME_STEP_TEXT[working.step] : "Save"}
        </button>
        {own.name !== null && (
          <button type="button" className="positions-sell positions-name-remove" data-testid="display-name-remove" disabled={working !== null} onClick={() => void change("remove", null)}>
            {working?.action === "remove" ? NAME_STEP_TEXT[working.step] : "Remove"}
          </button>
        )}
      </form>
      <p id={hintId} className="positions-name-hint" data-invalid={problem !== null} aria-live="polite">
        {problem ?? (unchanged ? "That is your name already." : NAME_RULES)}
      </p>
      {outcome && (
        <p className={`positions-outcome trade-${outcome.kind}`} data-testid="display-name-outcome" role={outcome.kind === "error" ? "alert" : "status"}>{outcome.text}</p>
      )}
    </section>
  );
}

export default function Positions({ account, chainId, onNavigate }: { account: Address; chainId: number | null; onNavigate(): void }) {
  const [positions, setPositions] = useState<Position[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [notes, setNotes] = useState<Record<string, Note>>({});
  const onChain = chainId === SITE.id;
  // Callout rewards the vault owes this wallet, across tokens, and the one claim that collects them.
  const [rewards, setRewards] = useState<WalletRewards | null>(null);
  const [claiming, setClaiming] = useState<{ kind: "working" | "done" | "error"; text: string; hash?: Hex } | null>(null);
  const loadRewards = useCallback(() => {
    loadWalletRewards(account).then(setRewards, () => setRewards(null));
  }, [account]);
  useEffect(loadRewards, [loadRewards]);

  const claimRewards = async () => {
    if (!rewards || rewards.rewards.length === 0) return;
    setClaiming({ kind: "working", text: "Starting…" });
    try {
      const hash = await claimMany(account, rewards.rewards.map((reward) => reward.token), rewards.epoch, (step, hash) =>
        setClaiming({ kind: "working", text: step === "confirm" ? "Confirm in your wallet…" : step === "pending" ? "Confirming…" : "Checking…", hash }),
      );
      setClaiming({ kind: "done", text: "Claimed.", hash });
    } catch (cause) {
      const failure = cause instanceof TradeError ? cause : new TradeError("NETWORK", "Not claimed", "The claim could not be completed. Check your wallet's activity before trying again.");
      setClaiming({ kind: "error", text: `${failure.title}. ${failure.message}`, hash: failure.hash });
    }
    loadRewards();
  };

  const reload = useCallback(() => {
    loadPositions(account).then(
      (next) => {
        setPositions(next.sort((a, b) => ((b.worth ?? 0n) > (a.worth ?? 0n) ? 1 : -1)));
        setFailed(false);
      },
      () => setFailed(true),
    );
  }, [account]);
  useEffect(reload, [reload]);

  const sellAll = async (position: Position) => {
    if (!position.market) return;
    const note = (next: Omit<Note, "symbol">) => setNotes((all) => ({ ...all, [position.token]: { ...next, symbol: position.symbol } }));
    note({ kind: "working", text: "Starting…" });
    try {
      const { hash } = await sell({
        market: position.market,
        account,
        amountIn: position.balance,
        slippageBps: SELL_SLIPPAGE_BPS,
        onStep: (step, hash) => note({ kind: "working", text: STEP_TEXT[step], hash }),
      });
      note({ kind: "done", text: "Sold.", hash });
      reload();
    } catch (cause) {
      const failure = cause instanceof TradeError ? cause : new TradeError("NETWORK", "Not sold", "The sale could not be completed. Check your wallet's activity before trying again.");
      note({ kind: "error", text: `${failure.title}. ${failure.message}`, hash: failure.hash });
    }
  };

  return (
    <div className="positions" data-testid="positions" role="dialog" aria-label="Your positions">
      <p className="positions-head">
        <strong>Positions</strong>
        <span className="dim num">{short(account)}</span>
      </p>
      <DisplayNameRow account={account} />
      {!onChain && (
        <p className="positions-note">
          Positions and selling are on BNB Chain.{" "}
          <button type="button" className="button button-warn" onClick={() => void switchChain(SITE).catch(() => undefined)}>Switch to BNB Chain</button>
        </p>
      )}
      {rewards && (rewards.rewards.length > 0 || claiming) && (
        <section className="positions-rewards" data-testid="wallet-rewards" aria-label="Callout rewards">
          <p className="positions-head">
            <strong>Callout rewards</strong>
            <span className="dim num">{amount(rewards.total, 6)} BNB</span>
          </p>
          <ul className="positions-rewards-list">
            {rewards.rewards.map((reward) => (
              <li key={reward.token}>
                <a href={`#/token/${reward.token.toLowerCase()}`} onClick={onNavigate}>{reward.symbol}</a>
                <span className="num">{amount(reward.amount, 6)} BNB</span>
              </li>
            ))}
          </ul>
          <button type="button" className="button positions-claim" data-testid="wallet-rewards-claim" disabled={!onChain || rewards.total === 0n || claiming?.kind === "working"} onClick={() => void claimRewards()}>
            Claim {amount(rewards.total, 5)} BNB
          </button>
          {claiming && (
            <p className={`positions-outcome trade-${claiming.kind}`} role={claiming.kind === "error" ? "alert" : "status"}>
              {claiming.text} {claiming.hash && <a href={`${SITE.explorer}/tx/${claiming.hash}`} target="_blank" rel="noreferrer">View ↗</a>}
            </p>
          )}
          <p className="positions-foot dim">From the round that just ended. Claim within 24 hours of it ending; after that it goes to the team wallet.</p>
        </section>
      )}
      {positions === null && !failed && <p className="positions-note" role="status">Reading your balances…</p>}
      {failed && positions === null && <p className="positions-note" role="alert">BNB Chain could not be reached. Close and open this to try again.</p>}
      {/* A position sold in full leaves the list: what happened to it stays here. */}
      {positions !== null &&
        Object.entries(notes)
          .filter(([token]) => !positions.some((position) => position.token === token))
          .map(([token, note]) => (
            <p key={token} className={`positions-outcome trade-${note.kind}`} role={note.kind === "error" ? "alert" : "status"}>
              <strong>{note.symbol}:</strong> {note.text} {note.hash && <a href={`${SITE.explorer}/tx/${note.hash}`} target="_blank" rel="noreferrer">View ↗</a>}
            </p>
          ))}
      {positions !== null && positions.length === 0 && <p className="positions-note" data-testid="positions-empty">No tokens from the board in this wallet{Object.keys(notes).length > 0 ? " now" : " yet"}.</p>}
      {positions !== null && positions.length > 0 && (
        <ul className="positions-list">
          {positions.map((position) => {
            const note = notes[position.token];
            return (
              <li key={position.token}>
                <a className="positions-token" href={`#/token/${position.token.toLowerCase()}`} onClick={onNavigate}>
                  <TokenImage key={position.image ?? "none"} image={position.image} label={position.symbol} colour="var(--line)" size={36} />
                  <span>
                    <strong>{position.symbol}</strong>
                    <span className="dim num">{amount(position.balance, 2, position.decimals)}{position.worth !== null ? ` · ≈ ${amount(position.worth, 5)} BNB` : " · no pool"}</span>
                  </span>
                </a>
                <button type="button" className="positions-sell" disabled={!onChain || !position.market || note?.kind === "working"} onClick={() => void sellAll(position)}>
                  Sell all
                </button>
                {note && (
                  <p className={`positions-outcome trade-${note.kind}`} role={note.kind === "error" ? "alert" : "status"}>
                    {note.text} {note.hash && <a href={`${SITE.explorer}/tx/${note.hash}`} target="_blank" rel="noreferrer">View ↗</a>}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="positions-foot dim">Tokens from the board, tokens launched on CallZ, and ones bought here, that this wallet holds on BNB Chain. "Sell all" goes through PancakeSwap with 5% slippage; your wallet asks you to confirm.</p>
    </div>
  );
}
