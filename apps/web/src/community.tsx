// Community: the leaderboards, the clans and a wallet's profile. Everything shown is read from this site's
// Worker (apps/worker/src/social.ts and apps/worker/src/clans.ts). The boards, the list of clans, a clan's page
// and a profile are public; a wallet's own clan, its invites and every change to them need the wallet signed in
// (apps/web/src/session.ts). These pages send no transaction. The boards and the clans load no chain library;
// a profile reads what its wallet holds from BNB Chain, through apps/web/src/trade.ts, loaded when one is opened.
//
// Every name, tag and label a visitor typed is put on the page as a text node, and every link built from one
// starts with "#", so nothing the API returns can become markup or an address outside this page.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Address } from "viem";
import { AuthorName, loadDisplayName, saveDisplayName, shownClan, useDisplayName } from "./display-name";
import { amount, ago, short } from "./format";
import { displayNameError, shownName } from "./names";
import { ApiError, api, signIn, useSignedIn } from "./session";
import { connect, useWallet } from "./wallet";
import "./community.css";

export type CommunityRoute = { name: "leaderboard" } | { name: "clans" } | { name: "clan"; tag: string } | { name: "profile"; address: string };

/** How often a page asks again for what it shows. */
const REFRESH_MS = 30_000;
const NOT_UNDERSTOOD = "The answer was not understood. Reload to try again.";

// ── What the API returns ─────────────────────────────────────────────────

type Fields = Record<string, unknown>;
const WALLET = /^0x[0-9a-fA-F]{40}$/;
const isFields = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isWallet = (value: unknown): value is string => typeof value === "string" && WALLET.test(value);
const isOptionalText = (value: unknown): value is string | null => value === null || typeof value === "string";

/** The entries of `value` that have the shape `is` checks. Null when it is not a list at all. */
function listOf<T>(value: unknown, is: (entry: unknown) => entry is T): T[] | null {
  return Array.isArray(value) ? value.filter(is) : null;
}

interface SocialRow {
  rank: number;
  wallet: string;
  name: string | null;
  clan: string | null;
  points: number;
  rooms: number;
}

interface CallsRow {
  rank: number;
  wallet: string;
  name: string | null;
  clan: string | null;
  /** Approved callouts. */
  calls: number;
  /** Different tokens those callouts are on. */
  tokens: number;
  /** Approved callouts whose position is still open. */
  holding: number;
  /** Market cap at close over market cap at the call, for the best closed call. Null while none has closed. */
  best: number | null;
}

interface Clan {
  tag: string;
  name: string;
  /** The founder's wallet. */
  founder: string;
  /** Unix seconds. */
  createdAt: number;
  members: number;
  points: number;
}

interface Member {
  wallet: string;
  name: string | null;
  /** Unix seconds. */
  joinedAt: number;
  points: number;
}

/** An invite waiting for the signed-in wallet. */
interface Invite {
  tag: string;
  name: string;
  invitedBy: string;
  invitedByName: string | null;
  createdAt: number;
}

/** An invite the signed-in wallet's clan has out. */
interface SentInvite {
  wallet: string;
  name: string | null;
  invitedBy: string;
  createdAt: number;
}

interface Mine {
  wallet: string;
  clan: Clan | null;
  members: Member[];
  invites: Invite[];
  sent: SentInvite[];
}

interface ClanDetail {
  clan: Clan;
  members: Member[];
}

interface RoomRef {
  /** The room's address. */
  room: string;
  name: string | null;
  symbol: string | null;
}

/** A Cook Room the wallet opened or holds a pass in. */
interface ProfileRoom extends RoomRef {
  launched: boolean;
  /** The wallet opened this room. */
  dev: boolean;
  /** The hash of the room's picture when this site keeps it. */
  picture: string | null;
  /** The number of the pass the wallet holds there. Null for a dev without one. */
  seat: number | null;
  /** What one pass cost, in wei. */
  seatPrice: bigint | null;
  seats: number | null;
  /** The token the room launched, and its PancakeSwap pair. */
  token: string | null;
  pair: string | null;
  /** Unix seconds: when CallZ first listed the room. */
  createdAt: number | null;
}

interface Profile {
  wallet: string;
  name: string | null;
  clan: { tag: string; name: string } | null;
  points: number;
  byRoom: Array<RoomRef & { points: number }>;
  tags: Array<RoomRef & { label: string }>;
  /** Newest first. */
  rooms: ProfileRoom[];
  calls: number;
  tokensCalled: number;
}

const isRanked = (row: Fields) => isCount(row.rank) && isWallet(row.wallet) && isOptionalText(row.name) && isOptionalText(row.clan);
const isSocialRow = (value: unknown): value is SocialRow => isFields(value) && isRanked(value) && isCount(value.points) && isCount(value.rooms);
const isCallsRow = (value: unknown): value is CallsRow =>
  isFields(value) && isRanked(value) && isCount(value.calls) && isCount(value.tokens) && isCount(value.holding) &&
  (value.best === null || (typeof value.best === "number" && Number.isFinite(value.best) && value.best >= 0));
const isClan = (value: unknown): value is Clan =>
  isFields(value) && shownClan(value.tag) !== null && typeof value.name === "string" && isWallet(value.founder) && isCount(value.createdAt) && isCount(value.members) && isCount(value.points);
const isMember = (value: unknown): value is Member => isFields(value) && isWallet(value.wallet) && isOptionalText(value.name) && isCount(value.joinedAt) && isCount(value.points);
const isInvite = (value: unknown): value is Invite =>
  isFields(value) && shownClan(value.tag) !== null && typeof value.name === "string" && isWallet(value.invitedBy) && isOptionalText(value.invitedByName) && isCount(value.createdAt);
const isSentInvite = (value: unknown): value is SentInvite => isFields(value) && isWallet(value.wallet) && isOptionalText(value.name) && isWallet(value.invitedBy) && isCount(value.createdAt);
const isRoomRef = (value: Fields) => isWallet(value.room) && isOptionalText(value.name) && isOptionalText(value.symbol);
const isRoomPoints = (value: unknown): value is Profile["byRoom"][number] => isFields(value) && isRoomRef(value) && isCount(value.points);
const isRoomTag = (value: unknown): value is Profile["tags"][number] => isFields(value) && isRoomRef(value) && typeof value.label === "string" && value.label !== "";
const PICTURE = /^[0-9a-f]{64}$/;
const WEI = /^\d{1,78}$/;

/**
 * A room of a profile. What says which room it is and what the wallet is in it has to be there; a detail that
 * is missing or not what it should be is left out, and whatever is worked out from it is not shown.
 */
function readProfileRoom(value: unknown): ProfileRoom[] {
  if (!isFields(value) || !isRoomRef(value) || typeof value.launched !== "boolean" || typeof value.dev !== "boolean") return [];
  return [
    {
      room: value.room as string,
      name: value.name as string | null,
      symbol: value.symbol as string | null,
      launched: value.launched,
      dev: value.dev,
      picture: typeof value.picture === "string" && PICTURE.test(value.picture) ? value.picture : null,
      seat: isCount(value.seat) ? value.seat : null,
      seatPrice: typeof value.seatPrice === "string" && WEI.test(value.seatPrice) ? BigInt(value.seatPrice) : null,
      seats: isCount(value.seats) ? value.seats : null,
      token: isWallet(value.token) ? value.token.toLowerCase() : null,
      pair: isWallet(value.pair) ? value.pair.toLowerCase() : null,
      createdAt: isCount(value.createdAt) ? value.createdAt : null,
    },
  ];
}

const readSocial = (body: unknown): SocialRow[] | null => (isFields(body) ? listOf(body.board, isSocialRow) : null);
const readCalls = (body: unknown): CallsRow[] | null => (isFields(body) ? listOf(body.board, isCallsRow) : null);
const readClans = (body: unknown): Clan[] | null => (isFields(body) ? listOf(body.clans, isClan) : null);

function readClanDetail(body: unknown): ClanDetail | null {
  if (!isFields(body) || !isClan(body.clan)) return null;
  const members = listOf(body.members, isMember);
  return members ? { clan: body.clan, members } : null;
}

function readMine(body: unknown): Mine | null {
  if (!isFields(body) || !isWallet(body.wallet) || !(body.clan === null || isClan(body.clan))) return null;
  const members = listOf(body.members, isMember);
  const invites = listOf(body.invites, isInvite);
  const sent = listOf(body.sent, isSentInvite);
  return members && invites && sent ? { wallet: body.wallet, clan: body.clan, members, invites, sent } : null;
}

function readProfile(body: unknown): Profile | null {
  if (!isFields(body) || !isWallet(body.wallet) || !isOptionalText(body.name) || !isCount(body.points) || !isCount(body.calls) || !isCount(body.tokensCalled)) return null;
  const clan = isFields(body.clan) && shownClan(body.clan.tag) !== null && typeof body.clan.name === "string" ? { tag: body.clan.tag as string, name: body.clan.name } : null;
  const byRoom = listOf(body.byRoom, isRoomPoints);
  const tags = listOf(body.tags, isRoomTag);
  const rooms = Array.isArray(body.rooms) ? body.rooms.flatMap(readProfileRoom) : null;
  return byRoom && tags && rooms ? { wallet: body.wallet, name: body.name, clan, points: body.points, byRoom, tags, rooms, calls: body.calls, tokensCalled: body.tokensCalled } : null;
}

// ── Asking the API ───────────────────────────────────────────────────────

type Loaded<T> = { state: "loading" } | { state: "error"; message: string; status: number } | { state: "ready"; data: T };

/**
 * Asks `path` now and again every `refreshMs`. A refresh that fails for the network's or the server's own
 * reasons keeps the last good answer on the page; a refusal (the thing is gone, the session ran out) replaces
 * it with what the API said. `put` shows an answer a change has just returned, and `reload` asks again now:
 * either way an older request still on its way cannot undo it.
 */
function useLoad<T>(path: string, read: (body: unknown) => T | null, refreshMs: number): Loaded<T> & { reload(): void; put(data: T): void } {
  const [result, setResult] = useState<Loaded<T>>({ state: "loading" });
  const turn = useRef(0);
  const loader = useRef<() => void>(() => undefined);

  useEffect(() => {
    const abort = new AbortController();
    const fail = (message: string, status: number) =>
      setResult((previous) => (previous.state === "ready" && (status === 0 || status >= 500) ? previous : { state: "error", message, status }));
    const load = () => {
      const asked = ++turn.current;
      api<unknown>(path, { signal: abort.signal }).then(
        (body) => {
          if (abort.signal.aborted || asked !== turn.current) return;
          const data = read(body);
          if (data === null) fail(NOT_UNDERSTOOD, 0);
          else setResult({ state: "ready", data });
        },
        (cause: unknown) => {
          if (abort.signal.aborted || asked !== turn.current) return;
          if (cause instanceof ApiError) fail(cause.message, cause.status);
          else fail("The site could not be reached. Check your connection and try again.", 0);
        },
      );
    };
    loader.current = load;
    setResult({ state: "loading" });
    load();
    const timer = window.setInterval(load, refreshMs);
    return () => {
      abort.abort();
      window.clearInterval(timer);
      loader.current = () => undefined;
    };
  }, [path, read, refreshMs]);

  const reload = useCallback(() => loader.current(), []);
  const put = useCallback((data: T) => {
    turn.current += 1;
    setResult({ state: "ready", data });
  }, []);
  return { ...result, reload, put };
}

/** Sends one change and reads the answer. Throws the message to show: the API's own sentence when it refuses. */
async function send<T>(path: string, body: unknown, read: (body: unknown) => T | null): Promise<T> {
  const answer = read(await api<unknown>(path, { body }));
  if (answer === null) throw new Error(NOT_UNDERSTOOD);
  return answer;
}

const said = (cause: unknown, fallback: string): string => (cause instanceof Error && cause.message ? cause.message : fallback);

function Waiting<T>({ result, what, children }: { result: Loaded<T>; what: string; children(data: T): ReactNode }) {
  if (result.state === "loading") return <p className="note" role="status">Loading {what}…</p>;
  if (result.state === "error") return <p className="note" role="alert">{result.message}</p>;
  return <>{children(result.data)}</>;
}

// ── Showing it ───────────────────────────────────────────────────────────

const count = (value: number) => value.toLocaleString("en");
const plural = (value: number, one: string, many: string) => `${count(value)} ${value === 1 ? one : many}`;
/** A unix time as a date: 27 Nov 2026. */
const day = (seconds: number) => new Date(seconds * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
/** How many times over a call went: 3.4×. A dash while no call has closed. */
const times = (best: number | null) => (best === null ? "–" : `${best >= 100 ? count(Math.round(best)) : best >= 1 ? best.toFixed(1) : best.toFixed(2)}×`);
const same = (a: string, b: string | null) => b !== null && a.toLowerCase() === b.toLowerCase();
const profileHref = (wallet: string) => `#/u/${wallet.toLowerCase()}`;
const clanHref = (tag: string) => `#/clan/${tag}`;
const roomHref = (room: string) => `#/room/${room.toLowerCase()}`;
/** What a room is called: its token's name, or its address when it has none. */
const roomName = (room: RoomRef) => room.name || short(room.room);

/** A wallet as it is shown everywhere, linking to its profile. */
function Who({ wallet, name, clan }: { wallet: string; name: string | null; clan?: string | null }) {
  return (
    <a className="board-link" href={profileHref(wallet)}>
      <AuthorName className="board-who" address={wallet} name={name} clan={clan} />
    </a>
  );
}

function ClanName({ tag, name }: { tag: string; name: string }) {
  return (
    <>
      <span className="clan-tag">[{tag}]</span> <strong>{name}</strong>
    </>
  );
}

/** The links between the community's pages, at the top of each of them. */
function CommunityNav({ route, me }: { route: CommunityRoute; me: string | null }) {
  const current = (on: boolean) => (on ? ("page" as const) : undefined);
  return (
    <nav className="seg board-nav" aria-label="Community" data-testid="community-nav">
      <a href="#/rooms">Cook Rooms</a>
      <a href="#/launched">Launches</a>
      <a href="#/leaderboard" aria-current={current(route.name === "leaderboard")}>Leaderboard</a>
      <a href="#/clans" aria-current={current(route.name === "clans" || route.name === "clan")}>Clans</a>
      {me !== null && <a href={profileHref(me)} aria-current={current(route.name === "profile" && route.address === me)}>My profile</a>}
    </nav>
  );
}

// ── Leaderboard ──────────────────────────────────────────────────────────

function SocialBoard({ mobile, me }: { mobile: boolean; me: string | null }) {
  const board = useLoad("/api/leaderboard/social", readSocial, REFRESH_MS);
  return (
    <section className="board-section" data-testid="board-social">
      <p className="board-about">Points are given by a room's dev to the members of that room for what they contributed, at most 100 per member per room.</p>
      <Waiting result={board} what="the board">
        {(rows) => {
          if (rows.length === 0) {
            return <p className="note" data-testid="board-empty">Nobody has points yet. Join a room and help its project: the room's dev gives points to the members who contributed.</p>;
          }
          if (mobile) {
            return (
              <ol className="cards" data-testid="board-cards">
                {rows.map((row) => (
                  <li key={row.wallet}>
                    <a className="card board-card" data-testid="board-row" data-own={same(row.wallet, me)} href={profileHref(row.wallet)}>
                      <span className="card-head">
                        <strong className="num">#{row.rank}{same(row.wallet, me) && <span className="tag tag-gold board-you">You</span>}</strong>
                        <strong className="num">{plural(row.points, "point", "points")}</strong>
                      </span>
                      <AuthorName className="board-who" address={row.wallet} name={row.name} clan={row.clan} />
                      <span className="card-line">{plural(row.rooms, "room", "rooms")}</span>
                    </a>
                  </li>
                ))}
              </ol>
            );
          }
          return (
            <div className="table-wrap">
              <table className="table board-table" data-testid="board-table">
                <thead>
                  <tr><th>#</th><th>Who</th><th>Points</th><th>Rooms</th></tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.wallet} data-testid="board-row" data-own={same(row.wallet, me)}>
                      <td className="num">{row.rank}</td>
                      <td><Who wallet={row.wallet} name={row.name} clan={row.clan} />{same(row.wallet, me) && <span className="tag tag-gold board-you">You</span>}</td>
                      <td className="num">{count(row.points)}</td>
                      <td className="num">{count(row.rooms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }}
      </Waiting>
    </section>
  );
}

function CallsBoard({ mobile, me }: { mobile: boolean; me: string | null }) {
  const board = useLoad("/api/leaderboard/calls", readCalls, REFRESH_MS);
  return (
    <section className="board-section" data-testid="board-calls">
      <p className="board-about">Only callouts the reviewer approved count. A call's result is known once the caller has sold.</p>
      <Waiting result={board} what="the board">
        {(rows) => {
          if (rows.length === 0) {
            return <p className="note" data-testid="board-empty">No approved calls yet. Post a callout on a token you hold: once the reviewer approves it, you are on this board.</p>;
          }
          if (mobile) {
            return (
              <ol className="cards" data-testid="board-cards">
                {rows.map((row) => (
                  <li key={row.wallet}>
                    <a className="card board-card" data-testid="board-row" data-own={same(row.wallet, me)} href={profileHref(row.wallet)}>
                      <span className="card-head">
                        <strong className="num">#{row.rank}{same(row.wallet, me) && <span className="tag tag-gold board-you">You</span>}</strong>
                        <strong className="num">{plural(row.calls, "call", "calls")}</strong>
                      </span>
                      <AuthorName className="board-who" address={row.wallet} name={row.name} clan={row.clan} />
                      <span className="card-line">{plural(row.tokens, "token", "tokens")} · {count(row.holding)} still holding · best {times(row.best)}</span>
                    </a>
                  </li>
                ))}
              </ol>
            );
          }
          return (
            <div className="table-wrap">
              <table className="table board-table" data-testid="board-table">
                <thead>
                  <tr><th>#</th><th>Who</th><th>Approved calls</th><th>Tokens called</th><th>Still holding</th><th>Best call</th></tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.wallet} data-testid="board-row" data-own={same(row.wallet, me)}>
                      <td className="num">{row.rank}</td>
                      <td><Who wallet={row.wallet} name={row.name} clan={row.clan} />{same(row.wallet, me) && <span className="tag tag-gold board-you">You</span>}</td>
                      <td className="num">{count(row.calls)}</td>
                      <td className="num">{count(row.tokens)}</td>
                      <td className="num">{count(row.holding)}</td>
                      <td className="num">{times(row.best)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }}
      </Waiting>
    </section>
  );
}

type Board = "social" | "calls";
const BOARDS: ReadonlyArray<{ id: Board; label: string }> = [
  { id: "social", label: "Social points" },
  { id: "calls", label: "Calls" },
];

function LeaderboardPage({ mobile, me }: { mobile: boolean; me: string | null }) {
  const [board, setBoard] = useState<Board>("social");
  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Leaderboard</h1>
        <p className="lede">Who has earned the most on CallZ: in the Cook Rooms they worked in, and with the calls they made.</p>
      </div>
      <div className="seg" role="tablist" aria-label="Which board" data-testid="board-switch">
        {BOARDS.map(({ id, label }) => (
          <button key={id} type="button" role="tab" aria-selected={board === id} data-testid={`board-tab-${id}`} onClick={() => setBoard(id)}>{label}</button>
        ))}
      </div>
      {board === "social" ? <SocialBoard mobile={mobile} me={me} /> : <CallsBoard mobile={mobile} me={me} />}
    </>
  );
}

// ── Clans ────────────────────────────────────────────────────────────────

// The rules of a clan's tag and name, as the page applies them while they are typed. The Worker applies the
// same rules to every request and is the one that decides.
// Keep in sync with `clanTag`, `clanName` and `RESERVED_TAGS` in apps/worker/src/clans.ts.
const MIN_TAG_LENGTH = 2;
const MAX_TAG_LENGTH = 5;
const MIN_CLAN_NAME_LENGTH = 3;
const MAX_CLAN_NAME_LENGTH = 24;
const TAG = /^[A-Z0-9]{2,5}$/;
const CLAN_NAME = /^[A-Za-z0-9]+(?: [A-Za-z0-9]+)*$/;
/** Tags that would pass for the site or its staff. */
const RESERVED_TAGS: ReadonlySet<string> = new Set(["CALLZ", "CALLS", "ADMIN", "MOD", "MODS", "DEV", "DEVS", "TEAM", "STAFF", "FLAP", "BNB", "CZ"]);

/** A clan tag in the one form it is stored in, or what is wrong with it. */
function clanTag(raw: string): { tag: string } | string {
  const tag = raw.trim().toUpperCase();
  if (!TAG.test(tag)) return `A tag is ${MIN_TAG_LENGTH} to ${MAX_TAG_LENGTH} letters and digits.`;
  if (RESERVED_TAGS.has(tag)) return "That tag is reserved. Choose another.";
  return { tag };
}

/** A clan name as it is stored, or what is wrong with it. */
function clanName(raw: string): { name: string } | string {
  const name = raw.trim().replace(/ {2,}/g, " ");
  if (name.length < MIN_CLAN_NAME_LENGTH || name.length > MAX_CLAN_NAME_LENGTH) return `A clan name is ${MIN_CLAN_NAME_LENGTH} to ${MAX_CLAN_NAME_LENGTH} characters.`;
  if (!CLAN_NAME.test(name)) return "A clan name is letters, digits and single spaces.";
  return { name };
}

type Outcome = { kind: "done" | "error"; text: string };

function OutcomeNote({ outcome, testId }: { outcome: Outcome | null; testId: string }) {
  if (!outcome) return null;
  return <p className={`trade-outcome trade-${outcome.kind}`} data-testid={testId} role={outcome.kind === "error" ? "alert" : "status"}>{outcome.text}</p>;
}

/** Signing in: one signature from the connected wallet, asked for only when the visitor presses the button. */
function SignInGate({ account }: { account: string }) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      await signIn(account);
    } catch (cause) {
      setError(said(cause, "Signing in did not go through. Try again."));
    } finally {
      setWorking(false);
    }
  };
  return (
    <>
      <p className="clan-note">Sign in with your wallet to see your clan and your invites. It is one signature: it sends no transaction and costs nothing.</p>
      <div className="actions">
        <button type="button" className="button" data-testid="clan-sign-in" disabled={working} onClick={() => void go()}>{working ? "Sign in your wallet…" : "Sign in"}</button>
      </div>
      {error !== null && <p className="trade-outcome trade-error" data-testid="clan-outcome" role="alert">{error}</p>}
    </>
  );
}

function FoundForm({ account, onFounded }: { account: string; onFounded(next: Mine): void }) {
  const own = useDisplayName(account);
  const nameHint = useId();
  const tagHint = useId();
  const [name, setName] = useState("");
  const [tag, setTag] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkedName = clanName(name);
  const checkedTag = clanTag(tag);
  const nameProblem = name.trim() !== "" && typeof checkedName === "string" ? checkedName : null;
  const tagProblem = tag.trim() !== "" && typeof checkedTag === "string" ? checkedTag : null;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (working || typeof checkedName === "string" || typeof checkedTag === "string") return;
    setWorking(true);
    setError(null);
    try {
      onFounded(await send("/api/clans", { name: checkedName.name, tag: checkedTag.tag }, readMine));
    } catch (cause) {
      setError(said(cause, "The clan could not be founded. Try again."));
    } finally {
      setWorking(false);
    }
  };

  return (
    <form className="clan-form" data-testid="clan-found" onSubmit={(event) => void submit(event)} noValidate>
      <label className="field">
        <span className="stat-label">Clan name</span>
        <input
          type="text"
          name="clan-name"
          value={name}
          maxLength={48}
          autoComplete="off"
          spellCheck={false}
          readOnly={working}
          aria-invalid={nameProblem !== null}
          aria-describedby={nameHint}
          onChange={(event) => setName(event.target.value)}
        />
        <span id={nameHint} className="dim field-hint clan-hint" data-invalid={nameProblem !== null} aria-live="polite">
          {nameProblem ?? `${MIN_CLAN_NAME_LENGTH} to ${MAX_CLAN_NAME_LENGTH} characters: letters, digits and single spaces.`}
        </span>
      </label>
      <label className="field">
        <span className="stat-label">Tag</span>
        <input
          type="text"
          name="clan-tag"
          className="num"
          value={tag}
          maxLength={12}
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          readOnly={working}
          aria-invalid={tagProblem !== null}
          aria-describedby={tagHint}
          onChange={(event) => setTag(event.target.value.toUpperCase())}
        />
        <span id={tagHint} className="dim field-hint clan-hint" data-invalid={tagProblem !== null} aria-live="polite">
          {tagProblem ?? `${MIN_TAG_LENGTH} to ${MAX_TAG_LENGTH} letters and digits.`}
        </span>
      </label>
      <p className="clan-preview" data-testid="clan-preview">
        <span className="stat-label">How your name will look</span>
        {/* Until the tag typed is one a clan can have, the preview stands in the word TAG for it. */}
        <AuthorName className="board-who" address={account} name={own.name} clan={typeof checkedTag === "string" ? "TAG" : checkedTag.tag} />
      </p>
      <div className="actions">
        <button type="submit" className="button" data-testid="clan-found-submit" disabled={working || typeof checkedName === "string" || typeof checkedTag === "string"}>
          {working ? "Founding…" : "Found the clan"}
        </button>
      </div>
      {error !== null && <p className="trade-outcome trade-error clan-wide" data-testid="clan-outcome" role="alert">{error}</p>}
    </form>
  );
}

/** The signed-in wallet in no clan: the invites waiting for it, and the form that founds one. */
function NoClan({ account, data, onMine }: { account: string; data: Mine; onMine(next: Mine): void }) {
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const answer = async (action: "join" | "decline", tag: string) => {
    if (working !== null) return;
    setWorking(`${action}:${tag}`);
    setError(null);
    try {
      onMine(await send(`/api/clans/${encodeURIComponent(tag)}/${action}`, {}, readMine));
    } catch (cause) {
      setError(said(cause, action === "join" ? "Joining did not go through. Try again." : "The invite could not be declined. Try again."));
    } finally {
      setWorking(null);
    }
  };

  return (
    <>
      <div className="clan-block">
        <h3>Invites <span className="dim">{data.invites.length}</span></h3>
        {data.invites.length === 0 ? (
          <p className="clan-note" data-testid="clan-invites-empty">No invites waiting. Any member of a clan can invite your wallet.</p>
        ) : (
          <ul className="clan-list" data-testid="clan-invites">
            {data.invites.map((invite) => (
              <li key={invite.tag} data-testid="clan-invite">
                <span className="clan-list-main">
                  <a className="board-link" href={clanHref(invite.tag)}><ClanName tag={invite.tag} name={invite.name} /></a>
                  <span className="clan-list-sub">Invited by <Who wallet={invite.invitedBy} name={invite.invitedByName} /> · {ago(invite.createdAt)}</span>
                </span>
                <span className="clan-list-actions">
                  <button type="button" className="button" data-testid="clan-join" disabled={working !== null} onClick={() => void answer("join", invite.tag)}>
                    {working === `join:${invite.tag}` ? "Joining…" : "Join"}
                  </button>
                  <button type="button" className="button button-quiet" data-testid="clan-decline" disabled={working !== null} onClick={() => void answer("decline", invite.tag)}>
                    {working === `decline:${invite.tag}` ? "Declining…" : "Decline"}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        {error !== null && <p className="trade-outcome trade-error" data-testid="clan-outcome" role="alert">{error}</p>}
      </div>
      <div className="clan-block">
        <h3>Found a clan</h3>
        <FoundForm account={account} onFounded={onMine} />
      </div>
    </>
  );
}

function InviteForm({ tag, onInvited }: { tag: string; onInvited(): void }) {
  const hint = useId();
  const [draft, setDraft] = useState("");
  const [working, setWorking] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const typed = draft.trim();
  const problem = typed === "" || WALLET.test(typed) ? null : "A wallet address is 0x followed by 40 letters and digits.";

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (working || typed === "" || problem !== null) return;
    setWorking(true);
    setOutcome(null);
    try {
      await api<unknown>(`/api/clans/${encodeURIComponent(tag)}/invites`, { body: { wallet: typed } });
      setDraft("");
      setOutcome({ kind: "done", text: `Invited ${short(typed)}. The invite waits for them on this page, under My clan.` });
      onInvited();
    } catch (cause) {
      setOutcome({ kind: "error", text: said(cause, "The invite could not be sent. Try again.") });
    } finally {
      setWorking(false);
    }
  };

  return (
    <>
      <form className="clan-invite" data-testid="clan-invite-form" onSubmit={(event) => void submit(event)} noValidate>
        <label className="field">
          <span className="stat-label">Invite a wallet</span>
          <input
            type="text"
            name="wallet"
            className="num"
            value={draft}
            maxLength={64}
            placeholder="0x…"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            readOnly={working}
            aria-invalid={problem !== null}
            aria-describedby={hint}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <button type="submit" className="button" data-testid="clan-invite-submit" disabled={working || typed === "" || problem !== null}>{working ? "Inviting…" : "Invite"}</button>
      </form>
      <p id={hint} className="dim field-hint clan-hint" data-invalid={problem !== null} aria-live="polite">
        {problem ?? "Any member can invite. The invited wallet decides whether to join."}
      </p>
      <OutcomeNote outcome={outcome} testId="clan-outcome" />
    </>
  );
}

/** Leaving, behind a step that says what leaving does. */
function LeaveClan({ account, clan, members, onOpen, onLeft }: { account: string; clan: Clan; members: Member[]; onOpen(): void; onLeft(next: Mine): void }) {
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const others = members.filter((member) => !same(member.wallet, account));
  const heir = others[0];

  const leave = async () => {
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      onLeft(await send("/api/clans/leave", {}, readMine));
    } catch (cause) {
      setError(said(cause, "Leaving did not go through. Try again."));
    } finally {
      setWorking(false);
    }
  };

  if (!confirming) {
    return (
      <div className="actions">
        <button
          type="button"
          className="button button-warn"
          data-testid="clan-leave"
          onClick={() => {
            // The members are read again, so what the next step says about the last member and the founder is current.
            onOpen();
            setError(null);
            setConfirming(true);
          }}
        >
          Leave the clan
        </button>
      </div>
    );
  }
  return (
    <div className="clan-confirm" data-testid="clan-leave-confirm" role="group" aria-label="Leave the clan">
      <p><strong>Leave <span className="clan-tag">[{clan.tag}]</span> {clan.name}?</strong></p>
      <p>Your tag disappears from your name. If you are the last member, the clan is gone, with the invites it has out. If you are the founder, that place passes to the longest-standing member.</p>
      {others.length === 0 ? (
        <p data-testid="clan-leave-effect"><strong>You are the last member: this clan will be gone.</strong></p>
      ) : same(clan.founder, account) && heir ? (
        <p data-testid="clan-leave-effect"><strong>You are the founder.</strong> The place passes to <Who wallet={heir.wallet} name={heir.name} />.</p>
      ) : null}
      <div className="actions">
        <button type="button" className="button button-warn" data-testid="clan-leave-yes" disabled={working} onClick={() => void leave()}>{working ? "Leaving…" : "Yes, leave"}</button>
        <button type="button" className="button button-quiet" data-testid="clan-leave-no" disabled={working} onClick={() => setConfirming(false)}>Stay</button>
      </div>
      {error !== null && <p className="trade-outcome trade-error" data-testid="clan-outcome" role="alert">{error}</p>}
    </div>
  );
}

/** The signed-in wallet's clan: who is in it, inviting to it, the invites it has out, and leaving. */
function InClan({ account, clan, data, onReload, onMine }: { account: string; clan: Clan; data: Mine; onReload(): void; onMine(next: Mine): void }) {
  return (
    <>
      <div className="clan-block">
        <p className="clan-title" data-testid="my-clan-name">
          <a className="board-link" href={clanHref(clan.tag)}><ClanName tag={clan.tag} name={clan.name} /></a>
          <span className="clan-list-sub">{plural(clan.members, "member", "members")} · {plural(clan.points, "point", "points")}</span>
        </p>
        <ul className="clan-list" data-testid="my-clan-members">
          {data.members.map((member) => (
            <li key={member.wallet} data-testid="my-clan-member">
              <span className="clan-list-main">
                <Who wallet={member.wallet} name={member.name} clan={clan.tag} />
                {same(member.wallet, clan.founder) && <span className="tag tag-gold">Founder</span>}
                {same(member.wallet, account) && <span className="tag tag-muted">You</span>}
              </span>
              <span className="num">{plural(member.points, "point", "points")}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="clan-block">
        <InviteForm tag={clan.tag} onInvited={onReload} />
        <h3>Invites out <span className="dim">{data.sent.length}</span></h3>
        {data.sent.length === 0 ? (
          <p className="clan-note" data-testid="clan-sent-empty">No invites waiting for an answer.</p>
        ) : (
          <ul className="clan-list" data-testid="clan-sent">
            {data.sent.map((invite) => (
              <li key={invite.wallet} data-testid="clan-sent-invite">
                <span className="clan-list-main"><Who wallet={invite.wallet} name={invite.name} /></span>
                <span className="clan-list-sub">Invited by {same(invite.invitedBy, account) ? "you" : <a className="board-link board-who" href={profileHref(invite.invitedBy)}>{short(invite.invitedBy)}</a>} · {ago(invite.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {data.invites.length > 0 && (
        <p className="clan-note" data-testid="clan-other-invites">
          You also have {data.invites.length === 1 ? "an invite" : "invites"} to{" "}
          {data.invites.map((invite, index) => (
            <span key={invite.tag}>{index > 0 && ", "}<a href={clanHref(invite.tag)}>[{invite.tag}] {invite.name}</a></span>
          ))}
          . A wallet is in one clan at most: leave this one to take another up.
        </p>
      )}
      <div className="clan-block">
        <LeaveClan account={account} clan={clan} members={data.members} onOpen={onReload} onLeft={onMine} />
      </div>
    </>
  );
}

function SignedInClan({ account, onChange }: { account: string; onChange(): void }) {
  const mine = useLoad("/api/clans/mine", readMine, REFRESH_MS);
  const { put } = mine;
  // What a change returns is the wallet's new standing; the list of every clan is read again to match it.
  const onMine = useCallback(
    (next: Mine) => {
      put(next);
      onChange();
    },
    [put, onChange],
  );
  return (
    <Waiting result={mine} what="your clan">
      {(data) =>
        data.clan ? <InClan account={account} clan={data.clan} data={data} onReload={mine.reload} onMine={onMine} /> : <NoClan account={account} data={data} onMine={onMine} />
      }
    </Waiting>
  );
}

function MyClan({ onChange }: { onChange(): void }) {
  const wallet = useWallet();
  const account = wallet.account;
  const signedIn = useSignedIn(account);
  return (
    <section className="clan-panel" data-testid="my-clan" aria-label="My clan">
      <h2>My clan</h2>
      <p className="clan-note">Your clan's tag is shown in brackets before your name in every chat and list.</p>
      {!wallet.available ? (
        <p className="clan-note">No browser wallet found. Install MetaMask, Rabby or another wallet to found or join a clan.</p>
      ) : !account ? (
        <div className="actions"><button type="button" className="button" data-testid="clan-connect" onClick={connect}>Connect wallet</button></div>
      ) : !signedIn ? (
        <SignInGate account={account} />
      ) : (
        <SignedInClan key={account} account={account} onChange={onChange} />
      )}
    </section>
  );
}

function ClansPage({ mobile }: { mobile: boolean }) {
  const all = useLoad("/api/clans", readClans, REFRESH_MS);
  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Clans</h1>
        <p className="lede">Groups of wallets under one tag. A wallet is in one clan at most. Any member can invite a wallet, and the invited wallet decides.</p>
      </div>
      <MyClan onChange={all.reload} />
      <section className="board-section">
        <div className="section-head">
          <h2>All clans {all.state === "ready" && <span className="dim">{all.data.length}</span>}</h2>
        </div>
        <Waiting result={all} what="the clans">
          {(clans) => {
            if (clans.length === 0) return <p className="note" data-testid="clans-empty">No clans yet. Found the first one.</p>;
            if (mobile) {
              return (
                <ul className="cards" data-testid="clan-cards">
                  {clans.map((clan) => (
                    <li key={clan.tag}>
                      <a className="card clan-card" data-testid="clan-row" href={clanHref(clan.tag)}>
                        <span className="card-head"><span><ClanName tag={clan.tag} name={clan.name} /></span></span>
                        <span className="card-line">{plural(clan.members, "member", "members")} · {plural(clan.points, "point", "points")}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              );
            }
            return (
              <div className="table-wrap">
                <table className="table board-table" data-testid="clan-table">
                  <thead>
                    <tr><th>Tag</th><th>Name</th><th>Members</th><th>Points</th></tr>
                  </thead>
                  <tbody>
                    {clans.map((clan) => (
                      <tr key={clan.tag} data-testid="clan-row">
                        <td><a className="board-link" href={clanHref(clan.tag)}><span className="clan-tag">[{clan.tag}]</span></a></td>
                        <td><a className="board-link" href={clanHref(clan.tag)}><strong>{clan.name}</strong></a></td>
                        <td className="num">{count(clan.members)}</td>
                        <td className="num">{count(clan.points)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }}
        </Waiting>
      </section>
    </>
  );
}

// ── One clan ─────────────────────────────────────────────────────────────

function ClanPage({ tag, mobile, me }: { tag: string; mobile: boolean; me: string | null }) {
  const result = useLoad(`/api/clans/${encodeURIComponent(tag)}`, readClanDetail, REFRESH_MS);
  if (result.state === "error" && result.status === 404) {
    return <p className="note" role="alert" data-testid="clan-missing">There is no such clan. <a href="#/clans">Back to all clans.</a></p>;
  }
  return (
    <Waiting result={result} what="the clan">
      {({ clan, members }) => {
        const founder = members.find((member) => same(member.wallet, clan.founder));
        return (
          <>
            <div className="page-head">
              <h1 className="page-title profile-title" data-testid="clan-name"><span className="clan-tag">[{clan.tag}]</span> <span>{clan.name}</span></h1>
              <p className="profile-line" data-testid="clan-founder">
                <span className="dim">Founded by</span> <Who wallet={clan.founder} name={founder?.name ?? null} clan={founder ? clan.tag : null} />
              </p>
            </div>
            <dl className="stats" data-testid="clan-stats">
              <div><dt>Points</dt><dd className="num">{count(clan.points)}</dd></div>
              <div><dt>Members</dt><dd className="num">{count(clan.members)}</dd></div>
              <div><dt>Founded</dt><dd className="num">{day(clan.createdAt)}</dd></div>
            </dl>
            <section className="board-section">
              <div className="section-head">
                <h2>Members <span className="dim">{members.length}</span></h2>
                <a href="#/clans">All clans →</a>
              </div>
              {mobile ? (
                <ul className="cards" data-testid="clan-members">
                  {members.map((member) => (
                    <li key={member.wallet}>
                      <a className="card board-card" data-testid="clan-member" data-own={same(member.wallet, me)} href={profileHref(member.wallet)}>
                        <span className="card-head">
                          <AuthorName className="board-who" address={member.wallet} name={member.name} clan={clan.tag} />
                          {same(member.wallet, clan.founder) && <span className="tag tag-gold">Founder</span>}
                        </span>
                        <span className="card-line">Joined {day(member.joinedAt)} · {plural(member.points, "point", "points")}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="table-wrap">
                  <table className="table board-table" data-testid="clan-members">
                    <thead>
                      <tr><th>Who</th><th>Joined</th><th>Points</th></tr>
                    </thead>
                    <tbody>
                      {members.map((member) => (
                        <tr key={member.wallet} data-testid="clan-member" data-own={same(member.wallet, me)}>
                          <td>
                            <Who wallet={member.wallet} name={member.name} clan={clan.tag} />
                            {same(member.wallet, clan.founder) && <span className="tag tag-gold board-you">Founder</span>}
                            {same(member.wallet, me) && <span className="tag tag-muted board-you">You</span>}
                          </td>
                          <td className="num">{day(member.joinedAt)}</td>
                          <td className="num">{count(member.points)}</td>
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
    </Waiting>
  );
}

// ── A wallet's profile ───────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 2500);
    return () => window.clearTimeout(timer);
  }, [state]);
  const copy = () => {
    // The clipboard is only there on a page served securely, and the browser may still say no.
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (!clipboard) return setState("failed");
    clipboard.writeText(text).then(() => setState("copied"), () => setState("failed"));
  };
  return (
    <button type="button" className="button button-quiet profile-copy" data-testid="profile-copy" onClick={copy}>
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Not copied: select it" : "Copy"}</span>
    </button>
  );
}

const NAME_STEP_TEXT = { signing: "Sign in wallet…", saving: "Saving…" } as const;
const NAME_RULES = "3 to 20 letters, digits or underscores, starting with a letter. Shown beside your address in chat and on callouts.";

/**
 * The connected wallet's display name on its own profile: the same form, rules and words as the one in the
 * wallet menu (apps/web/src/positions.tsx). The wallet signs each change and the Worker decides; whatever the
 * Worker answers to a refused change is shown as it is.
 */
function ProfileName({ account, inClan }: { account: string; inClan: boolean }) {
  const own = useDisplayName(account);
  const hintId = useId();
  const [draft, setDraft] = useState("");
  const [working, setWorking] = useState<{ action: "save" | "remove"; step: keyof typeof NAME_STEP_TEXT } | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  // Read again when the profile opens: the name may have been changed from another device.
  useEffect(() => {
    void loadDisplayName(account);
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
      setOutcome({ kind: "error", text: said(cause, "The name could not be saved. Try again.") });
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
    <section className="profile-panel" data-testid="profile-name" aria-label="Display name">
      <p className="positions-head">
        <strong>Display name</strong>
        {own.name !== null ? (
          <span className="positions-name-current" data-testid="profile-name-current">
            <span className="author-name">{own.name}</span>{" "}
            <span className="author-address">{short(account)}</span>
          </span>
        ) : (
          <span className="dim" data-testid="profile-name-current">{own.state === "loading" ? "…" : own.state === "error" ? "Could not be read" : "Not set"}</span>
        )}
      </p>
      <form className="positions-name-form" onSubmit={submit} noValidate>
        <label className="positions-name-input">
          <span className="visually-hidden">{own.name !== null ? "New display name" : "Display name"}</span>
          <input
            type="text"
            name="profile-display-name"
            data-testid="profile-name-input"
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
        <button type="submit" className="button positions-name-save" data-testid="profile-name-save" disabled={working !== null || typed === "" || problem !== null || unchanged}>
          {working?.action === "save" ? NAME_STEP_TEXT[working.step] : "Save"}
        </button>
        {own.name !== null && (
          <button type="button" className="positions-sell positions-name-remove" data-testid="profile-name-remove" disabled={working !== null} onClick={() => void change("remove", null)}>
            {working?.action === "remove" ? NAME_STEP_TEXT[working.step] : "Remove"}
          </button>
        )}
      </form>
      <p id={hintId} className="positions-name-hint" data-invalid={problem !== null} aria-live="polite">
        {problem ?? (unchanged ? "That is your name already." : NAME_RULES)}
      </p>
      <OutcomeNote outcome={outcome} testId="profile-name-outcome" />
      <div className="actions">
        <a className="button button-quiet" data-testid="profile-manage-clan" href="#/clans">{inClan ? "Manage your clan" : "Found or join a clan"}</a>
      </div>
    </section>
  );
}

// What a profile reads from BNB Chain. The chain library comes with apps/web/src/trade.ts, asked for here so
// that the boards and the clans never load it.

/** How often a profile reads the chain again. */
const CHAIN_REFRESH_MS = 60_000;

type Read<T> = { state: "loading" } | { state: "error" } | { state: "ready"; data: T };

/** Reads `load` now and again every `refreshMs` while the page is in view, keeping the last good answer through a failed refresh. */
function useRead<T>(load: () => Promise<T>, refreshMs: number): Read<T> {
  const [result, setResult] = useState<Read<T>>({ state: "loading" });
  useEffect(() => {
    let live = true;
    let turn = 0;
    const run = () => {
      const mine = ++turn;
      load().then(
        (data) => {
          if (live && mine === turn) setResult({ state: "ready", data });
        },
        () => {
          if (live && mine === turn) setResult((previous) => (previous.state === "ready" ? previous : { state: "error" }));
        },
      );
    };
    setResult({ state: "loading" });
    run();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") run();
    }, refreshMs);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [load, refreshMs]);
  return result;
}

/** Control characters, zero-width and text-direction marks: never part of a label read from a contract. */
const UNSEEN = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩]/g;
/** A token's own name or symbol as one short clean line. Null when it has none. */
const label = (raw: string | null | undefined): string | null => {
  const text = typeof raw === "string" ? [...raw.replace(UNSEEN, "").trim()].slice(0, 40).join("") : "";
  return text === "" ? null : text;
};

/** An amount of BNB to six places, never rounded up. Something too small to show at six places is said to be so, not shown as nothing. */
const bnbText = (wei: bigint): string => {
  const text = amount(wei, 6);
  return wei > 0n && text === "0" ? "<0.000001" : text;
};
/** A gain or a loss in BNB, with its sign. */
const signedBnb = (wei: bigint): string => (wei === 0n ? "0 BNB" : `${wei < 0n ? "−" : "+"}${bnbText(wei < 0n ? -wei : wei)} BNB`);
/** `change` as a percentage of `base`, to two places, never rounded up. Null when there is nothing to compare with. */
function signedPercent(change: bigint, base: bigint): string | null {
  if (base <= 0n) return null;
  const hundredths = ((change < 0n ? -change : change) * 10_000n) / base;
  const text = `${(hundredths / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${(hundredths % 100n).toString().padStart(2, "0")}%`;
  return change === 0n || hundredths === 0n ? (change === 0n ? "0.00%" : `${change < 0n ? "−" : "+"}<0.01%`) : `${change < 0n ? "−" : "+"}${text}`;
}
const toneOf = (change: bigint): "good" | "warn" | undefined => (change > 0n ? "good" : change < 0n ? "warn" : undefined);

/** A room's picture, or a drawn stand-in carrying the first letters of its symbol. */
function RoomPicture({ picture, text }: { picture: string | null; text: string }) {
  const [failed, setFailed] = useState(false);
  const letters = [...text.trim()].slice(0, 3).join("").toUpperCase() || "?";
  return (
    <span className="profile-art">
      {picture !== null && !failed ? <img src={`/api/rooms/image/${picture}`} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} /> : <span aria-hidden="true">{letters}</span>}
    </span>
  );
}

interface Holding {
  token: string;
  symbol: string | null;
  name: string | null;
  /** Null when the token did not say: the amount is then not shown. */
  decimals: number | null;
  balance: bigint;
  /** BNB that selling the whole balance returns now, after the token's tax and the CallZ fee. Null when no pool could be read. */
  worth: bigint | null;
}

interface Holdings {
  bnb: bigint;
  tokens: Holding[];
}

/**
 * What `address` holds on BNB Chain of the tokens CallZ knows: the ones its mints launched, and `roomTokens`,
 * the ones launched by the Cook Rooms the wallet is in. Each is priced the way the wallet menu prices a
 * position (apps/web/src/positions.tsx): what selling all of it through PancakeSwap would return right now.
 */
async function readHoldings(address: string, roomTokens: readonly string[]): Promise<Holdings> {
  const [{ callzTokens, client, heldTokens, loadMarket, quoteSell }, { erc20Abi }] = await Promise.all([import("./trade"), import("viem")]);
  const account = address.toLowerCase() as Address;
  const [bnb, launched] = await Promise.all([client.getBalance({ address: account }), callzTokens()]);
  const candidates = [...new Set([...launched.map((token) => token.toLowerCase()), ...roomTokens])] as Address[];
  const held = await heldTokens(account, candidates);
  const tokens = await Promise.all(
    held.map(async ({ token, balance }): Promise<Holding> => {
      try {
        const market = await loadMarket(token);
        const quote = await quoteSell(market, balance).catch(() => null);
        return { token, symbol: label(market.symbol), name: label(market.name), decimals: market.decimals, balance, worth: quote?.amountOut ?? null };
      } catch {
        // No pool with liquidity, or none that could be read: the balance is still shown, without a value.
        const read = <T,>(functionName: "symbol" | "name" | "decimals") => client.readContract({ address: token, abi: erc20Abi, functionName }).catch(() => null) as Promise<T | null>;
        const [symbol, name, decimals] = await Promise.all([read<string>("symbol"), read<string>("name"), read<number>("decimals")]);
        return { token, symbol: label(symbol), name: label(name), decimals: typeof decimals === "number" ? decimals : null, balance, worth: null };
      }
    }),
  );
  // The most valuable first; the ones without a value after them.
  tokens.sort((a, b) => (a.worth === null ? (b.worth === null ? 0 : 1) : b.worth === null ? -1 : b.worth > a.worth ? 1 : b.worth < a.worth ? -1 : 0));
  return { bnb, tokens };
}

function ProfileHoldings({ address, rooms }: { address: string; rooms: ProfileRoom[] }) {
  // The tokens of the launched rooms, as one text: the same rooms read again are the same thing to load.
  const roomTokens = useMemo(() => [...new Set(rooms.flatMap((room) => (room.launched && room.token !== null ? [room.token] : [])))].sort().join(","), [rooms]);
  const load = useCallback(() => readHoldings(address, roomTokens === "" ? [] : roomTokens.split(",")), [address, roomTokens]);
  const result = useRead(load, CHAIN_REFRESH_MS);
  /** What the room said its token is called, for a token that does not say itself. */
  const known = new Map(rooms.flatMap((room) => (room.token !== null ? [[room.token, room] as const] : [])));
  return (
    <section className="profile-panel" data-testid="profile-holdings" aria-label="Holdings">
      <h2>Holdings</h2>
      <p className="clan-note">
        BNB and the tokens launched on CallZ that this wallet holds on BNB Chain, not everything it owns. A value is what selling the whole
        balance on PancakeSwap would return right now, after the token's tax and the trading fee.
      </p>
      {result.state === "loading" && <p className="clan-note" role="status" data-testid="profile-holdings-loading">Reading the balances from BNB Chain…</p>}
      {result.state === "error" && <p className="clan-note" role="alert" data-testid="profile-holdings-error">BNB Chain could not be reached, so the holdings are not shown. Reload to try again.</p>}
      {result.state === "ready" && (() => {
        const { bnb, tokens } = result.data;
        const priced = tokens.filter((token) => token.worth !== null);
        const unpriced = tokens.length - priced.length;
        const total = priced.reduce((sum, token) => sum + (token.worth ?? 0n), bnb);
        return (
          <>
            <ul className="profile-rows" data-testid="profile-holdings-list">
              <li className="profile-row" data-testid="profile-holding-bnb">
                <span className="profile-row-main"><strong>BNB</strong></span>
                <span className="profile-row-side num">{bnbText(bnb)} BNB</span>
              </li>
              {tokens.map((token) => {
                const room = known.get(token.token);
                const symbol = token.symbol ?? room?.symbol ?? short(token.token);
                const name = token.name ?? room?.name ?? null;
                return (
                  <li key={token.token} className="profile-row" data-testid="profile-holding" data-token={token.token}>
                    <a className="profile-row-main profile-row-link" href={`#/token/${token.token}`}>
                      <strong>{symbol}</strong>
                      {name !== null && name !== symbol && <span className="dim">{name}</span>}
                    </a>
                    <span className="profile-row-side num">
                      <span>{token.decimals === null ? "Amount not readable" : amount(token.balance, 2, token.decimals)}</span>
                      <span className="dim" data-testid="profile-holding-value">{token.worth === null ? "— (no pool read)" : `≈ ${bnbText(token.worth)} BNB`}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
            {tokens.length === 0 && <p className="clan-note" data-testid="profile-holdings-empty">This wallet holds no token launched on CallZ.</p>}
            <p className="profile-total" data-testid="profile-holdings-total">
              <strong>Total</strong>
              <span className="num">≈ {bnbText(total)} BNB</span>
            </p>
            {unpriced > 0 && (
              <p className="clan-note" data-testid="profile-holdings-unpriced">
                {unpriced === 1 ? "1 token has" : `${count(unpriced)} tokens have`} no value here, because no pool could be read, and {unpriced === 1 ? "is" : "are"} not in the total.
              </p>
            )}
          </>
        );
      })()}
    </section>
  );
}

/** The room's pass share and its pool, as the chain has them. */
const passAbi = [
  { type: "function", name: "tokensPerSeat", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "getReserves", stateMutability: "view", inputs: [], outputs: [{ type: "uint112" }, { type: "uint112" }, { type: "uint32" }] },
] as const;

/**
 * What one pass's share of the token is worth now, in wei, for each launched room: the tokens a pass claims
 * (`tokensPerSeat()` on the room) at the price of the room's own PancakeSwap pool against BNB. Null for a room
 * whose share or pool could not be read, or whose pair is not that token against BNB.
 */
async function readPassValues(rooms: ReadonlyArray<{ room: string; token: string; pair: string }>): Promise<Record<string, bigint | null>> {
  if (rooms.length === 0) return {};
  const { client, WBNB } = await import("./trade");
  const results = await client.multicall({
    allowFailure: true,
    contracts: rooms.flatMap(({ room, pair }) => [
      { address: room as Address, abi: passAbi, functionName: "tokensPerSeat" as const },
      { address: pair as Address, abi: passAbi, functionName: "token0" as const },
      { address: pair as Address, abi: passAbi, functionName: "token1" as const },
      { address: pair as Address, abi: passAbi, functionName: "getReserves" as const },
    ]),
  });
  const values: Record<string, bigint | null> = {};
  rooms.forEach(({ room, token }, index) => {
    values[room] = null;
    const [share, token0, token1, pool] = results.slice(index * 4, index * 4 + 4);
    if (share?.status !== "success" || token0?.status !== "success" || token1?.status !== "success" || pool?.status !== "success") return;
    const perPass = share.result as bigint;
    const first = (token0.result as string).toLowerCase();
    const second = (token1.result as string).toLowerCase();
    const [reserve0, reserve1] = pool.result as readonly [bigint, bigint, number];
    const bnbSide = WBNB.toLowerCase();
    const reserves = first === token && second === bnbSide ? { token: reserve0, bnb: reserve1 } : second === token && first === bnbSide ? { token: reserve1, bnb: reserve0 } : null;
    if (reserves === null || reserves.token === 0n) return;
    values[room] = (perPass * reserves.bnb) / reserves.token;
  });
  return values;
}

function ProfilePasses({ rooms }: { rooms: ProfileRoom[] }) {
  const passes = rooms.filter((room) => room.seat !== null);
  // The rooms whose pass can be valued, as one text: the same rooms read again are the same thing to load.
  const pricedKey = useMemo(
    () => rooms.flatMap((room) => (room.seat !== null && room.launched && room.token !== null && room.pair !== null ? [`${room.room.toLowerCase()}:${room.token}:${room.pair}`] : [])).join(","),
    [rooms],
  );
  const load = useCallback(
    () =>
      readPassValues(
        pricedKey === "" ? [] : pricedKey.split(",").map((entry) => {
          const [room = "", token = "", pair = ""] = entry.split(":");
          return { room, token, pair };
        }),
      ),
    [pricedKey],
  );
  const result = useRead(load, CHAIN_REFRESH_MS);
  const values = result.state === "ready" ? result.data : {};

  let pricedCount = 0;
  let totalCost = 0n;
  let totalValue = 0n;
  const rows = passes.map((room) => {
    const value = room.launched ? values[room.room.toLowerCase()] ?? null : null;
    if (room.seatPrice !== null && value !== null) {
      pricedCount += 1;
      totalCost += room.seatPrice;
      totalValue += value;
    }
    return { room, value };
  });
  return (
    <section className="profile-panel" data-testid="profile-passes" aria-label="Cook Room passes: cost and value now">
      <h2>Cook Room passes: cost and value now <span className="dim">{passes.length}</span></h2>
      <p className="clan-note">What each pass cost against what its share of the token is worth now. It does not know whether the wallet has sold.</p>
      {passes.length === 0 ? (
        <p className="clan-note" data-testid="profile-passes-empty">This wallet holds no Cook Room pass.</p>
      ) : (
        <>
          {pricedKey !== "" && result.state === "loading" && <p className="clan-note" role="status" data-testid="profile-passes-loading">Reading the pools from BNB Chain…</p>}
          {pricedKey !== "" && result.state === "error" && <p className="clan-note" role="alert" data-testid="profile-passes-error">BNB Chain could not be reached, so no value is shown. Reload to try again.</p>}
          <ul className="profile-rows" data-testid="profile-passes-list">
            {rows.map(({ room, value }) => {
              const cost = room.seatPrice;
              const change = cost !== null && value !== null ? value - cost : null;
              const percent = change !== null && cost !== null ? signedPercent(change, cost) : null;
              return (
                <li key={room.room} className="profile-row profile-pass" data-testid="profile-pass" data-room={room.room.toLowerCase()}>
                  <a className="profile-row-main profile-row-link" href={roomHref(room.room)}>
                    <strong>{roomName(room)}</strong>
                    {room.symbol && <span className="dim">{room.symbol}</span>}
                    <span className="dim num">Pass #{room.seat}</span>
                  </a>
                  <dl className="profile-pass-facts">
                    <div><dt>Cost</dt><dd className="num" data-testid="profile-pass-cost">{cost === null ? "—" : `${bnbText(cost)} BNB`}</dd></div>
                    <div>
                      <dt>Value now</dt>
                      <dd className="num" data-testid="profile-pass-value">{!room.launched ? "Not launched" : value === null ? "—" : `${bnbText(value)} BNB`}</dd>
                    </div>
                    <div>
                      <dt>Difference</dt>
                      <dd className="num profile-gain" data-tone={change === null ? undefined : toneOf(change)} data-testid="profile-pass-change">
                        {change === null ? "—" : `${signedBnb(change)}${percent === null ? "" : ` (${percent})`}`}
                      </dd>
                    </div>
                  </dl>
                </li>
              );
            })}
            {pricedCount > 0 && (
              <li className="profile-row profile-pass profile-pass-total" data-testid="profile-passes-total">
                <span className="profile-row-main">
                  <strong>Total</strong>
                  <span className="dim">{pricedCount === passes.length ? plural(pricedCount, "pass", "passes") : `${count(pricedCount)} of ${plural(passes.length, "pass", "passes")}: the ones with a value`}</span>
                </span>
                <dl className="profile-pass-facts">
                  <div><dt>Cost</dt><dd className="num">{bnbText(totalCost)} BNB</dd></div>
                  <div><dt>Value now</dt><dd className="num">{bnbText(totalValue)} BNB</dd></div>
                  <div>
                    <dt>Difference</dt>
                    <dd className="num profile-gain" data-tone={toneOf(totalValue - totalCost)}>
                      {signedBnb(totalValue - totalCost)}{signedPercent(totalValue - totalCost, totalCost) === null ? "" : ` (${signedPercent(totalValue - totalCost, totalCost)})`}
                    </dd>
                  </div>
                </dl>
              </li>
            )}
          </ul>
        </>
      )}
    </section>
  );
}

function ProfilePage({ address, account }: { address: string; account: string | null }) {
  const result = useLoad(`/api/profile/${address}`, readProfile, REFRESH_MS);
  const own = same(address, account);
  // On the wallet's own profile the name it has just saved shows at once, ahead of the next reading.
  const ownName = useDisplayName(own ? address : null);
  return (
    <Waiting result={result} what="the profile">
      {(data) => {
        const name = own && ownName.state === "ready" ? ownName.name : shownName(data.name);
        return (
          <>
            <div className="page-head">
              <h1 className="page-title profile-title" data-testid="profile-title">
                {data.clan && <span className="clan-tag">[{data.clan.tag}]</span>}
                <span>{name ?? short(address)}</span>
              </h1>
              <p className="profile-line">
                <code data-testid="profile-address">{address}</code>
                <CopyButton text={address} />
              </p>
              <p className="profile-line" data-testid="profile-clan">
                {data.clan ? (
                  <>
                    <span className="dim">Clan</span> <a className="board-link" href={clanHref(data.clan.tag)}><ClanName tag={data.clan.tag} name={data.clan.name} /></a>
                  </>
                ) : (
                  <span className="dim">In no clan.</span>
                )}
              </p>
            </div>
            <dl className="stats" data-testid="profile-stats">
              <div><dt>Points</dt><dd className="num">{count(data.points)}</dd></div>
              <div><dt>Cook Rooms</dt><dd className="num">{count(data.rooms.length)}</dd></div>
              <div><dt>Approved calls</dt><dd className="num">{count(data.calls)}</dd></div>
              <div><dt>Tokens called</dt><dd className="num">{count(data.tokensCalled)}</dd></div>
            </dl>
            {own && account !== null && <ProfileName account={account} inClan={data.clan !== null} />}
            <ProfileHoldings address={address} rooms={data.rooms} />
            <ProfilePasses rooms={data.rooms} />
            <div className="profile-grid">
              <section className="profile-panel" data-testid="profile-tags">
                <h2>Projects <span className="dim">{data.tags.length}</span></h2>
                {data.tags.length === 0 ? (
                  <p className="clan-note">No project tags yet. A room's dev gives a member a tag for what they do in the project.</p>
                ) : (
                  <ul className="profile-chips">
                    {data.tags.map((tag) => (
                      <li key={tag.room}>
                        <a className="chip-link" data-testid="profile-tag" href={roomHref(tag.room)}>{tag.symbol || roomName(tag)} · {tag.label}</a>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section className="profile-panel" data-testid="profile-points">
                <h2>Points earned from Cook Rooms <span className="dim">{count(data.points)}</span></h2>
                {data.byRoom.length === 0 ? (
                  <p className="clan-note">No points yet. A room's dev gives them to the room's members for what they contributed, at most 100 per member per room.</p>
                ) : (
                  <ul className="cards">
                    {data.byRoom.map((room) => (
                      <li key={room.room}>
                        <a className="card profile-card" data-testid="profile-points-row" href={roomHref(room.room)}>
                          <span className="card-head">
                            <strong>{roomName(room)} {room.symbol && <span className="dim">{room.symbol}</span>}</strong>
                            <span className="num">{plural(room.points, "point", "points")}</span>
                          </span>
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section className="profile-panel" data-testid="profile-rooms">
                <h2>Cook Rooms <span className="dim">{data.rooms.length}</span></h2>
                {data.rooms.length === 0 ? (
                  <p className="clan-note">In no Cook Room yet. <a href="#/rooms">See the Cook Rooms.</a></p>
                ) : (
                  <ul className="cards">
                    {data.rooms.map((room) => (
                      <li key={room.room}>
                        <a className="card profile-card" data-testid="profile-room" href={roomHref(room.room)}>
                          <span className="card-head">
                            <span className="profile-room-name">
                              <RoomPicture picture={room.picture} text={room.symbol || roomName(room)} />
                              <strong>{roomName(room)} {room.symbol && <span className="dim">{room.symbol}</span>}</strong>
                            </span>
                            <span className="profile-marks">
                              <span className={`tag tag-${room.dev ? "gold" : "muted"}`} data-testid="profile-room-role">{room.dev ? "Dev" : "Member"}</span>
                              {room.seat !== null && <span className="tag tag-muted num" data-testid="profile-room-pass">Pass #{room.seat}</span>}
                              {room.launched && <span className="tag tag-good">Launched</span>}
                            </span>
                          </span>
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </>
        );
      }}
    </Waiting>
  );
}

// ── The section ──────────────────────────────────────────────────────────

export default function CommunitySection({ route, mobile }: { route: CommunityRoute; mobile: boolean }) {
  const wallet = useWallet();
  const me = wallet.account ? wallet.account.toLowerCase() : null;
  return (
    <div className="board-page" data-testid={route.name}>
      <CommunityNav route={route} me={me} />
      {route.name === "leaderboard" && <LeaderboardPage mobile={mobile} me={me} />}
      {route.name === "clans" && <ClansPage mobile={mobile} />}
      {route.name === "clan" && <ClanPage key={route.tag} tag={route.tag} mobile={mobile} me={me} />}
      {route.name === "profile" && <ProfilePage key={route.address} address={route.address} account={wallet.account} />}
    </div>
  );
}
