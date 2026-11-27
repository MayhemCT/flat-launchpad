// Rooms on BNB Chain mainnet. A room is a CallZRoom contract (contracts/src/callz/CallZRoom.sol): its dev lets
// wallets in, each one buys a single pass at the room's flat price, and when every seat is taken the dev
// launches the token into a PancakeSwap pool. Three pages: the list of rooms, the form that creates one, and a
// room's own page with its members, its private chat and the dev's console.
//
// Money and standing are read from the room's contract by this page, and every action that moves either is a
// transaction the visitor's wallet signs. What the chain does not hold (the description, the applications, the
// chat and its pictures, points and tags) is this site's API, /api/rooms (apps/worker/src/rooms.ts), asked
// through the session in session.ts. Nothing a visitor typed is ever put on the page as anything but text.
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  BaseError,
  createPublicClient,
  createWalletClient,
  custom,
  decodeErrorResult,
  encodeFunctionData,
  formatEther,
  formatUnits,
  http,
  isAddress,
  parseAbi,
  parseEther,
  parseEventLogs,
  parseUnits,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { bsc } from "viem/chains";
import deployment from "./room-deployment.json";
import { AuthorName } from "./display-name";
import { ago, short } from "./format";
import { api, apiBlob, ApiError, signIn, useSignedIn } from "./session";
import { SITES } from "./site";
import { CALLZ_FACTORIES } from "./trade";
import { connect, switchChain, useWallet } from "./wallet";
// The room's chat is drawn like a token's: the same list, message and composer classes.
import "./chat.css";
import "./rooms.css";

const SITE = SITES.bsc;
/** The CallZRoomFactory. It is deployed through the deterministic CREATE2 deployer, so its address is fixed. */
const FACTORY = deployment.factory.address as Address;
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const DEAD: Address = "0x000000000000000000000000000000000000dEaD";

/** The limits CallZRoom enforces, so the form says no before the chain does. */
const MAX_CAP = parseEther("10");
const MAX_SEATS = 1000;
const MIN_SALE_SECONDS = 600;
const MAX_SALE_SECONDS = 30 * 86_400;
const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n;
/** The limits of apps/worker/src/rooms.ts, for the same reason. */
const MAX_ABOUT_LENGTH = 600;
const MAX_BRIEF_LENGTH = 300;
/** Longest text a dev can require a post on X to contain: `MAX_PHRASE_LENGTH` in apps/worker/src/rooms.ts. */
const MAX_PHRASE_LENGTH = 120;
const MAX_ROLE_LENGTH = 60;
const MAX_PORTFOLIO_LENGTH = 600;
const MAX_MESSAGE_LENGTH = 1000;
const MAX_NOTE_LENGTH = 140;
const MAX_TAG_LENGTH = 24;
const MAX_POINTS = 100;
/** The largest picture this page sends. The API takes up to 1,500,000 bytes. */
const MAX_PICTURE_BYTES = 1_400_000;
const ROOM_PICTURE_SIDE = 1024;
const CHAT_PICTURE_SIDE = 1600;

const HASH = /^[0-9a-f]{64}$/;
/** A room picture kept by this site, as its address is written into the room's contract. */
const OWN_PICTURE = /^https:\/\/callz\.fun\/api\/rooms\/image\/([0-9a-f]{64})$/;
/** A post on X in the one spelling the API stores. Anything else is shown as text, never as a link. */
const POST_URL = /^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}\/status\/\d{1,20}$/;

const factoryAbi = parseAbi([
  "struct CallZRoomConfig { string name; string symbol; string image; uint256 seatPrice; uint256 seats; uint256 saleDuration; uint16 poolShareBps; address gateToken; uint256 gateAmount; }",
  "function create(CallZRoomConfig config, bytes32 salt) returns (address room)",
  "function predict(address creator, bytes32 salt) view returns (address)",
  "function isRoom(address room) view returns (bool)",
  "function launchFeeBps() view returns (uint16)",
  "event CallZRoomCreated(address indexed room, address indexed creator, string name, string symbol, uint256 seatPrice, uint256 seats)",
]);
const roomAbi = parseAbi([
  "struct CallZRoomInfo { address creator; string tokenName; string tokenSymbol; string image; uint256 seatPrice; uint256 seats; uint256 seated; uint256 minted; uint256 raised; uint256 saleDeadline; uint16 poolShareBps; uint16 launchFeeBps; address gateToken; uint256 gateAmount; uint256 tokensPerSeat; bool launched; address token; address pair; }",
  "struct CallZRoomStanding { bool admitted; bool banned; uint256 seat; bool claimed; uint256 owed; bool meetsGate; }",
  "function info() view returns (CallZRoomInfo)",
  "function standingOf(address wallet) view returns (CallZRoomStanding)",
  "function claimableOf(address account) view returns (uint256)",
  "function refundableOf(address account) view returns (uint256)",
  "function refundAvailable() view returns (bool)",
  "function admit(address[] wallets)",
  "function revoke(address[] wallets)",
  "function setBanned(address wallet, bool banned_)",
  "function kick(address wallet)",
  "function withdraw()",
  "function mint() payable",
  "function refund()",
  "function launch()",
  "function claim()",
]);
/** Every way a room, or the factory creating one, refuses a transaction. */
const errorAbi = parseAbi([
  "error InvalidConfig()",
  "error NotCreator()",
  "error SaleClosed()",
  "error TooManyWallets()",
  "error Banned(address wallet)",
  "error GateNotMet(address wallet, uint256 held, uint256 required)",
  "error NotAdmitted()",
  "error AlreadyMember()",
  "error NotMember(address wallet)",
  "error RoomFull()",
  "error RoomNotFull(uint256 seated, uint256 seats)",
  "error WrongPayment(uint256 sent, uint256 required)",
  "error LaunchInProgress()",
  "error NoLiquidityMinted()",
  "error NotLaunched()",
  "error AlreadyLaunched()",
  "error AlreadyClaimed(uint256 tokenId)",
  "error RefundUnavailable()",
  "error NothingOwed()",
  "error EthTransferFailed()",
  "error Soulbound()",
  "error DeploymentFailed()",
  "error SaltUsed()",
]);
const tokenAbi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
]);

// VITE_BSC_RPC_URL points the pages at another endpoint: a private one, or a local fork in the tests.
const client = createPublicClient({ chain: bsc, transport: http(import.meta.env.VITE_BSC_RPC_URL ?? SITE.rpcUrl), batch: { multicall: true } });

export type RoomsRoute = { name: "rooms" } | { name: "room-create" } | { name: "launched" } | { name: "room"; address: string };

const RISK = "These contracts are new and have not been audited. Use only what you can afford to lose.";

// ─────────────────────────────────────────────────────────────────────────────
// What the API answers (apps/worker/src/rooms.ts)
// ─────────────────────────────────────────────────────────────────────────────

interface ApiGate {
  token: string;
  /** Base units, as a decimal string. */
  amount: string | null;
  symbol: string | null;
  decimals: number | null;
}

interface ApiRoom {
  address: string;
  creator: string;
  creatorName: string | null;
  creatorClan: string | null;
  name: string;
  symbol: string;
  /** The hash of the room's picture when this site keeps it. */
  picture: string | null;
  about: string;
  wantPost: boolean;
  postBrief: string;
  /** Words the post must contain, checked with X. Empty or absent when the dev requires none. */
  postPhrase?: string;
  wantRole: boolean;
  roleBrief: string;
  gate: ApiGate | null;
  /** Wei, as a decimal string. */
  seatPrice: string;
  seats: number;
  seated: number;
  /** Unix seconds. */
  saleDeadline: number;
  poolShareBps: number;
  launchFeeBps: number;
  launched: boolean;
  token: string | null;
  pair: string | null;
  createdAt: number;
  syncedAt: number;
  /** Applications waiting for the dev. */
  applicants: number;
}

interface ApiMember {
  wallet: string;
  name: string | null;
  clan: string | null;
  seat: number;
  joinedAt: number;
  /** Points the dev gave this member in this room. */
  points: number;
  tag: string | null;
  muted: boolean;
}

/** A room as the list gives it. */
interface ListedRoom extends ApiRoom {
  /** Applications in the last 24 hours, plus two for every pass first seen in them. A score, not a count. */
  hot?: number;
  /** What the wallet the list was asked for is in this room. Only there when a wallet was given. */
  role?: "dev" | "member";
}

interface RoomList {
  rooms: ListedRoom[];
  sort?: string;
  page?: number;
  /** The most rooms one page holds. */
  pageSize?: number;
  /** Every room that matches, on all pages. */
  total?: number;
}

interface RoomDetail {
  room: ApiRoom;
  members: ApiMember[];
}

interface ApiStanding {
  admitted: boolean;
  banned: boolean;
  seat: number;
}

interface Application {
  wallet: string;
  name: string | null;
  clan: string | null;
  postUrl: string | null;
  postHandle: string | null;
  /** 'ok' | 'missing' | 'nocode' | 'unreachable', or null when the room asked for no post. */
  postState: string | null;
  role: string | null;
  portfolio: string | null;
  /** Base units of the required token, as a decimal string. */
  held: string | null;
  /** 'ok' | 'short' | 'unreadable', or null when the room requires no token. */
  holdState: string | null;
  checkedAt: number | null;
  /** 'pending' | 'declined'. */
  status: string;
  createdAt: number;
  updatedAt: number;
  standing: ApiStanding | null;
}

interface MyApplication {
  code: string;
  application: Application | null;
}

interface RoomMessage {
  id: number;
  /** Lowercase address of the wallet that posted. */
  author: string;
  authorName?: string | null;
  authorClan?: string | null;
  body: string;
  /** The hash of a picture posted to this room. */
  picture?: string | null;
  /** Unix seconds, by the server's clock. */
  createdAt: number;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function isRoomList(value: unknown): value is RoomList {
  return (
    isObject(value) && Array.isArray(value.rooms) &&
    value.rooms.every(
      (room) =>
        isObject(room) && typeof room.address === "string" && typeof room.creator === "string" &&
        (room.hot === undefined || isCount(room.hot)) && (room.role === undefined || room.role === "dev" || room.role === "member"),
    ) &&
    (value.total === undefined || isCount(value.total)) && (value.page === undefined || isCount(value.page)) &&
    (value.pageSize === undefined || (isCount(value.pageSize) && value.pageSize > 0))
  );
}

function isRoomDetail(value: unknown): value is RoomDetail {
  return (
    isObject(value) && isObject(value.room) && typeof value.room.address === "string" && typeof value.room.creator === "string" &&
    Array.isArray(value.members) && value.members.every((member) => isObject(member) && typeof member.wallet === "string")
  );
}

function isApplication(value: unknown): value is Application {
  return isObject(value) && typeof value.wallet === "string" && typeof value.status === "string";
}

function isMyApplication(value: unknown): value is MyApplication {
  return isObject(value) && typeof value.code === "string" && (value.application === null || isApplication(value.application));
}

function isApplicationList(value: unknown): value is { applications: Application[] } {
  return isObject(value) && Array.isArray(value.applications) && value.applications.every(isApplication);
}

function isMessage(value: unknown): value is RoomMessage {
  if (!isObject(value)) return false;
  const { id, author, authorName, authorClan, body, picture, createdAt } = value;
  return (
    Number.isSafeInteger(id) && typeof author === "string" && typeof body === "string" && Number.isSafeInteger(createdAt) &&
    (authorName === undefined || authorName === null || typeof authorName === "string") &&
    (authorClan === undefined || authorClan === null || typeof authorClan === "string") &&
    (picture === undefined || picture === null || typeof picture === "string")
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Text and numbers
// ─────────────────────────────────────────────────────────────────────────────

/** Control characters, zero-width and text-direction marks, and unpaired surrogates: never part of a label. */
const REMOVED = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩\uD800-\uDFFF]/gu;

/** A string read from a contract as one clean line. */
const cleanLine = (raw: string): string => raw.replace(REMOVED, "").trim();

const bytesOf = (text: string): number => new TextEncoder().encode(text).length;
/** Characters as the API counts them. */
const lengthOf = (text: string): number => [...text].length;

/** A whole number the API or the chain gave, as a bigint. Null for anything else. */
function toBig(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^\d{1,78}$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return null;
}

/** An amount of BNB, exact to the wei. */
const bnb = (wei: bigint): string => `${formatEther(wei)} BNB`;

/** A base-unit amount in whole tokens with thousands separators. Exact unless `places` cuts it short; never rounded up. */
function units(value: bigint, decimals: number, places = decimals): string {
  const [whole = "0", fraction = ""] = formatUnits(value, decimals).split(".");
  const cut = fraction.slice(0, places).replace(/0+$/, "");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${cut ? `.${cut}` : ""}`;
}

/** When a moment is, from now: "in 3h", or "passed 2d ago". */
function until(timestamp: number, now: number): string {
  const seconds = timestamp - Math.floor(now / 1000);
  if (seconds <= 0) return `passed ${ago(timestamp, now)}`;
  if (seconds < 60) return `in ${seconds}s`;
  if (seconds < 3600) return `in ${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `in ${Math.floor(seconds / 3600)}h`;
  return `in ${Math.floor(seconds / 86_400)}d`;
}

/** What a thrown value says, for the person looking at the page. The API's own sentence when it gave one. */
function messageOf(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : "That did not go through. Try again.";
}

const plural = (count: number | bigint, one: string, many: string): string => `${count.toString()} ${BigInt(count) === 1n ? one : many}`;

/** The hash of a room picture this site keeps, from the address a room's contract holds. Null for any other address. */
const ownPicture = (image: string): string | null => OWN_PICTURE.exec(image)?.[1] ?? null;

/** The current time, read again every `everyMs`: enough for "in 3h" and "2m ago". */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(timer);
  }, [everyMs]);
  return now;
}

/** Text with its http and https addresses made into links. Everything else stays the text it was. */
const LINK = /https?:\/\/[^\s<>"'`]+/gi;

function linkParts(text: string): Array<{ text: string; href: string | null }> {
  const parts: Array<{ text: string; href: string | null }> = [];
  let from = 0;
  for (const match of text.matchAll(LINK)) {
    // Punctuation that ends the sentence is not part of the address.
    const found = match[0].replace(/[.,!?;:)\]}]+$/, "");
    const start = match.index ?? 0;
    let href: string | null = null;
    try {
      const url = new URL(found);
      // An address carrying a user name ("https://bank.com@elsewhere") is how a link lies about where it goes.
      if ((url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "") href = url.href;
    } catch {
      href = null;
    }
    if (href === null) continue;
    if (start > from) parts.push({ text: text.slice(from, start), href: null });
    parts.push({ text: found, href });
    from = start + found.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), href: null });
  return parts;
}

function Linked({ text }: { text: string }) {
  return (
    <>
      {linkParts(text).map((part, index) => (
        <Fragment key={index}>
          {part.href === null ? part.text : <a href={part.href} target="_blank" rel="noopener noreferrer nofollow">{part.text}</a>}
        </Fragment>
      ))}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading: the chain and the API
// ─────────────────────────────────────────────────────────────────────────────

type Loaded<T> = { state: "loading" } | { state: "error" } | { state: "ready"; data: T };

/** Reads `load` now and again every `refreshMs`, keeping the last good answer through a failed refresh. */
function useChain<T>(load: () => Promise<T>, refreshMs: number): Loaded<T> & { reload(): void } {
  const [result, setResult] = useState<Loaded<T>>({ state: "loading" });
  const reload = useCallback(() => {
    load().then(
      (data) => setResult({ state: "ready", data }),
      () => setResult((previous) => (previous.state === "ready" ? previous : { state: "error" })),
    );
  }, [load]);
  useEffect(() => {
    setResult({ state: "loading" });
    reload();
    const timer = window.setInterval(reload, refreshMs);
    return () => window.clearInterval(timer);
  }, [reload, refreshMs]);
  return { ...result, reload };
}

type Asked<T> = { state: "loading"; data: null; error: null } | { state: "ready"; data: T; error: null } | { state: "error"; data: null; error: ApiError };

const ASKING = { state: "loading", data: null, error: null } as const;

/**
 * Asks the API for `path` now, every `refreshMs` while the page is in view, and whenever `tick` changes.
 * A failed refresh keeps the last good answer, except when the API refuses (401, 403, 404): what the visitor
 * may no longer see leaves the page. An answer that does not have the expected shape counts as unreachable.
 */
function useApi<T>(path: string | null, refreshMs: number, guard: (value: unknown) => value is T, tick = 0): Asked<T> & { reload(): void; set(data: T): void } {
  const [result, setResult] = useState<Asked<T>>(ASKING);
  /** Counts requests, so an answer that arrives after a newer one, or for another path, is dropped. */
  const turn = useRef(0);
  const reload = useCallback(() => {
    if (path === null) return;
    const mine = ++turn.current;
    api<unknown>(path).then(
      (data) => {
        if (mine !== turn.current) return;
        if (guard(data)) setResult({ state: "ready", data, error: null });
        else setResult((previous) => (previous.state === "ready" ? previous : { state: "error", data: null, error: new ApiError("The site answered something unexpected. Try again.", 0) }));
      },
      (cause: unknown) => {
        if (mine !== turn.current) return;
        const error = cause instanceof ApiError ? cause : new ApiError("The site could not be reached. Check your connection and try again.", 0);
        const refused = error.status === 401 || error.status === 403 || error.status === 404;
        setResult((previous) => (previous.state === "ready" && !refused ? previous : { state: "error", data: null, error }));
      },
    );
  }, [path, guard]);
  useEffect(() => {
    setResult(ASKING);
    reload();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, refreshMs);
    return () => {
      turn.current++;
      window.clearInterval(timer);
    };
  }, [reload, refreshMs]);
  const seen = useRef(tick);
  useEffect(() => {
    if (seen.current === tick) return;
    seen.current = tick;
    reload();
  }, [tick, reload]);
  const set = useCallback((data: T) => {
    turn.current++;
    setResult({ state: "ready", data, error: null });
  }, []);
  return { ...result, reload, set };
}

/** Whether the room factory is on BNB Chain, and the launch fee a room created now carries. */
async function readFactory(): Promise<{ deployed: boolean; launchFeeBps: number }> {
  const code = await client.getCode({ address: FACTORY });
  const deployed = !!code && code !== "0x";
  // The fee is fixed into a room when it is created, so the form shows the factory's own value.
  const launchFeeBps = deployed ? await client.readContract({ address: FACTORY, abi: factoryAbi, functionName: "launchFeeBps" }) : deployment.launchFeeBps;
  return { deployed, launchFeeBps };
}

type TokenLabel = { state: "none" | "loading" | "error" | "nocode" | "nottoken" } | { state: "ready"; symbol: string | null; decimals: number };

/** Tokens already read: a token's symbol and decimals do not change. */
const tokenLabels = new Map<string, Extract<TokenLabel, { state: "ready" }>>();

/** A token's symbol and decimals from the token itself, and whether it is a token a room can require at all. */
async function readToken(token: Address): Promise<TokenLabel> {
  const known = tokenLabels.get(token.toLowerCase());
  if (known) return known;
  const code = await client.getCode({ address: token });
  if (!code || code === "0x") return { state: "nocode" };
  const at = { address: token, abi: tokenAbi } as const;
  const [symbol, decimals, balance] = await client.multicall({
    allowFailure: true,
    contracts: [
      { ...at, functionName: "symbol" },
      { ...at, functionName: "decimals" },
      // The room's contract asks the token exactly this about every wallet it lets in.
      { ...at, functionName: "balanceOf", args: [DEAD] },
    ],
  });
  if (decimals.status !== "success" || balance.status !== "success") return { state: "nottoken" };
  const label = { state: "ready" as const, symbol: symbol.status === "success" ? cleanLine(symbol.result).slice(0, 32) || null : null, decimals: decimals.result };
  tokenLabels.set(token.toLowerCase(), label);
  return label;
}

function useToken(token: Address | null): TokenLabel {
  const [label, setLabel] = useState<TokenLabel>({ state: token ? "loading" : "none" });
  useEffect(() => {
    if (!token) {
      setLabel({ state: "none" });
      return;
    }
    let current = true;
    let retry = 0;
    setLabel(tokenLabels.get(token.toLowerCase()) ?? { state: "loading" });
    const read = () => {
      readToken(token).then(
        (next) => current && setLabel(next),
        () => {
          if (!current) return;
          // The chain could not be reached: said on the page, and asked again shortly.
          setLabel({ state: "error" });
          retry = window.setTimeout(read, 5000);
        },
      );
    };
    read();
    return () => {
      current = false;
      window.clearTimeout(retry);
    };
  }, [token]);
  return label;
}

/** What `account` holds of `token` right now, read from the token and read again every 15 seconds. Null until it answers. */
function useHeld(token: Address | null, account: Address | null): bigint | null {
  const [held, setHeld] = useState<bigint | null>(null);
  useEffect(() => {
    setHeld(null);
    if (!token || !account) return;
    let current = true;
    const read = () => {
      client.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [account] }).then(
        (value) => current && setHeld(value),
        // The reading already on the page stands until the next try.
        () => undefined,
      );
    };
    read();
    const timer = window.setInterval(read, 15_000);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [token, account]);
  return held;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transactions
// ─────────────────────────────────────────────────────────────────────────────

/** The revert data an error carries, wherever in its chain of causes the node's answer sits. */
function revertData(cause: unknown): Hex | null {
  if (!isObject(cause)) return null;
  const held = cause.data;
  const data = typeof held === "string" ? held : isObject(held) && typeof held.data === "string" ? held.data : null;
  return data !== null && /^0x[0-9a-fA-F]{8,}$/.test(data) ? (data as Hex) : null;
}

/** Why a room or the factory refused, in the words of what it checks. Null when the error is not one of theirs. */
function refusal(error: unknown): string | null {
  if (!(error instanceof BaseError)) return null;
  const data = revertData(error.walk((cause) => revertData(cause) !== null));
  if (data === null) return null;
  try {
    const decoded = decodeErrorResult({ abi: errorAbi, data });
    switch (decoded.errorName) {
      case "InvalidConfig":
        return "The room's contract does not accept these settings.";
      case "NotCreator":
        return "Only the room's dev can do that.";
      case "SaleClosed":
        return "The room is closed: it has launched or its deadline has passed.";
      case "TooManyWallets":
        return "At most 100 wallets can be let in with one transaction.";
      case "Banned":
        return `${short(decoded.args[0])} is barred from this room. The dev has to lift the bar first.`;
      case "GateNotMet":
        return `The room's contract refuses ${short(decoded.args[0])}: it does not hold enough of the token this room requires.`;
      case "NotAdmitted":
        return "The dev has not let this wallet in.";
      case "AlreadyMember":
        return "That wallet already holds a pass of this room.";
      case "NotMember":
        return `${short(decoded.args[0])} does not hold a pass of this room.`;
      case "RoomFull":
        return "Every seat is taken.";
      case "RoomNotFull":
        return `${decoded.args[0].toString()} of ${decoded.args[1].toString()} seats are taken. The room launches only when every seat is.`;
      case "WrongPayment":
        return `A pass costs exactly ${bnb(decoded.args[1])}.`;
      case "LaunchInProgress":
        return "The room is launching right now. Try again in a moment.";
      case "NoLiquidityMinted":
        return "PancakeSwap minted no liquidity for this launch, so the launch was not made.";
      case "NotLaunched":
        return "The room has not launched yet.";
      case "AlreadyLaunched":
        return "The room has already launched.";
      case "AlreadyClaimed":
        return `Pass #${decoded.args[0].toString()} has already claimed its tokens.`;
      case "RefundUnavailable":
        return "A pass can be handed back only after the deadline, in a room that has not launched.";
      case "NothingOwed":
        return "This room owes this wallet nothing.";
      case "EthTransferFailed":
        return "The BNB could not be delivered to this wallet.";
      case "Soulbound":
        return "A pass is its holder's seat and cannot be transferred.";
      case "SaltUsed":
      case "DeploymentFailed":
        return "A room already exists at that address. Try again.";
    }
  } catch {
    return null;
  }
  return null;
}

/** What went wrong with a transaction, in words for the person who sent it. */
function explain(error: unknown): string {
  const code = (error as { code?: number })?.code ?? ((error as BaseError)?.walk?.() as { code?: number } | undefined)?.code;
  const text = error instanceof BaseError ? error.shortMessage : String((error as { message?: string })?.message ?? error);
  if (code === 4001 || /user (rejected|denied)|rejected the request/i.test(text)) return "You cancelled the request in your wallet. Nothing was sent.";
  const refused = refusal(error);
  if (refused) return `${refused} Nothing was sent.`;
  if (/insufficient funds|exceeds (the )?balance/i.test(text)) return "Your balance does not cover this amount plus the network fee. Nothing was sent.";
  return `${text.replace(/\s+/g, " ").slice(0, 220)} Nothing was sent.`;
}

interface TxState {
  kind: "idle" | "working" | "done" | "error";
  text?: string;
  hash?: Hex;
}

/** BNB Chain's limit on one transaction's gas. */
const GAS_CAP = 16_777_216n;

interface Call {
  to: Address;
  data: Hex;
  value?: bigint;
}

/**
 * Simulates, signs and follows one transaction. A transaction the chain would reject is never sent.
 * Resolves with the receipt, or null when it did not go through.
 */
function useTransaction() {
  const [tx, setTx] = useState<TxState>({ kind: "idle" });
  const send = useCallback(async (label: string, call: Call, account: Address) => {
    setTx({ kind: "working", text: `${label}: checking on BNB Chain…` });
    try {
      const signer = createWalletClient({ chain: bsc, transport: custom(window.ethereum!) });
      await client.call({ account, ...call });
      // A quarter more gas than the estimate, within the chain's limit: what is not used is not paid for.
      const estimate = await client.estimateGas({ account, ...call });
      const gas = (estimate * 5n) / 4n > GAS_CAP ? GAS_CAP : (estimate * 5n) / 4n;
      setTx({ kind: "working", text: `${label}: confirm in your wallet…` });
      const hash = await signer.sendTransaction({ account, ...call, gas });
      setTx({ kind: "working", text: `${label}: waiting for confirmation…`, hash });
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (receipt.status !== "success") {
        setTx({ kind: "error", text: `${label} reverted. Only the network fee was spent.`, hash });
        return null;
      }
      setTx({ kind: "done", text: `${label} confirmed.`, hash });
      return receipt;
    } catch (error) {
      setTx({ kind: "error", text: explain(error) });
      return null;
    }
  }, []);
  return { tx, send };
}

function TxNote({ tx }: { tx: TxState }) {
  if (tx.kind === "idle") return null;
  return (
    <p className={`trade-outcome trade-${tx.kind === "done" ? "done" : tx.kind === "error" ? "error" : "working"}`} role={tx.kind === "error" ? "alert" : "status"}>
      {tx.text} {tx.hash && <a href={`${SITE.explorer}/tx/${tx.hash}`} target="_blank" rel="noreferrer">View transaction ↗</a>}
    </p>
  );
}

/** One of a room's own functions, sent by `account`. `act` resolves true once the transaction is confirmed and the page has read the room again. */
function useRoomAction(room: Address, account: Address | null, onDone: () => Promise<void>) {
  const { tx, send } = useTransaction();
  const act = useCallback(
    async (label: string, data: Hex, value?: bigint): Promise<boolean> => {
      if (!account) return false;
      const receipt = await send(label, { to: room, data, ...(value !== undefined ? { value } : {}) }, account);
      if (!receipt) return false;
      await onDone();
      return true;
    },
    [room, account, send, onDone],
  );
  return { tx, act, working: tx.kind === "working" };
}

/** The button a page needs before it can send anything: connect, then be on BNB Chain. Null when ready. */
function WalletGate(): ReactNode {
  const wallet = useWallet();
  if (!wallet.available) return <p className="trade-note">No browser wallet found. Install MetaMask, Rabby or another wallet to use Cook Rooms.</p>;
  if (!wallet.account) return <button type="button" className="button" onClick={connect}>Connect wallet</button>;
  if (wallet.chainId !== SITE.id) return <button type="button" className="button button-warn" onClick={() => void switchChain(SITE).catch(() => undefined)}>Switch to BNB Chain</button>;
  return null;
}

/** Signs the connected wallet in. Signing is a message, not a transaction: it costs nothing. */
function SignInButton({ account, label, testId }: { account: Address; label: string; testId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await signIn(account);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="actions">
        <button type="button" className="button" data-testid={testId} disabled={busy} onClick={() => void go()}>{busy ? "Confirm in your wallet…" : label}</button>
      </div>
      {error && <p className="chat-error" role="alert">{error}</p>}
    </>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="stat-label">{label}</span>
      {children}
      {hint && <span className="dim field-hint">{hint}</span>}
    </label>
  );
}

/** What an action on this site's API came to: said under the button that started it. */
type Said = { kind: "done" | "error"; text: string } | null;

function SaidNote({ said, testId }: { said: Said; testId?: string }) {
  if (!said) return null;
  return <p className={`trade-outcome trade-${said.kind}`} role={said.kind === "error" ? "alert" : "status"} data-testid={testId}>{said.text}</p>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pictures
// ─────────────────────────────────────────────────────────────────────────────

const PICTURE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const PICTURE_ACCEPT = PICTURE_TYPES.join(",");

function encodeCanvas(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}

async function decodePicture(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      // Some browsers decode through an <img> what they refuse here.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => undefined };
  } catch {
    throw new Error("That file could not be read as a picture.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * A picture ready to send: redrawn in the browser at no more than `maxSide` pixels on its long side and
 * written again as WebP (JPEG where the browser cannot write WebP), so it is under the size limit and carries
 * none of what a camera writes into a file. An animated GIF cannot be redrawn without stopping it, so a GIF
 * goes as it is when it is small enough and is refused otherwise.
 */
async function preparePicture(file: File, maxSide: number): Promise<Blob> {
  if (!PICTURE_TYPES.includes(file.type)) throw new Error("The picture must be a PNG, JPEG, WebP or GIF.");
  if (file.type === "image/gif") {
    if (file.size > MAX_PICTURE_BYTES) throw new Error(`A GIF is sent as it is, and this one is ${(file.size / 1_000_000).toFixed(1)} MB. The most is ${MAX_PICTURE_BYTES / 1_000_000} MB.`);
    return file;
  }
  const picture = await decodePicture(file);
  try {
    if (picture.width === 0 || picture.height === 0) throw new Error("That file could not be read as a picture.");
    let scale = Math.min(1, maxSide / Math.max(picture.width, picture.height));
    for (let round = 0; round < 6; round++) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(picture.width * scale));
      canvas.height = Math.max(1, Math.round(picture.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("This browser could not redraw the picture.");
      for (const type of ["image/webp", "image/jpeg"]) {
        context.clearRect(0, 0, canvas.width, canvas.height);
        if (type === "image/jpeg") {
          // JPEG has no transparency: what was see-through takes the page's own background.
          context.fillStyle = "#0b0e11";
          context.fillRect(0, 0, canvas.width, canvas.height);
        }
        context.drawImage(picture.source, 0, 0, canvas.width, canvas.height);
        for (const quality of [0.9, 0.8, 0.65, 0.5]) {
          const blob = await encodeCanvas(canvas, type, quality);
          // A browser that cannot write this format answers with another one: on to the next format.
          if (!blob || blob.type !== type) break;
          if (blob.size <= MAX_PICTURE_BYTES) return blob;
        }
      }
      scale *= 0.75;
    }
    throw new Error("The picture could not be made small enough to send. Pick a smaller one.");
  } finally {
    picture.close();
  }
}

/** A picture picked on this device, ready to send, with an address to preview it by. */
interface PickedPicture {
  blob: Blob;
  url: string;
}

/** Holds one picked picture and lets go of its preview address when it is replaced or the page moves on. */
function usePickedPicture(maxSide: number) {
  const [picked, setPicked] = useState<PickedPicture | null>(null);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  useEffect(() => {
    if (!picked) return;
    return () => URL.revokeObjectURL(picked.url);
  }, [picked]);
  const pick = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // The same file can be picked again after it was removed.
      event.target.value = "";
      if (!file) return;
      setState({ busy: true, error: null });
      try {
        const blob = await preparePicture(file, maxSide);
        setPicked({ blob, url: URL.createObjectURL(blob) });
        setState({ busy: false, error: null });
      } catch (cause) {
        setState({ busy: false, error: messageOf(cause) });
      }
    },
    [maxSide],
  );
  const clear = useCallback(() => {
    setPicked(null);
    setState({ busy: false, error: null });
  }, []);
  return { picked, busy: state.busy, error: state.error, pick, clear };
}

/** A room's picture, or a drawn stand-in carrying the first letters of its symbol. */
function RoomArt({ picture, symbol, large }: { picture: string | null; symbol: string; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  const letters = [...symbol.trim()].slice(0, 3).join("").toUpperCase() || "?";
  const shown = picture !== null && HASH.test(picture) && !failed;
  return (
    <span className="room-art" data-large={large ? "true" : undefined} data-drawn={shown ? undefined : "true"}>
      {shown ? <img src={`/api/rooms/image/${picture}`} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} /> : <span aria-hidden="true">{letters}</span>}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Status and requirements
// ─────────────────────────────────────────────────────────────────────────────

interface RoomStatus {
  key: "launched" | "closed" | "full" | "open";
  label: string;
  tone: "good" | "gold" | "muted" | "warn";
}

/** `closed`: the deadline has passed without a launch. */
function statusOf({ launched, closed, full }: { launched: boolean; closed: boolean; full: boolean }): RoomStatus {
  if (launched) return { key: "launched", label: "Launched", tone: "good" };
  if (closed) return { key: "closed", label: "Closed", tone: "muted" };
  if (full) return { key: "full", label: "Full", tone: "warn" };
  return { key: "open", label: "Open", tone: "gold" };
}

/** The holding requirement as the API has it, in a few words: "Hold 1,000 CAKE". */
function gateChip(gate: ApiGate): string {
  const amount = toBig(gate.amount);
  const symbol = (typeof gate.symbol === "string" && gate.symbol) || short(String(gate.token));
  // Without the token's decimals an amount in base units would only mislead.
  if (amount === null || typeof gate.decimals !== "number") return `Hold ${symbol}`;
  return `Hold ${units(amount, gate.decimals)} ${symbol}`;
}

const POST_WORDS: Record<string, string> = {
  ok: "The post is up and carries the code.",
  missing: "X says there is no such post: it may be deleted, or from an account that is not public.",
  nocode: "The post is up but does not carry the code, or the words the dev requires.",
  unreachable: "X could not be asked, so the post was not read.",
};
const HOLD_WORDS: Record<string, string> = {
  ok: "Holds enough.",
  short: "Does not hold enough.",
  unreadable: "The holdings could not be read from BNB Chain.",
};

// ─────────────────────────────────────────────────────────────────────────────
// #/rooms: the list
// ─────────────────────────────────────────────────────────────────────────────

/** The longest search the API takes, in characters. */
const MAX_SEARCH_LENGTH = 64;
/** How long the search box waits after the last key before it asks. */
const SEARCH_DELAY_MS = 300;
/** How many of a wallet's own rooms show before "Show all". */
const COOKS_SHOWN = 3;
/** How long a room counts as new, and how far back "hot" looks. */
const DAY_SECONDS = 86_400;
const HOT_MEANS = "Hot: most applications and passes bought in the last 24 hours.";

type RoomSort = "latest" | "hot";

/** How many rooms match in all. A list without a count has only the rooms it carries. */
const totalOf = (list: RoomList): number => Math.max(list.total ?? 0, list.rooms.length);

/**
 * The connected wallet's own rooms, newest first: the ones it opened and the ones it holds a pass in. The API
 * gives them 100 to a page; the first page is kept fresh, and "Load more" adds the pages after it.
 */
function YourCooks({ account, now }: { account: Address; now: number }) {
  const base = `/api/rooms?wallet=${account.toLowerCase()}`;
  const first = useApi(base, 15_000, isRoomList);
  const [expanded, setExpanded] = useState(false);
  const [later, setLater] = useState<{ rooms: ListedRoom[]; pages: number }>({ rooms: [], pages: 1 });
  const [more, setMore] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });

  const cooks = useMemo(() => {
    if (first.state !== "ready") return [];
    // A room opened since a later page was read moves every room down one: none is shown twice.
    const seen = new Set<string>();
    return [...first.data.rooms, ...later.rooms].filter((room) => {
      const address = room.address.toLowerCase();
      if (seen.has(address)) return false;
      seen.add(address);
      return true;
    });
  }, [first.state, first.data, later.rooms]);

  const loadMore = async () => {
    if (more.busy) return;
    setMore({ busy: true, error: null });
    try {
      const next: unknown = await api<unknown>(`${base}&page=${later.pages + 1}`);
      if (!isRoomList(next)) throw new Error("The site answered something unexpected. Try again.");
      setLater((previous) => ({ rooms: [...previous.rooms, ...next.rooms], pages: previous.pages + 1 }));
      setMore({ busy: false, error: null });
    } catch (cause) {
      setMore({ busy: false, error: messageOf(cause) });
    }
  };

  const total = first.state === "ready" ? Math.max(totalOf(first.data), cooks.length) : 0;
  const pageSize = first.state === "ready" ? first.data.pageSize ?? 0 : 0;
  // More to fetch: the API said how many there are and how many a page holds, and the pages read do not reach it.
  const unread = pageSize > 0 && later.pages * pageSize < total;
  const shown = expanded ? cooks : cooks.slice(0, COOKS_SHOWN);
  return (
    <section data-testid="your-cooks" aria-label="Your cooks">
      <div className="section-head">
        <h2>Your cooks {first.state === "ready" && <span className="dim">{total}</span>}</h2>
      </div>
      {first.state === "loading" && <p className="note" role="status">Loading your cooks…</p>}
      {first.state === "error" && <p className="note" role="alert">{first.error.message}</p>}
      {first.state === "ready" && cooks.length === 0 && (
        <p className="note" data-testid="your-cooks-empty">You have no cooks yet. Open a Cook Room or apply to one.</p>
      )}
      {shown.length > 0 && (
        <ul className="cards grid" data-testid="your-cooks-list">
          {shown.map((room) => <li key={room.address}><RoomCard room={room} now={now} /></li>)}
        </ul>
      )}
      {total > COOKS_SHOWN && (
        <div className="actions rooms-more">
          <button type="button" className="button button-quiet" data-testid="your-cooks-toggle" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
            {expanded ? `Show the latest ${COOKS_SHOWN}` : `Show all ${total}`}
          </button>
          {expanded && unread && (
            <button type="button" className="button button-quiet" data-testid="your-cooks-more" disabled={more.busy} onClick={() => void loadMore()}>
              {more.busy ? "Loading…" : `Load more (${cooks.length} of ${total} shown)`}
            </button>
          )}
        </div>
      )}
      {more.error !== null && <p className="note" role="alert">{more.error}</p>}
    </section>
  );
}

function RoomsHome() {
  const wallet = useWallet();
  const factory = useChain(readFactory, 30_000);
  /** What is in the search box, and what the list was last asked for: the box is ahead by a short wait. */
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<RoomSort>("latest");
  const [page, setPage] = useState(1);
  const path = useMemo(() => {
    const params = new URLSearchParams();
    if (query !== "") params.set("q", query);
    if (sort !== "latest") params.set("sort", sort);
    if (page > 1) params.set("page", String(page));
    const asked = params.toString();
    return asked === "" ? "/api/rooms" : `/api/rooms?${asked}`;
  }, [query, sort, page]);
  const list = useApi(path, 15_000, isRoomList);
  const { tx, send } = useTransaction();
  const gate = WalletGate();
  const now = useNow(30_000);
  const deployed = factory.state === "ready" && factory.data.deployed;

  /** What the list is searched for. A new search starts at its first page. */
  const asked = useRef("");
  const search = useCallback((text: string) => {
    const next = [...cleanLine(text)].slice(0, MAX_SEARCH_LENGTH).join("");
    if (next === asked.current) return;
    asked.current = next;
    setQuery(next);
    setPage(1);
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => search(draft), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [draft, search]);
  const clearSearch = () => {
    setDraft("");
    search("");
  };
  const pick = (next: RoomSort) => {
    if (next === sort) return;
    setSort(next);
    setPage(1);
  };

  const deploy = async () => {
    if (!wallet.account) return;
    // The salt and the creation code, to the deterministic CREATE2 deployer: the factory lands at the same
    // address whoever sends this.
    await send("Deploying the Cook Room factory", { to: deployment.deployer as Address, data: `${deployment.factory.salt}${deployment.factory.initCode.slice(2)}` as Hex }, wallet.account);
    factory.reload();
  };

  const rooms = list.state === "ready" ? list.data.rooms : [];
  const total = list.state === "ready" ? totalOf(list.data) : 0;
  const pageSize = list.state === "ready" ? list.data.pageSize ?? 0 : 0;
  const pages = pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  // A page asked for past the last one leads back to the last one.
  useEffect(() => {
    if (list.state === "ready" && page > pages) setPage(pages);
  }, [list.state, page, pages]);
  return (
    <div className="rooms-page">
      <div className="page-head">
        <h1 className="page-title">Cook Rooms</h1>
        <p className="lede">
          This is how a token is launched on CallZ. A dev opens a Cook Room and picks who gets in; each member buys one pass at the same
          flat price and joins the room's private chat. When every pass is sold the dev launches the token, and every pass claims an
          equal share of it.
        </p>
        <p className="links">
          <a href="#/launched">Launches</a>
          <a href="#/leaderboard">Leaderboard</a>
          <a href="#/clans">Clans</a>
          <a href="#/launch" data-testid="rooms-earlier-mints">Mints from before Cook Rooms</a>
        </p>
        {deployed && <div className="actions"><a className="button" href="#/rooms/create" data-testid="room-create-link">Open a Cook Room</a></div>}
      </div>
      {wallet.account && <YourCooks key={wallet.account} account={wallet.account} now={now} />}
      <p className="note note-warn" data-testid="rooms-risk">{RISK}</p>

      {factory.state === "error" && <p className="note" role="alert">BNB Chain could not be reached. Reload to try again.</p>}
      {factory.state === "ready" && !factory.data.deployed && (
        <section className="note" data-testid="room-factory-not-deployed">
          <h2>The Cook Room factory is not on BNB Chain yet</h2>
          <p>
            It is one transaction from any wallet, paid in BNB network fees only, and it lands at a fixed address, <code>{FACTORY}</code>.
            Whoever sends it gets no rights over the factory or over any room: the guardian, who can change the launch fee of rooms created
            later and nothing else, is <code>{deployment.guardian}</code> either way. Until the factory is there, Cook Rooms cannot be opened.
          </p>
          <div className="actions">{gate ?? <button type="button" className="button" data-testid="room-factory-deploy" disabled={tx.kind === "working"} onClick={() => void deploy()}>Deploy the Cook Room factory</button>}</div>
          <TxNote tx={tx} />
        </section>
      )}

      <section>
        <div className="section-head">
          <h2>Cook Rooms {list.state === "ready" && <span className="dim" data-testid="rooms-total">{total}</span>}</h2>
        </div>
        <div className="rooms-tools">
          <form
            className="rooms-search"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              search(draft);
            }}
          >
            <label className="field">
              <span className="visually-hidden">Search the Cook Rooms</span>
              <input
                type="search"
                name="q"
                data-testid="rooms-search"
                value={draft}
                maxLength={MAX_SEARCH_LENGTH}
                placeholder="Search by name, symbol, dev or address"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="search"
                onChange={(event) => setDraft(event.target.value)}
              />
            </label>
            {draft !== "" && <button type="button" className="button button-quiet" data-testid="rooms-search-clear" onClick={clearSearch}>Clear</button>}
          </form>
          <div className="seg" role="group" aria-label="Order of the Cook Rooms" data-testid="rooms-sort">
            <button type="button" aria-pressed={sort === "latest"} data-testid="rooms-sort-latest" title="Newest first" onClick={() => pick("latest")}>Latest</button>
            <button type="button" aria-pressed={sort === "hot"} data-testid="rooms-sort-hot" title={HOT_MEANS} onClick={() => pick("hot")}>Hot</button>
          </div>
        </div>
        {sort === "hot" && <p className="trade-note dim rooms-sort-note" data-testid="rooms-sort-note">{HOT_MEANS}</p>}
        {list.state === "loading" && <p className="note" role="status">Loading the Cook Rooms…</p>}
        {list.state === "error" && <p className="note" role="alert">{list.error.message}</p>}
        {list.state === "ready" && rooms.length === 0 && query === "" && (
          <p className="note" data-testid="rooms-empty">No Cook Rooms yet.{deployed ? " Open the first one." : ""}</p>
        )}
        {list.state === "ready" && rooms.length === 0 && query !== "" && (
          <div className="note" data-testid="rooms-search-empty">
            <p>No Cook Room matches “{query}”.</p>
            <div className="actions"><button type="button" className="button button-quiet" data-testid="rooms-search-empty-clear" onClick={clearSearch}>Clear the search</button></div>
          </div>
        )}
        {rooms.length > 0 && (
          <ul className="cards grid" data-testid="rooms-list">
            {rooms.map((room) => <li key={room.address}><RoomCard room={room} now={now} /></li>)}
          </ul>
        )}
        {list.state === "ready" && pageSize > 0 && total > pageSize && (
          <nav className="rooms-pager" aria-label="Pages of Cook Rooms" data-testid="rooms-pager">
            <button type="button" className="button button-quiet" data-testid="rooms-page-prev" disabled={page <= 1} onClick={() => setPage(Math.max(1, page - 1))}>Previous</button>
            <span className="num" data-testid="rooms-page" aria-live="polite">Page {Math.min(page, pages)} of {pages}</span>
            <button type="button" className="button button-quiet" data-testid="rooms-page-next" disabled={page >= pages} onClick={() => setPage(Math.min(pages, page + 1))}>Next</button>
          </nav>
        )}
      </section>
    </div>
  );
}

function RoomCard({ room, now }: { room: ListedRoom; now: number }) {
  const seats = Number(room.seats) || 0;
  const seated = Number(room.seated) || 0;
  const launched = room.launched === true;
  const status = statusOf({ launched, closed: Math.floor(now / 1000) >= Number(room.saleDeadline), full: seated >= seats });
  const price = toBig(room.seatPrice);
  const waiting = Number(room.applicants) || 0;
  const hot = isCount(room.hot) ? room.hot : 0;
  // `createdAt` is when CallZ first listed the room.
  const fresh = isCount(room.createdAt) && room.createdAt > Math.floor(now / 1000) - DAY_SECONDS;
  return (
    <a className="launch-card room-card" href={`#/room/${room.address.toLowerCase()}`} data-testid="room-card" data-room={room.address.toLowerCase()}>
      <span className="launch-head">
        <RoomArt picture={room.picture} symbol={String(room.symbol)} />
        <span className="launch-name">
          <strong>{String(room.name)}</strong>
          <span className="dim">{String(room.symbol)}</span>
        </span>
        <span className={`tag tag-${status.tone}`} data-testid="room-card-status" data-status={status.key}>{status.label}</span>
      </span>
      {(room.role !== undefined || hot > 0 || fresh) && (
        <span className="room-chips room-marks">
          {room.role !== undefined && <span className={`tag tag-${room.role === "dev" ? "gold" : "muted"}`} data-testid="room-card-role" data-role={room.role}>{room.role === "dev" ? "Dev" : "Member"}</span>}
          {hot > 0 && (
            <span className="tag tag-warn" data-testid="room-card-hot" title={`Activity score ${hot} in the last 24 hours: one for each application, two for each pass bought.`}>Hot</span>
          )}
          {fresh && <span className="tag tag-good" data-testid="room-card-new" title="Listed in the last 24 hours">New</span>}
        </span>
      )}
      <span className="room-card-line dim">Dev <AuthorName className="room-author" address={room.creator} name={room.creatorName} clan={room.creatorClan} /></span>
      <span className="room-card-line">
        <span className="num">{seated} / {seats} seats</span>
        <span className="num">{price === null ? "—" : `${bnb(price)} per pass`}</span>
      </span>
      {(room.wantPost || room.gate || room.wantRole) && (
        <span className="room-chips">
          {room.wantPost && <span className="tag tag-muted">Post on X</span>}
          {room.gate && <span className="tag tag-muted">{gateChip(room.gate)}</span>}
          {room.wantRole && <span className="tag tag-muted">Role + portfolio</span>}
        </span>
      )}
      {!launched && waiting > 0 && <span className="room-card-line dim">{plural(waiting, "applicant", "applicants")} waiting</span>}
    </a>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// #/launched: the projects that launched
// ─────────────────────────────────────────────────────────────────────────────

const mintFactoryAbi = parseAbi(["function mintCount() view returns (uint256)", "function mints(uint256 index) view returns (address)"]);
const mintAbi = parseAbi([
  "function tokenName() view returns (string)",
  "function tokenSymbol() view returns (string)",
  "function launched() view returns (bool)",
  "function token() view returns (address)",
]);
/** The most mints of one factory that are read: the newest ones. */
const EARLIER_MINTS = 100;

/** A token launched by one of CallZ's open pass mints, the way of launching there was before Cook Rooms. */
interface EarlierLaunch {
  mint: Address;
  token: Address;
  name: string;
  symbol: string;
}

/** The open pass mints that launched, newest first, read from the mint factories themselves. */
async function readEarlierLaunches(): Promise<EarlierLaunch[]> {
  const launches: EarlierLaunch[] = [];
  for (const factory of CALLZ_FACTORIES) {
    let count: bigint;
    try {
      count = await client.readContract({ address: factory, abi: mintFactoryAbi, functionName: "mintCount" });
    } catch {
      // A factory that is not on BNB Chain has made nothing.
      continue;
    }
    const total = Number(count);
    const shown = Math.min(total, EARLIER_MINTS);
    if (shown === 0) continue;
    const mints = await client.multicall({
      allowFailure: false,
      contracts: Array.from({ length: shown }, (_, index) => ({ address: factory, abi: mintFactoryAbi, functionName: "mints" as const, args: [BigInt(total - 1 - index)] as const })),
    });
    const facts = await Promise.all(
      mints.map((mint) =>
        client.multicall({
          allowFailure: false,
          contracts: [
            { address: mint, abi: mintAbi, functionName: "tokenName" },
            { address: mint, abi: mintAbi, functionName: "tokenSymbol" },
            { address: mint, abi: mintAbi, functionName: "launched" },
            { address: mint, abi: mintAbi, functionName: "token" },
          ],
        }),
      ),
    );
    facts.forEach(([name, symbol, launched, token], index) => {
      if (launched) launches.push({ mint: mints[index]!, token, name, symbol });
    });
  }
  return launches;
}

function LaunchedPage() {
  const list = useApi("/api/rooms?launched=1", 15_000, isRoomList);
  const earlier = useChain(readEarlierLaunches, 60_000);
  const launched = list.state === "ready" ? list.data.rooms.filter((room) => room.launched === true) : [];
  const before = earlier.state === "ready" ? earlier.data : [];
  return (
    <div className="rooms-page" data-testid="launched-page">
      <div className="page-head">
        <h1 className="page-title">Launches</h1>
        <p className="lede">
          The projects that launched on CallZ. Each one filled its Cook Room: every pass was bought by a member the dev chose, the dev
          launched, and the token trades on PancakeSwap with its liquidity locked for good.
        </p>
        <p className="links">
          <a href="#/rooms">Cook Rooms</a>
          <a href="#/leaderboard">Leaderboard</a>
          <a href="#/clans">Clans</a>
        </p>
      </div>
      <section>
        <div className="section-head">
          <h2>From Cook Rooms {list.state === "ready" && <span className="dim">{launched.length}</span>}</h2>
        </div>
        {list.state === "loading" && <p className="note" role="status">Loading the launches…</p>}
        {list.state === "error" && <p className="note" role="alert">{list.error.message}</p>}
        {list.state === "ready" && launched.length === 0 && (
          <p className="note" data-testid="launched-empty">No Cook Room has launched yet. <a href="#/rooms">See the ones that are filling up.</a></p>
        )}
        {launched.length > 0 && (
          <ul className="cards grid" data-testid="launched-list">
            {launched.map((room) => <li key={room.address}><LaunchedCard room={room} /></li>)}
          </ul>
        )}
      </section>
      {before.length > 0 && (
        <section>
          <div className="section-head">
            <h2>Before Cook Rooms <span className="dim">{before.length}</span></h2>
          </div>
          <p className="trade-note dim">Launched by an open pass mint, where anyone could buy a pass.</p>
          <ul className="cards grid" data-testid="launched-earlier">
            {before.map((launch) => (
              <li key={launch.mint}>
                <div className="launch-card room-card" data-testid="launched-earlier-card">
                  <span className="launch-head">
                    <RoomArt picture={null} symbol={launch.symbol} />
                    <span className="launch-name">
                      <strong>{launch.name}</strong>
                      <span className="dim">{launch.symbol}</span>
                    </span>
                    <span className="tag tag-good">Launched</span>
                  </span>
                  <span className="actions">
                    <a className="button" href={`#/token/${launch.token.toLowerCase()}`}>Chart and trading</a>
                    <a className="button button-quiet" href={`#/mint/${launch.mint.toLowerCase()}`}>The mint</a>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** A Cook Room that launched: who cooked it, how many were in it, what it raised, and where its token trades. */
function LaunchedCard({ room }: { room: ApiRoom }) {
  const seats = Number(room.seats) || 0;
  const price = toBig(room.seatPrice);
  const token = typeof room.token === "string" && isAddress(room.token) ? room.token.toLowerCase() : null;
  return (
    <div className="launch-card room-card" data-testid="launched-card" data-room={room.address.toLowerCase()}>
      <span className="launch-head">
        <RoomArt picture={room.picture} symbol={String(room.symbol)} />
        <span className="launch-name">
          <strong>{String(room.name)}</strong>
          <span className="dim">{String(room.symbol)}</span>
        </span>
        <span className="tag tag-good">Launched</span>
      </span>
      <span className="room-card-line dim">Dev <AuthorName className="room-author" address={room.creator} name={room.creatorName} clan={room.creatorClan} /></span>
      <span className="room-card-line">
        <span className="num">{plural(seats, "member", "members")}</span>
        <span className="num">{price === null ? "—" : `${bnb(price * BigInt(seats))} raised`}</span>
      </span>
      <span className="actions">
        {token !== null && <a className="button" href={`#/token/${token}`} data-testid="launched-token">Chart and trading</a>}
        <a className="button button-quiet" href={`#/room/${room.address.toLowerCase()}`}>The Cook Room</a>
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// #/rooms/create
// ─────────────────────────────────────────────────────────────────────────────

/** What a dev typed about a room that the API could not store when the room was created: the room page offers it again. */
let unsavedSettings: { room: string; about: string; wantPost: boolean; postBrief: string; wantRole: boolean; roleBrief: string; reason: string } | null = null;

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** Why a typed token address cannot be a room's holding requirement, or not yet. */
const TOKEN_PROBLEMS: Record<Exclude<TokenLabel["state"], "ready">, string> = {
  none: "Hold a token: reading the token from BNB Chain…",
  loading: "Hold a token: reading the token from BNB Chain…",
  error: "Hold a token: BNB Chain could not be reached to read the token. Trying again shortly.",
  nocode: "Hold a token: there is no contract at that address on BNB Chain.",
  nottoken: "Hold a token: that contract does not answer decimals() and balanceOf(), so a room cannot check holdings of it.",
};

function CreatePage() {
  const wallet = useWallet();
  const account = wallet.account;
  const signedIn = useSignedIn(account);
  const factory = useChain(readFactory, 60_000);
  const { tx, send } = useTransaction();
  const gate = WalletGate();
  const picture = usePickedPicture(ROOM_PICTURE_SIDE);
  const [form, setForm] = useState({
    name: "", symbol: "", about: "", total: "1", passes: "10", poolShare: "50", hours: "24",
    wantPost: false, postBrief: "", postPhrase: "", wantHold: false, gateToken: "", gateAmount: "", wantRole: false, roleBrief: "",
  });
  const [step, setStep] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: "name" | "symbol" | "about" | "total" | "passes" | "poolShare" | "hours" | "postBrief" | "postPhrase" | "gateToken" | "gateAmount" | "roleBrief") =>
    (event: { target: { value: string } }) => setForm((previous) => ({ ...previous, [key]: event.target.value }));
  const toggle = (key: "wantPost" | "wantHold" | "wantRole") => (event: { target: { checked: boolean } }) => setForm((previous) => ({ ...previous, [key]: event.target.checked }));

  const typedToken = form.gateToken.trim();
  const gateAddress = form.wantHold && isAddress(typedToken) ? typedToken : null;
  const token = useToken(gateAddress);
  const feeBps = factory.state === "ready" ? factory.data.launchFeeBps : deployment.launchFeeBps;

  const parsed = useMemo(() => {
    const problems: string[] = [];
    const name = form.name.trim();
    const symbol = form.symbol.trim();
    if (!name || bytesOf(name) > 64) problems.push("Token name: 1 to 64 bytes.");
    if (!symbol || bytesOf(symbol) > 32) problems.push("Token symbol: 1 to 32 bytes.");
    const about = form.about.trim();
    if (lengthOf(about) > MAX_ABOUT_LENGTH) problems.push(`About: at most ${MAX_ABOUT_LENGTH} characters.`);

    let total = 0n;
    try {
      total = parseEther(form.total.trim() || "0");
    } catch {
      problems.push("Total to raise must be a BNB amount.");
    }
    if (total <= 0n || total > MAX_CAP) problems.push("Total to raise: above zero, at most 10 BNB.");
    const passes = /^\d{1,4}$/.test(form.passes.trim()) ? Number(form.passes.trim()) : 0;
    if (passes < 1 || passes > MAX_SEATS) problems.push(`Number of passes: a whole number from 1 to ${MAX_SEATS.toLocaleString("en")}.`);
    // Rounded down to the wei: every pass costs the same, and the room never raises more than was typed.
    const seatPrice = passes > 0 && total > 0n ? total / BigInt(passes) : 0n;
    if (passes > 0 && total > 0n && seatPrice === 0n) problems.push("That total is too small to split between that many passes.");
    const raise = seatPrice * BigInt(passes);

    const share = Number(form.poolShare.trim());
    if (!Number.isInteger(share) || share < 10 || share > 90) problems.push("Share of supply into the pool: a whole number from 10 to 90.");
    const poolShareBps = Number.isInteger(share) ? share * 100 : 0;
    const hours = Number(form.hours.trim());
    const duration = form.hours.trim() !== "" && Number.isFinite(hours) ? Math.round(hours * 3600) : 0;
    if (duration < MIN_SALE_SECONDS || duration > MAX_SALE_SECONDS) problems.push("Deadline: from 10 minutes (0.17 hours) to 30 days (720 hours).");

    const postBrief = form.postBrief.trim();
    if (form.wantPost && lengthOf(postBrief) > MAX_BRIEF_LENGTH) problems.push(`What the post should say: at most ${MAX_BRIEF_LENGTH} characters.`);
    const roleBrief = form.roleBrief.trim();
    if (form.wantRole && lengthOf(roleBrief) > MAX_BRIEF_LENGTH) problems.push(`Who you are looking for: at most ${MAX_BRIEF_LENGTH} characters.`);

    let gateAmount = 0n;
    if (form.wantHold) {
      if (gateAddress === null) problems.push("Hold a token: enter the token's address on BNB Chain (0x followed by 40 hex digits).");
      else if (token.state !== "ready") problems.push(TOKEN_PROBLEMS[token.state]);
      else {
        try {
          gateAmount = parseUnits(form.gateAmount.trim() || "0", token.decimals);
        } catch {
          gateAmount = 0n;
        }
        if (gateAmount <= 0n || gateAmount >= 2n ** 256n) problems.push("Hold a token: the amount to hold must be a number above zero.");
      }
    }
    const tokensPerSeat = passes > 0 && poolShareBps > 0 ? (TOTAL_SUPPLY - (TOTAL_SUPPLY * BigInt(poolShareBps)) / 10_000n) / BigInt(passes) : 0n;
    return { name, symbol, about, total, passes, seatPrice, raise, poolShareBps, duration, postBrief, roleBrief, gateAmount, tokensPerSeat, problems };
  }, [form, gateAddress, token]);

  const fee = (parsed.raise * BigInt(feeBps)) / 10_000n;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!account || parsed.problems.length > 0 || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      if (!signedIn) {
        setStep("Step 1 of 4. Signing in: confirm the message in your wallet. It sends nothing and costs nothing.");
        await signIn(account);
      }
      let image = "";
      if (picture.picked) {
        setStep("Step 2 of 4. Uploading the picture…");
        const { url } = await api<{ url?: unknown }>("/api/rooms/images", { bytes: picture.picked.blob });
        // Only this site's own picture address goes into the contract, and the contract holds 200 bytes at most.
        if (typeof url !== "string" || !OWN_PICTURE.test(url)) throw new Error("The picture was stored, but its address was not understood. Try again.");
        image = url;
      }

      setStep("Step 3 of 4. Opening the Cook Room on BNB Chain…");
      const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
      const predicted = await client.readContract({ address: FACTORY, abi: factoryAbi, functionName: "predict", args: [account, salt] });
      const config = {
        name: parsed.name,
        symbol: parsed.symbol,
        image,
        seatPrice: parsed.seatPrice,
        seats: BigInt(parsed.passes),
        saleDuration: BigInt(parsed.duration),
        poolShareBps: parsed.poolShareBps,
        gateToken: form.wantHold && gateAddress ? gateAddress : ZERO,
        gateAmount: form.wantHold ? parsed.gateAmount : 0n,
      };
      const receipt = await send("Opening the Cook Room", { to: FACTORY, data: encodeFunctionData({ abi: factoryAbi, functionName: "create", args: [config, salt] }) }, account);
      if (!receipt) {
        setStep(null);
        return;
      }
      // The factory names the room it made; the address read beforehand is the same one.
      const created = parseEventLogs({ abi: factoryAbi, eventName: "CallZRoomCreated", logs: receipt.logs })[0];
      const room = (created?.args.room ?? predicted).toLowerCase();

      setStep("Step 4 of 4. Saving the description…");
      const settings = {
        room,
        about: parsed.about,
        wantPost: form.wantPost,
        postBrief: form.wantPost ? parsed.postBrief : "",
        postPhrase: form.wantPost ? form.postPhrase.trim() : "",
        wantRole: form.wantRole,
        roleBrief: form.wantRole ? parsed.roleBrief : "",
      };
      let saved = false;
      let reason = "";
      // The API reads the room from the chain itself, and its node may be a block behind this one.
      for (let attempt = 0; attempt < 5 && !saved; attempt++) {
        try {
          await api("/api/rooms", { body: settings });
          saved = true;
        } catch (cause) {
          reason = messageOf(cause);
          if (!(cause instanceof ApiError) || cause.status !== 404 || attempt === 4) break;
          await wait(2000);
        }
      }
      unsavedSettings = saved ? null : { ...settings, reason };
      window.location.hash = `#/room/${room}`;
    } catch (cause) {
      setStep(null);
      setFailure(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  if (factory.state === "ready" && !factory.data.deployed) {
    return (
      <div className="rooms-page">
        <div className="page-head"><h1 className="page-title">Open a Cook Room</h1></div>
        <p className="note" data-testid="room-create-unavailable">The Cook Room factory is not on BNB Chain yet, so Cook Rooms cannot be opened. <a href="#/rooms">It can be deployed from the rooms page.</a></p>
      </div>
    );
  }

  return (
    <div className="rooms-page">
      <div className="page-head">
        <h1 className="page-title">Open a Cook Room</h1>
        <p className="lede">
          On BNB Chain. You let wallets in, each buys one pass, and when every pass is sold you launch the token into a PancakeSwap pool.
          The name, symbol, picture, price, number of passes, deadline, pool share and holding requirement cannot be changed after you create the room.
        </p>
      </div>
      <form className="form" onSubmit={(event) => void submit(event)} data-testid="room-form">
        <Field label="Token name"><input name="name" value={form.name} onChange={set("name")} maxLength={64} autoComplete="off" required /></Field>
        <Field label="Token symbol"><input name="symbol" value={form.symbol} onChange={set("symbol")} maxLength={32} autoComplete="off" required /></Field>

        <div className="form-wide room-picture-field">
          <span className="stat-label">Room picture (optional)</span>
          <div className="room-picture-row">
            {picture.picked && <img className="room-preview" src={picture.picked.url} alt="The room picture as it will be shown" data-testid="room-picture-preview" />}
            <div className="actions">
              <label className="button button-quiet room-file">
                {picture.picked ? "Choose another picture" : "Choose a picture"}
                <input className="room-file-input" type="file" name="picture" accept={PICTURE_ACCEPT} data-testid="room-picture-input" disabled={busy} onChange={(event) => void picture.pick(event)} />
              </label>
              {picture.picked && <button type="button" className="button button-quiet" data-testid="room-picture-remove" disabled={busy} onClick={picture.clear}>Remove</button>}
            </div>
          </div>
          {picture.busy && <span className="dim field-hint" role="status">Preparing the picture…</span>}
          {picture.error && <p className="chat-error" role="alert" data-testid="room-picture-error">{picture.error}</p>}
          <span className="dim field-hint">
            PNG, JPEG, WebP or GIF. Every pass NFT of this room shows this picture and the price paid for it. Without a picture, a drawn pass
            with the price on it is shown instead. The picture is made smaller in your browser before it is sent.
          </span>
        </div>

        <label className="field form-wide">
          <span className="stat-label">About</span>
          <textarea className="room-text" name="about" rows={4} value={form.about} onChange={set("about")} maxLength={MAX_ABOUT_LENGTH} />
          <span className="dim field-hint">What the project is and what members will do. Up to {MAX_ABOUT_LENGTH} characters. You can change this later.</span>
        </label>

        <Field label="Total to raise (BNB)" hint="What the room raises when every pass is sold. At most 10 BNB."><input name="total" inputMode="decimal" value={form.total} onChange={set("total")} autoComplete="off" /></Field>
        <Field label="Number of passes" hint="One pass per member, 1 to 1,000. Every pass costs the same."><input name="passes" inputMode="numeric" value={form.passes} onChange={set("passes")} autoComplete="off" /></Field>
        <Field label="Share of supply into the pool (%)" hint="10 to 90. The rest of the 1,000,000,000 supply is split equally between the passes."><input name="poolShare" inputMode="numeric" value={form.poolShare} onChange={set("poolShare")} autoComplete="off" /></Field>
        <Field label="Deadline (hours from now)" hint="If the room has not launched by then, every member can hand their pass back for its full price."><input name="hours" inputMode="decimal" value={form.hours} onChange={set("hours")} autoComplete="off" /></Field>

        <dl className="trade-quote form-wide" data-testid="room-summary">
          <div><dt>Each pass costs</dt><dd className="num" data-testid="room-summary-price">{bnb(parsed.seatPrice)}</dd></div>
          {parsed.raise !== parsed.total && parsed.seatPrice > 0n && (
            <div><dt>The room raises exactly</dt><dd className="num" data-testid="room-summary-total">{bnb(parsed.raise)}</dd></div>
          )}
          <div><dt>Launch fee, to the CallZ vault</dt><dd className="num">{feeBps / 100}% of the raise · {bnb(fee)}</dd></div>
          <div><dt>BNB into the pool at launch</dt><dd className="num">{bnb(parsed.raise - fee)}</dd></div>
          <div><dt>Tokens each pass claims</dt><dd className="num" data-testid="room-summary-tokens">{units(parsed.tokensPerSeat, 18, 4)}</dd></div>
        </dl>

        <div className="form-wide room-requirements-form">
          <h2>What it takes to get in</h2>
          <p className="trade-note dim">None of these is required. With none on, a wallet asks to join and you decide.</p>

          <fieldset className="room-requirement">
            <label className="room-toggle"><input type="checkbox" name="wantPost" checked={form.wantPost} onChange={toggle("wantPost")} /><span>Make a post on X</span></label>
            {form.wantPost && (
              <>
                <p className="trade-note dim">Each applicant gets a personal code to include in the post, and the site checks with X that the post is up and carries it.</p>
                <label className="field">
                  <span className="stat-label">What should the post say?</span>
                  <textarea className="room-text" name="postBrief" rows={3} value={form.postBrief} onChange={set("postBrief")} maxLength={MAX_BRIEF_LENGTH} />
                </label>
                <label className="field">
                  <span className="stat-label">Words the post must contain</span>
                  <input name="postPhrase" value={form.postPhrase} onChange={set("postPhrase")} maxLength={MAX_PHRASE_LENGTH} autoComplete="off" placeholder="For example: Cooking $NIGHT with @callzfun" />
                  <span className="dim field-hint">Optional. The site checks with X that the post contains exactly these words, in any capitals. A post without them is refused.</span>
                </label>
              </>
            )}
          </fieldset>

          <fieldset className="room-requirement">
            <label className="room-toggle"><input type="checkbox" name="wantHold" checked={form.wantHold} onChange={toggle("wantHold")} /><span>Hold a token</span></label>
            {form.wantHold && (
              <>
                <p className="trade-note dim">
                  Checked when a wallet applies, again when you let it in, and enforced by the room's contract itself at that moment: a wallet
                  that does not hold enough cannot be let in. This requirement is fixed in the contract and cannot be changed later.
                </p>
                <Field label="Token address"><input name="gateToken" value={form.gateToken} onChange={set("gateToken")} placeholder="0x…" autoComplete="off" spellCheck={false} /></Field>
                {gateAddress !== null && (
                  <p className="trade-note" data-testid="room-gate-token-label" data-state={token.state}>
                    {token.state === "loading" && "Reading the token from BNB Chain…"}
                    {token.state === "ready" && <>Token: <strong>{token.symbol ?? short(gateAddress)}</strong>, {token.decimals} decimals.</>}
                    {token.state === "nocode" && "There is no contract at that address on BNB Chain."}
                    {token.state === "nottoken" && "That contract does not answer decimals() and balanceOf()."}
                    {token.state === "error" && "BNB Chain could not be reached to read the token. Trying again shortly."}
                  </p>
                )}
                <Field label={`Amount to hold${token.state === "ready" && token.symbol ? ` (${token.symbol})` : ""}`}><input name="gateAmount" inputMode="decimal" value={form.gateAmount} onChange={set("gateAmount")} autoComplete="off" /></Field>
              </>
            )}
          </fieldset>

          <fieldset className="room-requirement">
            <label className="room-toggle"><input type="checkbox" name="wantRole" checked={form.wantRole} onChange={toggle("wantRole")} /><span>Role and portfolio</span></label>
            {form.wantRole && (
              <>
                <p className="trade-note dim">Each applicant says what role they would take and shows their work. You read it and decide.</p>
                <label className="field">
                  <span className="stat-label">Who are you looking for?</span>
                  <textarea className="room-text" name="roleBrief" rows={3} value={form.roleBrief} onChange={set("roleBrief")} maxLength={MAX_BRIEF_LENGTH} />
                </label>
              </>
            )}
          </fieldset>
        </div>

        {parsed.problems.length > 0 && <ul className="form-problems form-wide" data-testid="room-problems">{parsed.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
        <div className="actions form-wide">
          {gate ?? <button type="submit" className="button" data-testid="room-create-submit" disabled={parsed.problems.length > 0 || busy || picture.busy || tx.kind === "working"}>Open the Cook Room</button>}
          <a className="button button-quiet" href="#/rooms">Back</a>
        </div>
        {!signedIn && account && <p className="trade-note dim form-wide">Creating a room first asks your wallet to sign a sign-in message, so the site knows the description comes from the room's dev.</p>}
        {step && <p className="trade-outcome trade-working form-wide" role="status" data-testid="room-create-step">{step}</p>}
        {failure && <p className="trade-outcome trade-error form-wide" role="alert" data-testid="room-create-error">{failure}</p>}
        <div className="form-wide"><TxNote tx={tx} /></div>
      </form>
      <p className="note note-warn" data-testid="room-create-terms">
        You cannot withdraw the raise: BNB leaves a room only through the launch, back to a member you remove, or back to members who hand
        their passes in after the deadline. Removing a member returns their BNB in full. Passes cannot be transferred. The launch fee is
        taken from the raise only if the room launches. {RISK}
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// #/room/<address>
// ─────────────────────────────────────────────────────────────────────────────

interface RoomInfo {
  creator: Address;
  tokenName: string;
  tokenSymbol: string;
  image: string;
  seatPrice: bigint;
  seats: bigint;
  seated: bigint;
  minted: bigint;
  raised: bigint;
  saleDeadline: bigint;
  poolShareBps: number;
  launchFeeBps: number;
  gateToken: Address;
  gateAmount: bigint;
  tokensPerSeat: bigint;
  launched: boolean;
  token: Address;
  pair: Address;
}

interface Mine {
  admitted: boolean;
  banned: boolean;
  /** The pass this wallet holds, or 0. */
  seat: bigint;
  claimed: boolean;
  /** BNB a removal could not deliver, waiting to be collected. */
  owed: bigint;
  claimable: bigint;
  refundable: bigint;
}

interface ChainRoom {
  info: RoomInfo;
  /** True once the deadline has passed without a launch: passes can be handed back and no more can be bought. */
  refundAvailable: boolean;
  /** Where the connected wallet stands. Null with no wallet, or when the room could not say. */
  mine: Mine | null;
}

/** Everything the page's parts need to know about the room they are in. */
interface RoomContext {
  room: Address;
  /** The room's API address: /api/rooms/<address>. */
  base: string;
  data: ChainRoom;
  detail: RoomDetail | null;
  account: Address | null;
  signedIn: boolean;
  /** An amount of the token the room requires, in words: "1,000 CAKE". */
  gateText(value: bigint): string;
  /** Changes whenever a transaction of this page confirmed: what the API keeps is read again. */
  tick: number;
  /** Reads the room again, from the chain and from the API. Called after every transaction. */
  refresh(): Promise<void>;
  /** Reads the API's copy again. Called after a change the API alone keeps. */
  reloadListing(): void;
}

function RoomPage({ address, mobile }: { address: string; mobile: boolean }) {
  const room = address as Address;
  const base = `/api/rooms/${address.toLowerCase()}`;
  const wallet = useWallet();
  const account = wallet.account;
  const signedIn = useSignedIn(account);
  const [tick, setTick] = useState(0);

  const load = useCallback(async (): Promise<ChainRoom | null> => {
    const at = { address: room, abi: roomAbi } as const;
    const who = account ?? ZERO;
    const [listed, info, refundAvailable, standing, claimable, refundable] = await client.multicall({
      allowFailure: true,
      contracts: [
        // Only a room the CallZ factory made is shown: a contract that merely answers like one is not a room.
        { address: FACTORY, abi: factoryAbi, functionName: "isRoom", args: [room] },
        { ...at, functionName: "info" },
        { ...at, functionName: "refundAvailable" },
        { ...at, functionName: "standingOf", args: [who] },
        { ...at, functionName: "claimableOf", args: [who] },
        { ...at, functionName: "refundableOf", args: [who] },
      ],
    });
    if (listed.status !== "success" || !listed.result) return null;
    if (info.status !== "success" || refundAvailable.status !== "success") throw new Error("the room did not answer");
    const mine =
      account && standing.status === "success" && claimable.status === "success" && refundable.status === "success"
        ? { admitted: standing.result.admitted, banned: standing.result.banned, seat: standing.result.seat, claimed: standing.result.claimed, owed: standing.result.owed, claimable: claimable.result, refundable: refundable.result }
        : null;
    return { info: info.result, refundAvailable: refundAvailable.result, mine };
  }, [room, account]);
  const chain = useChain(load, 10_000);
  const listing = useApi(base, 10_000, isRoomDetail);
  const { reload: reloadChain } = chain;
  const { reload: reloadListing, set: setListing } = listing;

  const refresh = useCallback(async () => {
    reloadChain();
    try {
      // The API reads the room from the chain again now, so its member list follows the transaction.
      const synced = await api<unknown>(`${base}/sync`, { body: {} });
      if (isRoomDetail(synced)) setListing(synced);
      else reloadListing();
    } catch {
      reloadListing();
    }
    setTick((value) => value + 1);
  }, [base, reloadChain, reloadListing, setListing]);

  if (chain.state === "loading") return <p className="note" role="status">Reading the room from BNB Chain…</p>;
  if (chain.state === "error") return <p className="note" role="alert">BNB Chain could not be reached. Reload to try again.</p>;
  if (!chain.data) {
    return <p className="note" role="alert" data-testid="unknown-room"><code>{short(room)}</code> is not a Cook Room made by the CallZ factory on BNB Chain. <a href="#/rooms">Back to the rooms.</a></p>;
  }
  return (
    <RoomView
      mobile={mobile}
      notListed={listing.state === "error" && listing.error.status === 404}
      listingError={listing.state === "error" && listing.error.status !== 404 ? listing.error.message : null}
      room={room}
      base={base}
      data={chain.data}
      detail={listing.state === "ready" ? listing.data : null}
      account={account}
      signedIn={signedIn}
      tick={tick}
      refresh={refresh}
      reloadListing={reloadListing}
    />
  );
}

function RoomView({ mobile, notListed, listingError, ...given }: Omit<RoomContext, "gateText"> & { mobile: boolean; notListed: boolean; listingError: string | null }) {
  const { room, data, detail, account, signedIn } = given;
  const { info, refundAvailable, mine } = data;
  const now = useNow(20_000);
  const gated = info.gateToken !== ZERO;
  const token = useToken(gated ? info.gateToken : null);

  // The token's own answer first; the API's copy of it while the chain has not answered.
  const apiGate = detail?.room.gate ?? null;
  const gateDecimals = token.state === "ready" ? token.decimals : typeof apiGate?.decimals === "number" ? apiGate.decimals : null;
  const gateSymbol = (token.state === "ready" ? token.symbol : null) ?? (typeof apiGate?.symbol === "string" && apiGate.symbol ? apiGate.symbol : null) ?? short(info.gateToken);
  const gateText = useCallback(
    (value: bigint) => (gateDecimals === null ? `${value.toString()} base units of ${gateSymbol}` : `${units(value, gateDecimals)} ${gateSymbol}`),
    [gateDecimals, gateSymbol],
  );
  const context: RoomContext = { ...given, gateText };

  // The chain for money and standing, the API for text.
  const name = detail ? String(detail.room.name) : cleanLine(info.tokenName);
  const symbol = detail ? String(detail.room.symbol) : cleanLine(info.tokenSymbol);
  const picture = detail ? detail.room.picture : ownPicture(info.image);
  const full = info.seated === info.seats;
  const status = statusOf({ launched: info.launched, closed: refundAvailable, full });
  const target = info.seatPrice * info.seats;
  const deadline = Number(info.saleDeadline);
  const isDev = !!account && account.toLowerCase() === info.creator.toLowerCase();
  const mayChat = isDev || (mine !== null && mine.seat > 0n);
  const free = info.seats - info.seated;

  let standingLine: string;
  if (info.launched) standingLine = "It has launched: the token trades on PancakeSwap, the pool's liquidity is locked, and every pass claims its share.";
  else if (refundAvailable && full) standingLine = "Its deadline has passed with every seat taken: the dev can still launch, and until then every member can hand their pass back for its full price.";
  else if (refundAvailable) standingLine = "Its deadline passed without a launch. No more passes can be bought, and every member can hand their pass back for its full price.";
  else if (full) standingLine = "Every seat is taken. The dev can launch the token now.";
  else standingLine = `${plural(free, "seat is", "seats are")} free. The dev decides who gets in.`;

  return (
    <div className="rooms-page" data-wide={mobile ? "false" : "true"} data-testid="room-page">
      <div className="room-layout">
        <div className="room-main">
          <header className="room-head" data-testid="room-head">
            <RoomArt picture={picture} symbol={symbol} large />
            <div className="room-title">
              <div className="scope-head">
                <h1 className="page-title">{name} <span className="dim">{symbol}</span></h1>
                <span className={`tag tag-${status.tone}`} data-testid="room-status" data-status={status.key}>{status.label}</span>
              </div>
              <p className="room-dev-line">
                <span className="dim">Dev</span>{" "}
                <a className="room-profile" href={`#/u/${info.creator.toLowerCase()}`}>
                  <AuthorName className="room-author" address={info.creator.toLowerCase()} name={detail?.room.creatorName} clan={detail?.room.creatorClan} />
                </a>
              </p>
              <p className="trade-note dim">A CallZ room on BNB Chain. {standingLine}</p>
            </div>
          </header>
          {detail && detail.room.about !== "" && <p className="token-description room-about" data-testid="room-about">{String(detail.room.about)}</p>}
          {notListed && <p className="note" data-testid="room-not-listed">This room is on BNB Chain but not listed on CallZ yet, so its description, applications and chat are not here. What follows is read from the room's contract.</p>}
          {listingError && !detail && <p className="note" role="alert">{listingError}</p>}

          <dl className="stats token-stats room-facts" data-testid="room-facts">
            <div><dt>Price per pass</dt><dd className="num">{bnb(info.seatPrice)}</dd></div>
            <div><dt>Seats taken</dt><dd className="num">{info.seated.toString()} / {info.seats.toString()}</dd></div>
            <div><dt>{info.launched ? "Raised" : "Raised so far"}</dt><dd className="num">{info.launched ? bnb(target) : `${formatEther(info.raised)} / ${bnb(target)}`}</dd></div>
            <div><dt>Deadline</dt><dd className="num">{new Date(deadline * 1000).toLocaleString()} <span className="dim">{info.launched ? "" : until(deadline, now)}</span></dd></div>
            <div><dt>Supply into the pool</dt><dd className="num">{info.poolShareBps / 100}%</dd></div>
            <div><dt>Launch fee</dt><dd className="num">{info.launchFeeBps === 0 ? "None" : `${info.launchFeeBps / 100}% of the raise`}</dd></div>
            <div><dt>Tokens per pass</dt><dd className="num">{units(info.tokensPerSeat, 18, 2)}</dd></div>
          </dl>
          {info.launched && (
            <div className="actions">
              <a className="button" href={`#/token/${info.token.toLowerCase()}`} data-testid="room-token-link">Chart and trading →</a>
              <a className="button button-quiet" href={`${SITE.explorer}/address/${info.pair}`} target="_blank" rel="noreferrer">Pool on BscScan ↗</a>
            </div>
          )}

          <section className="trade-panel room-panel" data-testid="room-requirements">
            <h2>What it takes to get in</h2>
            <ul className="room-needs">
              {detail?.room.wantPost && (
                <li>
                  <strong>Make a post on X.</strong> Your application gives you a personal code to put in the post, and the site checks with X that the post is up and carries it.
                  {detail.room.postBrief !== "" && <span className="room-brief">{String(detail.room.postBrief)}</span>}
                  {typeof detail.room.postPhrase === "string" && detail.room.postPhrase !== "" && <span className="room-brief" data-testid="room-requirement-phrase">It must contain: {detail.room.postPhrase}</span>}
                </li>
              )}
              {gated && (
                <li>
                  <strong>Hold {gateText(info.gateAmount)}.</strong> Checked when you apply, again when the dev lets you in, and by the room's contract itself at that moment.{" "}
                  <a href={`${SITE.explorer}/token/${info.gateToken}`} target="_blank" rel="noreferrer">Token {short(info.gateToken)} ↗</a>
                </li>
              )}
              {detail?.room.wantRole && (
                <li>
                  <strong>Say your role and show your work.</strong> The dev reads it and decides.
                  {detail.room.roleBrief !== "" && <span className="room-brief">{String(detail.room.roleBrief)}</span>}
                </li>
              )}
              {!gated && !detail?.room.wantPost && !detail?.room.wantRole && <li>{detail ? "Nothing but the dev's yes: ask to join, and the dev decides." : "The room's contract requires no token. Whatever else the dev asks for shows once the room is listed."}</li>}
            </ul>
            <p className="trade-foot dim">In every room the dev chooses each member, and a wallet buys its pass only after the dev has let it in.</p>
          </section>

          <Seat {...context} />
          <Members {...context} isDev={isDev} />
        </div>

        <aside className="room-side">
          <section className="chat-panel room-chat" data-testid="room-chat" aria-label="Room chat">
            <header className="chat-head"><h2>Cook Room chat</h2></header>
            {!mayChat && <p className="chat-room-note" data-testid="room-chat-closed">This chat is private: only the room's dev and the wallets holding its pass can read and write here.{account ? "" : " Connect the wallet that holds a pass."}</p>}
            {mayChat && account && !signedIn && (
              <>
                <p className="chat-room-note">The chat is private, so the site has to know this wallet is yours. Signing in is a message, not a transaction: it costs nothing.</p>
                <SignInButton account={account} label="Sign in to open the chat" testId="room-chat-signin" />
              </>
            )}
            {mayChat && account && signedIn && <RoomChat key={account} base={given.base} me={account.toLowerCase()} />}
          </section>
        </aside>

        {isDev && <DevConsole {...context} />}
      </div>
      <p className="trade-foot dim room-foot">
        {RISK} The dev cannot withdraw the raise: BNB leaves this room only through the launch, back to a member the dev removes, or back to
        members who hand their passes in after the deadline. Contract <a href={`${SITE.explorer}/address/${room}`} target="_blank" rel="noreferrer">{short(room)} ↗</a>
      </p>
    </div>
  );
}

// ── Your seat ────────────────────────────────────────────────────────────────

function Seat(context: RoomContext) {
  const { room, data, detail, account, signedIn, refresh } = context;
  const { info, refundAvailable, mine } = data;
  const gate = WalletGate();
  const { tx, act, working } = useRoomAction(room, account, refresh);
  const symbol = detail ? String(detail.room.symbol) : cleanLine(info.tokenSymbol);
  const full = info.seated === info.seats;
  const isDev = !!account && account.toLowerCase() === info.creator.toLowerCase();

  let state: string;
  let body: ReactNode;
  if (gate || !account) {
    state = "wallet";
    body = (
      <>
        <p className="trade-note">Connect a wallet on BNB Chain to see where it stands in this room.</p>
        <div className="actions">{gate}</div>
      </>
    );
  } else if (!mine) {
    state = "unread";
    body = <p className="trade-note" role="alert">Where this wallet stands could not be read from the room's contract. It is read again every few seconds.</p>;
  } else if (mine.banned) {
    state = "banned";
    body = <p className="trade-note" data-testid="room-seat-banned">The dev removed this wallet from the room.{mine.owed === 0n ? " If it held a pass, the pass was burned and its full price was sent back to this wallet." : ""}</p>;
  } else if (mine.seat > 0n) {
    state = "member";
    body = (
      <>
        <p className="trade-note" data-testid="room-seat-pass">You hold pass <strong className="num">#{mine.seat.toString()}</strong>.</p>
        {info.launched && mine.claimable > 0n && (
          <>
            <p className="trade-note">The room has launched. This pass claims its tokens once, and stays in this wallet.</p>
            <button type="button" className="button trade-go" data-testid="room-claim" disabled={working} onClick={() => void act("Claiming", encodeFunctionData({ abi: roomAbi, functionName: "claim" }))}>
              Claim {units(mine.claimable, 18, 2)} {symbol}
            </button>
          </>
        )}
        {info.launched && mine.claimable === 0n && <p className="trade-note dim">{mine.claimed ? "This pass has claimed its tokens." : "There is nothing to claim for this pass."}</p>}
        {!info.launched && mine.refundable > 0n && (
          <>
            <p className="trade-note">The deadline has passed without a launch. Handing the pass back burns it and sends its full price to this wallet. It cannot be undone.</p>
            <button type="button" className="button trade-go" data-testid="room-refund" disabled={working} onClick={() => void act("Handing the pass back", encodeFunctionData({ abi: roomAbi, functionName: "refund" }))}>
              Hand the pass back for {bnb(mine.refundable)}
            </button>
          </>
        )}
        {!info.launched && mine.refundable === 0n && (
          <p className="trade-note dim">
            When every seat is taken the dev can launch, and this pass then claims {units(info.tokensPerSeat, 18, 2)} {symbol}. If the room has not launched
            by {new Date(Number(info.saleDeadline) * 1000).toLocaleString()}, you can hand the pass back for its full price, {bnb(info.seatPrice)}.
          </p>
        )}
      </>
    );
  } else if (mine.admitted) {
    state = "admitted";
    if (info.launched) body = <p className="trade-note">The dev let this wallet in, but the room launched before it bought a pass. No more passes can be bought.</p>;
    else if (refundAvailable) body = <p className="trade-note">The dev let this wallet in, but the room's deadline has passed. No more passes can be bought.</p>;
    else if (full) body = <p className="trade-note">The dev let you in, but every seat is taken right now. If a seat comes free, you can buy your pass here.</p>;
    else {
      body = (
        <>
          <p className="trade-note">The dev let you in. Buy your pass: <strong className="num">{bnb(info.seatPrice)}</strong></p>
          <button type="button" className="button trade-go" data-testid="room-buy" disabled={working} onClick={() => void act("Buying the pass", encodeFunctionData({ abi: roomAbi, functionName: "mint" }), info.seatPrice)}>
            Buy the pass for {bnb(info.seatPrice)}
          </button>
          <p className="trade-foot dim">
            The pass is this wallet's seat and cannot be transferred. If the dev removes you before the launch, or the room has not launched by its
            deadline and you hand the pass back, the full price comes back to this wallet.
          </p>
        </>
      );
    }
  } else if (info.launched) {
    state = "launched";
    body = <p className="trade-note">This room has launched and takes no more members.</p>;
  } else if (refundAvailable) {
    state = "closed";
    body = <p className="trade-note">This room's deadline has passed, so nobody else can be let in.</p>;
  } else if (isDev) {
    state = "dev";
    body = <p className="trade-note">You are this room's dev. To take a seat yourself, let your own wallet in from the dev console, then buy your pass here like every other member.</p>;
  } else if (!signedIn) {
    state = "signin";
    body = (
      <>
        <p className="trade-note">To join, apply to the dev. Applying needs the site to know this wallet is yours: signing in is a message, not a transaction, and costs nothing.</p>
        <SignInButton account={account} label="Sign in to apply" testId="room-apply-signin" />
      </>
    );
  } else {
    state = "apply";
    body = <ApplicationPanel key={account} {...context} account={account} />;
  }

  return (
    <section className="trade-panel room-panel" data-testid="room-seat" data-state={state}>
      <h2>Your seat</h2>
      {!gate && account && mine && mine.owed > 0n && (
        <>
          <p className="trade-note">When this wallet was removed, the room could not deliver its BNB. It is held by the room's contract for this wallet alone.</p>
          <button type="button" className="button trade-go" data-testid="room-withdraw" disabled={working} onClick={() => void act("Collecting", encodeFunctionData({ abi: roomAbi, functionName: "withdraw" }))}>
            Collect {bnb(mine.owed)}
          </button>
        </>
      )}
      {body}
      <TxNote tx={tx} />
    </section>
  );
}

function ApplicationPanel(context: RoomContext & { account: Address }) {
  const { base, data, detail, account, gateText, tick } = context;
  const { info } = data;
  const gated = info.gateToken !== ZERO;
  const mine = useApi(`${base}/application`, 15_000, isMyApplication, tick);
  const held = useHeld(gated ? info.gateToken : null, account);
  const [postUrl, setPostUrl] = useState("");
  const [role, setRole] = useState("");
  const [portfolio, setPortfolio] = useState("");
  const [sending, setSending] = useState(false);
  const [said, setSaid] = useState<Said>(null);
  const [copied, setCopied] = useState<"no" | "yes" | "failed">("no");
  // What was handed in fills the form once, so it can be changed and sent again.
  const filled = useRef(false);
  const stored = mine.state === "ready" ? mine.data.application : null;
  useEffect(() => {
    if (!stored || filled.current) return;
    filled.current = true;
    setPostUrl(stored.postUrl ?? "");
    setRole(stored.role ?? "");
    setPortfolio(stored.portfolio ?? "");
  }, [stored]);

  // What the room asks for is the API's to say: without it the form would ask for the wrong things.
  if (mine.state === "loading" || (!detail && mine.state === "ready")) return <p className="trade-note" role="status">Reading your application…</p>;
  if (mine.state === "error") return <p className="trade-note" role="alert" data-testid="room-apply-error">{mine.error.message}</p>;
  const { code, application } = mine.data;
  if (application?.status === "declined") {
    return <p className="trade-note" data-testid="room-application-declined">The dev declined this wallet's application. Only the dev can reopen it.</p>;
  }
  const wantPost = detail?.room.wantPost === true;
  const wantRole = detail?.room.wantRole === true;
  const heldBefore = toBig(application?.held);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (sending) return;
    setSending(true);
    setSaid(null);
    try {
      const answer = await api<unknown>(`${base}/application`, { body: { ...(wantPost ? { postUrl: postUrl.trim() } : {}), ...(wantRole ? { role: role.trim(), portfolio: portfolio.trim() } : {}) } });
      if (isMyApplication(answer)) mine.set(answer);
      else mine.reload();
      setSaid({ kind: "done", text: "Your application is with the dev. If the dev lets you in, this is where you buy your pass." });
    } catch (cause) {
      // The API's own sentence: it says exactly which requirement was not met.
      setSaid({ kind: "error", text: messageOf(cause) });
    } finally {
      setSending(false);
    }
  };

  return (
    <form className="room-apply" onSubmit={(event) => void submit(event)} data-testid="room-apply" data-applied={application ? "true" : "false"}>
      {application && (
        <div className="room-reading" data-testid="room-application-state">
          <p className="trade-note"><strong>Your application is with the dev.</strong> Sent {ago(application.updatedAt)}. You can change it and send it again.</p>
          {(application.postState !== null || application.holdState !== null) && (
            <ul className="room-needs">
              {application.postState !== null && <li data-state={application.postState}>The post on X: {POST_WORDS[application.postState] ?? application.postState}</li>}
              {application.holdState !== null && <li data-state={application.holdState}>Holdings{heldBefore !== null ? ` (${gateText(heldBefore)} when read)` : ""}: {HOLD_WORDS[application.holdState] ?? application.holdState}</li>}
            </ul>
          )}
        </div>
      )}

      {wantPost && (
        <div className="room-step-block">
          <p className="trade-note"><strong>1. Make a post on X</strong> that includes your personal code. The code ties the post to this wallet and this room.</p>
          {detail && detail.room.postBrief !== "" && <p className="room-brief">{String(detail.room.postBrief)}</p>}
          {detail && typeof detail.room.postPhrase === "string" && detail.room.postPhrase !== "" && (
            <p className="trade-note" data-testid="room-post-phrase">The post must also contain these words: <code className="room-code">{detail.room.postPhrase}</code></p>
          )}
          <div className="room-code-row">
            <code className="room-code" data-testid="room-post-code">{code}</code>
            <button type="button" className="button button-quiet" data-testid="room-copy-code" onClick={() => void copy()}>{copied === "yes" ? "Copied" : "Copy the code"}</button>
          </div>
          {copied === "failed" && <p className="trade-note dim">The browser did not allow copying. Select the code and copy it yourself.</p>}
          <Field label="Link to your post" hint="https://x.com/<you>/status/<number>. The account has to be public.">
            <input name="postUrl" inputMode="url" value={postUrl} onChange={(event) => setPostUrl(event.target.value)} placeholder="https://x.com/…/status/…" autoComplete="off" spellCheck={false} />
          </Field>
        </div>
      )}
      {gated && (
        <p className="trade-note" data-testid="room-apply-holding" data-met={held === null ? undefined : held >= info.gateAmount ? "true" : "false"}>
          {held === null ? `The room needs ${gateText(info.gateAmount)} in this wallet. Reading what it holds…` : `You hold ${gateText(held)}, the room needs ${gateText(info.gateAmount)}.`}{" "}
          <span className="dim">It is checked when you apply, again when the dev lets you in, and by the room's contract itself.</span>
        </p>
      )}
      {wantRole && (
        <div className="room-step-block">
          <p className="trade-note"><strong>{wantPost ? "2. " : ""}Say what you would do in this project.</strong></p>
          {detail && detail.room.roleBrief !== "" && <p className="room-brief">{String(detail.room.roleBrief)}</p>}
          <Field label="Your role"><input name="role" value={role} onChange={(event) => setRole(event.target.value)} maxLength={MAX_ROLE_LENGTH} placeholder="Designer, community lead, developer…" autoComplete="off" /></Field>
          <label className="field">
            <span className="stat-label">Portfolio</span>
            <textarea className="room-text" name="portfolio" rows={4} value={portfolio} onChange={(event) => setPortfolio(event.target.value)} maxLength={MAX_PORTFOLIO_LENGTH} />
            <span className="dim field-hint">What you have done before, with links. Up to {MAX_PORTFOLIO_LENGTH} characters. Only the dev sees it.</span>
          </label>
        </div>
      )}
      {!wantPost && !wantRole && !application && <p className="trade-note">{gated ? "Holding the token is all this room asks for. Ask to join, and the dev decides." : "This room asks for nothing but the dev's yes. Ask to join, and the dev decides."}</p>}
      <div className="actions">
        <button type="submit" className="button" data-testid="room-apply-submit" disabled={sending}>
          {sending ? "Checking and sending…" : application ? "Send again" : wantPost || wantRole ? "Apply" : "Ask to join"}
        </button>
      </div>
      <SaidNote said={said} testId={said?.kind === "error" ? "room-apply-error" : "room-apply-sent"} />
      <p className="trade-foot dim">Applying costs nothing and sends no transaction. You pay for a pass only after the dev has let this wallet in.</p>
    </form>
  );
}

// ── Members ──────────────────────────────────────────────────────────────────

function Members(context: RoomContext & { isDev: boolean }) {
  const { data, detail, isDev } = context;
  const { info } = data;
  /** The member whose tools are open: one at a time. */
  const [open, setOpen] = useState<string | null>(null);
  const members = detail?.members ?? [];
  return (
    <section className="trade-panel room-panel" data-testid="room-members">
      <h2>Members <span className="dim">{info.seated.toString()} / {info.seats.toString()}</span></h2>
      {!detail && <p className="trade-note dim">The member list shows once the site has read the room.</p>}
      {detail && members.length === 0 && <p className="trade-note dim">Nobody holds a pass yet.</p>}
      {members.length > 0 && (
        <ol className="room-member-list">
          {members.map((member) => {
            const wallet = String(member.wallet).toLowerCase();
            const points = Number(member.points) || 0;
            return (
              <li key={wallet} className="room-member" data-testid="room-member" data-wallet={wallet}>
                <div className="room-member-row">
                  <span className="num room-member-seat">#{Number(member.seat) || 0}</span>
                  <a className="room-profile" href={`#/u/${wallet}`}><AuthorName className="room-author" address={wallet} name={member.name} clan={member.clan} /></a>
                  {typeof member.tag === "string" && member.tag !== "" && <span className="tag tag-gold" data-testid="room-member-tag">{member.tag}</span>}
                  <span className="num dim room-member-points" data-testid="room-member-points">{points} {points === 1 ? "pt" : "pts"}</span>
                  {info.launched && member.muted && isDev && <span className="tag tag-muted">Out of the chat</span>}
                  {isDev && (
                    <button type="button" className="button button-quiet room-member-manage" data-testid="room-member-manage" aria-expanded={open === wallet} onClick={() => setOpen(open === wallet ? null : wallet)}>
                      {open === wallet ? "Close" : "Manage"}
                    </button>
                  )}
                </div>
                {isDev && open === wallet && <MemberTools {...context} member={member} />}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/** What the dev can do with one member: points, the project's tag, and removing them (or, after the launch, the chat's door). */
function MemberTools(context: RoomContext & { member: ApiMember }) {
  const { room, base, data, account, signedIn, member, refresh, reloadListing } = context;
  const { info } = data;
  const gate = WalletGate();
  const { tx, act, working } = useRoomAction(room, account, refresh);
  const wallet = String(member.wallet).toLowerCase() as Address;
  const seat = Number(member.seat) || 0;
  const [points, setPoints] = useState("10");
  const [note, setNote] = useState("");
  const [label, setLabel] = useState(member.tag ?? "");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said>(null);
  const [confirming, setConfirming] = useState(false);
  const had = Number(member.points) || 0;
  const left = Math.max(0, MAX_POINTS - had);
  const count = /^\d{1,3}$/.test(points.trim()) ? Number(points.trim()) : 0;

  const post = async (path: string, body: Record<string, unknown>, done: string) => {
    setBusy(true);
    setSaid(null);
    try {
      await api(`${base}/${path}`, { body: { wallet, ...body } });
      setSaid({ kind: "done", text: done });
      reloadListing();
    } catch (cause) {
      // The API's refusal as it is: it says how many points are left, or what is wrong with a tag.
      setSaid({ kind: "error", text: messageOf(cause) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="room-tools" data-testid="room-member-tools">
      {!signedIn && account && (
        <>
          <p className="trade-note dim">Points, tags and the chat's door are kept by the site, so it has to know you are the dev. Signing in costs nothing.</p>
          <SignInButton account={account} label="Sign in to manage members" testId="room-dev-signin-member" />
        </>
      )}
      {signedIn && (
        <>
          <form className="room-inline" data-testid="room-points-form" onSubmit={(event) => { event.preventDefault(); if (!busy && count >= 1 && count <= MAX_POINTS) void post("points", { points: count, note: note.trim() }, `Gave ${plural(count, "point", "points")}.`); }}>
            <Field label={`Points (1 to ${MAX_POINTS})`}><input name="points" inputMode="numeric" value={points} onChange={(event) => setPoints(event.target.value.replace(/\D/g, "").slice(0, 3))} autoComplete="off" /></Field>
            <Field label="What for"><input name="note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={MAX_NOTE_LENGTH} autoComplete="off" /></Field>
            <button type="submit" className="button" data-testid="room-points-give" disabled={busy || count < 1 || count > MAX_POINTS}>Give points</button>
            <p className="trade-foot dim room-inline-wide" data-testid="room-points-left">A member can have {MAX_POINTS} points from this room in all. This one has {had}, so {left} {left === 1 ? "is" : "are"} left to give. Points cannot be taken back.</p>
          </form>
          <form className="room-inline" data-testid="room-tag-form" onSubmit={(event) => { event.preventDefault(); if (!busy && label.trim() !== "") void post("tags", { label: label.trim() }, "Tag saved."); }}>
            <Field label="Tag: what they do in the project"><input name="label" value={label} onChange={(event) => setLabel(event.target.value)} maxLength={MAX_TAG_LENGTH} placeholder="Designer" autoComplete="off" /></Field>
            <button type="submit" className="button" data-testid="room-tag-save" disabled={busy || label.trim() === ""}>Save tag</button>
            {typeof member.tag === "string" && member.tag !== "" && <button type="button" className="button button-quiet" data-testid="room-tag-remove" disabled={busy} onClick={() => void post("tags", { label: null }, "Tag removed.")}>Remove tag</button>}
          </form>
          {info.launched && (
            <div className="room-inline">
              <button type="button" className="button button-quiet" data-testid="room-mute" disabled={busy} onClick={() => void post("mutes", { muted: !member.muted }, member.muted ? "Back in the chat." : "Out of the chat.")}>
                {member.muted ? "Let back in" : "Take out of the chat"}
              </button>
              <p className="trade-foot dim room-inline-wide">After the launch a pass cannot be taken away: this member keeps the pass and its tokens. This only closes or opens the room's chat for them.</p>
            </div>
          )}
          <SaidNote said={said} testId="room-member-said" />
        </>
      )}
      {!info.launched && (
        <div className="room-inline">
          {!confirming && <button type="button" className="button button-warn" data-testid="room-kick" disabled={working} onClick={() => setConfirming(true)}>Remove</button>}
          {confirming && (
            <>
              <p className="trade-note room-inline-wide" data-testid="room-kick-confirm">This burns pass #{seat}, bars the wallet, and sends its {bnb(info.seatPrice)} back. The seat is free again.</p>
              {gate ?? (
                <button type="button" className="button button-warn" data-testid="room-kick-yes" disabled={working} onClick={() => void act("Removing the member", encodeFunctionData({ abi: roomAbi, functionName: "kick", args: [wallet] })).then((done) => done && setConfirming(false))}>
                  Remove {short(wallet)} and send the BNB back
                </button>
              )}
              <button type="button" className="button button-quiet" disabled={working} onClick={() => setConfirming(false)}>Keep the member</button>
            </>
          )}
          <div className="room-inline-wide"><TxNote tx={tx} /></div>
        </div>
      )}
    </div>
  );
}

// ── The private chat ─────────────────────────────────────────────────────────

/** Messages asked for when the chat opens is the API's own page; a poll brings up to this many. */
const POLL_PAGE = 100;
const POLL_MS = 4000;
/** Messages kept on the page; older ones drop off the top. */
const KEPT = 300;
/** Within this many pixels of the bottom, the list counts as following the newest message. */
const FOLLOW_SLACK = 48;

function RoomChat({ base, me }: { base: string; me: string }) {
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  /** The API's sentence when this wallet may not, or may no longer, be here. */
  const [denied, setDenied] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const attached = usePickedPicture(CHAT_PICTURE_SIDE);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  /** True while the list follows the newest message; false once the reader scrolls up. */
  const following = useRef(true);
  /** Asks the room for new messages now. */
  const pollNow = useRef<() => void>(() => undefined);

  useEffect(() => {
    let current = true;
    // The id of the newest message on the page: null until the first page has loaded, 0 for an empty room.
    let lastId: number | null = null;
    let busy = false;
    let again = false;
    setMessages([]);
    setState("loading");
    setDenied(null);
    following.current = true;

    const load = async (): Promise<void> => {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      const after = lastId;
      try {
        const page = (await api<{ messages?: unknown }>(after === null ? `${base}/messages` : `${base}/messages?after=${after}&limit=${POLL_PAGE}`)).messages;
        if (!Array.isArray(page) || !page.every(isMessage)) throw new Error("unexpected response");
        if (!current) return;
        setNow(Date.now());
        setDenied(null);
        if (after !== null && page.length === POLL_PAGE) {
          // More arrived than one poll carries, as after a long time in a background tab: start again from
          // the newest page rather than paging through everything that was missed.
          lastId = null;
          again = true;
          return;
        }
        lastId = page.at(-1)?.id ?? after ?? 0;
        if (after === null) setMessages(page);
        else if (page.length > 0) setMessages((previous) => [...previous, ...page].slice(-KEPT));
        setState("ready");
      } catch (cause) {
        if (!current) return;
        // Not, or no longer, a member: the chat gives way to the API's own sentence.
        if (cause instanceof ApiError && cause.status === 403) setDenied(cause.message);
        // A failed poll is tried again at the next tick. Only a chat that never loaded says so.
        else if (lastId === null) setState((previous) => (previous === "ready" ? previous : "error"));
      } finally {
        busy = false;
        if (again && current) {
          again = false;
          void load();
        }
      }
    };

    const tick = () => {
      if (document.visibilityState !== "visible") return;
      setNow(Date.now());
      void load();
    };
    pollNow.current = () => void load();
    void load();
    const timer = window.setInterval(tick, POLL_MS);
    // Coming back to the tab catches up at once instead of at the next tick.
    document.addEventListener("visibilitychange", tick);
    return () => {
      current = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [base]);

  // The room's pictures are private: each is fetched signed in, once, and shown through an object address
  // that is let go of when the chat closes.
  const pictures = useRef(new Map<string, Promise<string>>());
  const loadPicture = useCallback(
    (hash: string): Promise<string> => {
      const map = pictures.current;
      const known = map.get(hash);
      if (known) return known;
      const made: Promise<string> = apiBlob(`${base}/pictures/${hash}`).then((blob) => {
        const url = URL.createObjectURL(blob);
        // The chat closed while the picture was on its way: nothing will show it.
        if (map.get(hash) !== made) {
          URL.revokeObjectURL(url);
          throw new Error("The chat was closed.");
        }
        return url;
      });
      map.set(hash, made);
      // A picture that failed to load is asked for again the next time it is shown.
      made.catch(() => {
        if (map.get(hash) === made) map.delete(hash);
      });
      return made;
    },
    [base],
  );
  useEffect(() => {
    const map = pictures.current;
    return () => {
      for (const made of map.values()) void made.then((url) => URL.revokeObjectURL(url), () => undefined);
      map.clear();
    };
  }, [base]);

  const follow = useCallback(() => {
    const element = list.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, []);
  // Before the browser paints new messages, move to the newest, unless the reader has scrolled up.
  useLayoutEffect(follow, [messages, follow]);

  const onScroll = () => {
    const element = list.current;
    if (element) following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_SLACK;
  };

  const body = draft.replace(REMOVED, "").trim();
  const closeOpened = useCallback(() => setOpened(null), []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (sending || attached.busy || (body === "" && !attached.picked)) return;
    setError(null);
    setSending(true);
    try {
      let picture: string | null = null;
      if (attached.picked) {
        const { hash } = await api<{ hash?: unknown }>(`${base}/pictures`, { bytes: attached.picked.blob });
        if (typeof hash !== "string" || !HASH.test(hash)) throw new Error("The picture was stored, but the answer was not understood. Try again.");
        picture = hash;
      }
      await api(`${base}/messages`, { body: picture === null ? { body } : { body, picture } });
      setDraft("");
      attached.clear();
      // Ready for the next message: pressing Send took the cursor out of the box.
      input.current?.focus();
      // The poll brings the message back in its place among any that arrived just before it.
      following.current = true;
      pollNow.current();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 403) setDenied(cause.message);
      // Rate limits and the like, as the API says them.
      else setError(messageOf(cause));
    } finally {
      setSending(false);
    }
  };

  if (denied !== null) return <p className="chat-empty" role="alert" data-testid="room-chat-denied">{denied}</p>;

  return (
    <>
      {/* Only new messages are announced: the times tick over without a word. */}
      <div className="chat-list" ref={list} onScroll={onScroll} role="log" aria-label="Messages" aria-relevant="additions" tabIndex={0} data-testid="room-chat-list">
        {messages.length > 0 ? (
          <ol className="chat-messages">
            {messages.map((message) => (
              <li key={message.id} className="chat-message" data-own={message.author === me} data-testid="room-chat-message">
                <span className="chat-meta">
                  <a className="room-profile room-profile-inline" href={`#/u/${message.author}`}><AuthorName className="chat-author" address={message.author} name={message.authorName} clan={message.authorClan} /></a>
                  <time className="chat-time" dateTime={new Date(message.createdAt * 1000).toISOString()}>{ago(message.createdAt, now)}</time>
                </span>
                {message.body !== "" && <span className="chat-body"><Linked text={message.body} /></span>}
                {typeof message.picture === "string" && HASH.test(message.picture) && <ChatPicture hash={message.picture} load={loadPicture} onOpen={setOpened} onReady={follow} />}
              </li>
            ))}
          </ol>
        ) : (
          <p className="chat-empty">
            {state === "loading" && "Loading…"}
            {state === "error" && "The chat could not be reached. Trying again shortly."}
            {state === "ready" && "No messages yet. Say hello to the room."}
          </p>
        )}
      </div>

      {attached.picked && (
        <div className="room-attached" data-testid="room-chat-attached">
          <img src={attached.picked.url} alt="The picture you are about to post" />
          <button type="button" className="button button-quiet" disabled={sending} onClick={attached.clear}>Remove picture</button>
        </div>
      )}
      <form className="chat-form room-chat-form" onSubmit={(event) => void submit(event)} data-testid="room-chat-form">
        <label className="chat-input">
          <span className="visually-hidden">Message</span>
          <input ref={input} type="text" name="message" value={draft} maxLength={MAX_MESSAGE_LENGTH} placeholder="Message the room" autoComplete="off" enterKeyHint="send" readOnly={sending} onChange={(event) => setDraft(event.target.value)} />
        </label>
        <label className="button button-quiet chat-send room-file" data-testid="room-chat-add-picture">
          {attached.busy ? "Preparing…" : "Add picture"}
          <input className="room-file-input" type="file" name="picture" accept={PICTURE_ACCEPT} data-testid="room-chat-picture-input" disabled={sending || attached.busy} onChange={(event) => void attached.pick(event)} />
        </label>
        <button type="submit" className="button chat-send" data-testid="room-chat-send" disabled={sending || attached.busy || (body === "" && !attached.picked)}>{sending ? "Sending…" : "Send"}</button>
      </form>
      {(error ?? attached.error) && <p className="chat-error" role="alert" data-testid="room-chat-error">{error ?? attached.error}</p>}
      <p className="chat-notice">Only the dev and the wallets holding this room's pass can read this. Links open in a new tab: check where one goes before you sign anything there. Nothing in chat is advice.</p>
      {opened !== null && <PictureOverlay url={opened} onClose={closeOpened} />}
    </>
  );
}

function ChatPicture({ hash, load, onOpen, onReady }: { hash: string; load(hash: string): Promise<string>; onOpen(url: string): void; onReady(): void }) {
  const [shown, setShown] = useState<{ url: string } | "loading" | "error">("loading");
  useEffect(() => {
    let current = true;
    setShown("loading");
    load(hash).then(
      (url) => current && setShown({ url }),
      () => current && setShown("error"),
    );
    return () => {
      current = false;
    };
  }, [hash, load]);
  if (shown === "loading") return <span className="room-chat-wait dim">Loading the picture…</span>;
  if (shown === "error") return <span className="room-chat-wait dim">The picture could not be loaded.</span>;
  return (
    <button type="button" className="room-chat-picture" data-testid="room-chat-picture" aria-label="Open the picture full size" onClick={() => onOpen(shown.url)}>
      <img src={shown.url} alt="Picture posted in the room" onLoad={onReady} />
    </button>
  );
}

function PictureOverlay({ url, onClose }: { url: string; onClose(): void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Drawn on the page's own body: inside the chat, which stays in view while the page scrolls, it would sit
  // under the site's bars.
  return createPortal(
    <div className="room-overlay" role="dialog" aria-modal="true" aria-label="Picture, full size" data-testid="room-picture-overlay" onClick={onClose}>
      <img src={url} alt="Picture posted in the room, full size" />
      <button type="button" className="button button-quiet room-overlay-close" autoFocus onClick={onClose}>Close</button>
    </div>,
    document.body,
  );
}

// ── The dev console ──────────────────────────────────────────────────────────

function DevConsole(context: RoomContext) {
  const { data, account, signedIn } = context;
  const { info, refundAvailable } = data;
  const gate = WalletGate();
  return (
    <section className="room-dev" data-testid="room-dev" aria-label="Dev console">
      <div className="section-head"><h2>Dev console</h2></div>
      <p className="trade-note dim">Only you see this: the connected wallet created this room. Every change to who is in the room is a transaction this wallet signs.</p>
      {gate && <div className="actions">{gate}</div>}
      <Launch {...context} ready={gate === null} />
      {!signedIn && account && (
        <section className="trade-panel room-panel">
          <h2>Applications and settings</h2>
          <p className="trade-note">Applications and the room's description are kept by the site, so it has to know you are the dev. Signing in is a message, not a transaction: it costs nothing.</p>
          <SignInButton account={account} label="Sign in as the dev" testId="room-dev-signin" />
        </section>
      )}
      {signedIn && <Applications {...context} ready={gate === null} open={!info.launched && !refundAvailable} />}
      <Door {...context} ready={gate === null} open={!info.launched && !refundAvailable} />
      {signedIn && <Settings {...context} />}
    </section>
  );
}

function Launch(context: RoomContext & { ready: boolean }) {
  const { room, data, detail, account, ready, refresh } = context;
  const { info, refundAvailable } = data;
  const { tx, act, working } = useRoomAction(room, account, refresh);
  const symbol = detail ? String(detail.room.symbol) : cleanLine(info.tokenSymbol);
  const full = info.seated === info.seats;
  const free = info.seats - info.seated;
  const fee = (info.raised * BigInt(info.launchFeeBps)) / 10_000n;
  return (
    <section className="trade-panel room-panel" data-testid="room-launch" data-ready={!info.launched && full ? "true" : "false"}>
      <h2>Launch</h2>
      {info.launched ? (
        <p className="trade-note">The room has launched. Nobody can be removed any more, and every pass claims its tokens.</p>
      ) : (
        <>
          <p className="trade-note">
            Launching creates the token, sends {info.launchFeeBps === 0 ? "no fee" : `${info.launchFeeBps / 100}% of the raise${full ? ` (${bnb(fee)})` : ""}`} to the CallZ vault,
            and puts the rest{full ? ` (${bnb(info.raised - fee)})` : ""} with {info.poolShareBps / 100}% of the supply into a PancakeSwap pool. The pool's LP tokens go to the dead
            address, so the liquidity is locked forever. Every pass can then claim {units(info.tokensPerSeat, 18, 2)} {symbol}. A launch cannot be undone, and after it nobody can be removed.
          </p>
          {!full && <p className="trade-note" data-testid="room-launch-waiting">{plural(free, "seat is", "seats are")} still free. The room launches only when every seat is taken.</p>}
          {full && refundAvailable && <p className="trade-note">The deadline has passed: until you launch, any member can hand their pass back, and a room that loses a member cannot fill up again.</p>}
          <button type="button" className="button trade-go" data-testid="room-launch-button" disabled={!ready || !full || working} onClick={() => void act("Launching", encodeFunctionData({ abi: roomAbi, functionName: "launch" }))}>
            Launch the token
          </button>
        </>
      )}
      <TxNote tx={tx} />
    </section>
  );
}

/** How an applicant stands in the room, by the room's own contract as the API read it. */
function standingWords(standing: ApiStanding | null): { key: string; text: string } {
  if (!standing) return { key: "unread", text: "standing not read" };
  if (standing.banned) return { key: "barred", text: "barred" };
  if (standing.seat > 0) return { key: "member", text: `member, pass #${standing.seat}` };
  if (standing.admitted) return { key: "admitted", text: "let in, has not bought" };
  return { key: "waiting", text: "waiting" };
}

function Applications(context: RoomContext & { ready: boolean; open: boolean }) {
  const { room, base, data, detail, account, gateText, tick, ready, open, refresh } = context;
  const { info } = data;
  const gated = info.gateToken !== ZERO;
  const wantPost = detail?.room.wantPost === true;
  const list = useApi(`${base}/applications`, 15_000, isApplicationList, tick);
  const { tx, act, working } = useRoomAction(room, account, refresh);
  /** The applicant the API is being asked about. */
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, { kind: "done" | "error"; text: string; openPost?: boolean }>>({});
  /** Applicants whose post the dev says they opened themselves, when X could not be asked. */
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const now = useNow(30_000);
  const applications = list.state === "ready" ? list.data.applications : [];

  const replace = (fresh: Application) => {
    if (list.state === "ready") list.set({ applications: list.data.applications.map((entry) => (entry.wallet === fresh.wallet ? fresh : entry)) });
  };
  const say = (wallet: string, note: { kind: "done" | "error"; text: string; openPost?: boolean } | null) =>
    setNotes((previous) => {
      const next = { ...previous };
      if (note) next[wallet] = note;
      else delete next[wallet];
      return next;
    });

  /** Which of the room's requirements `application` does not meet, by what was just read. */
  const unmet = (application: Application): string[] => {
    const missing: string[] = [];
    if (wantPost && application.postState !== "ok") missing.push(`The post on X: ${application.postUrl ? (POST_WORDS[application.postState ?? ""] ?? "it was not read.") : "no post was handed in."}`);
    if (gated && application.holdState !== "ok") {
      const held = toBig(application.held);
      missing.push(`Holdings: ${held !== null ? `holds ${gateText(held)}, the room needs ${gateText(info.gateAmount)}.` : (HOLD_WORDS[application.holdState ?? ""] ?? "they were not read.")}`);
    }
    return missing;
  };

  /** Asks the API to do `action` to an application, and puts its answer on the page. Null when it did not go through. */
  const review = async (wallet: string, action: "check" | "decline" | "reopen"): Promise<{ application: Application; ready: boolean } | null> => {
    setBusy(wallet);
    say(wallet, null);
    try {
      const answer = await api<{ application?: unknown; ready?: unknown }>(`${base}/applications/${wallet}`, { body: { action } });
      if (!isApplication(answer.application)) throw new Error("The application could not be read back. Try again.");
      replace(answer.application);
      return { application: answer.application, ready: answer.ready === true };
    } catch (cause) {
      say(wallet, { kind: "error", text: messageOf(cause) });
      return null;
    } finally {
      setBusy(null);
    }
  };

  const check = async (wallet: string) => {
    const read = await review(wallet, "check");
    if (!read) return;
    if (read.ready) say(wallet, { kind: "done", text: "Everything this room asks for is met right now." });
    else say(wallet, { kind: "error", text: unmet(read.application).join(" ") || "The requirements are not met right now." });
  };

  const letIn = async (wallet: string) => {
    // Always read again first: a wallet is let in on what is true now, not on what was true when it applied.
    const read = await review(wallet, "check");
    if (!read) return;
    if (!read.ready) {
      const fresh = read.application;
      const holdMet = !gated || fresh.holdState === "ok";
      // The one case the dev may settle by eye: X could not be asked, and everything else is met.
      const onlyPostUnread = wantPost && fresh.postState === "unreachable" && holdMet && fresh.postUrl !== null;
      if (!onlyPostUnread) {
        say(wallet, { kind: "error", text: `Not let in. ${unmet(fresh).join(" ") || "The requirements are not met right now."}` });
        return;
      }
      if (confirmed[wallet] !== true) {
        say(wallet, { kind: "error", text: "X could not be asked. Open the post yourself.", openPost: true });
        return;
      }
    }
    const done = await act("Letting the wallet in", encodeFunctionData({ abi: roomAbi, functionName: "admit", args: [[wallet as Address]] }));
    if (done) {
      say(wallet, { kind: "done", text: "Let in. This wallet can now buy its pass." });
      setConfirmed((previous) => ({ ...previous, [wallet]: false }));
    }
  };

  const decide = async (wallet: string, action: "decline" | "reopen") => {
    const read = await review(wallet, action);
    if (read) say(wallet, { kind: "done", text: action === "decline" ? "Declined. The applicant cannot apply again unless you reopen it." : "Reopened." });
  };

  return (
    <section className="trade-panel room-panel" data-testid="room-applications">
      <h2>Applications {list.state === "ready" && <span className="dim">{applications.length}</span>}</h2>
      {list.state === "loading" && <p className="trade-note" role="status">Loading the applications…</p>}
      {list.state === "error" && <p className="trade-note" role="alert">{list.error.message}</p>}
      {list.state === "ready" && applications.length === 0 && <p className="trade-note dim">Nobody has applied yet.</p>}
      {!open && applications.length > 0 && <p className="trade-note">{info.launched ? "The room has launched" : "The deadline has passed"}, so nobody else can be let in.</p>}
      <TxNote tx={tx} />
      {applications.length > 0 && (
        <ol className="room-apps">
          {applications.map((application) => {
            const wallet = String(application.wallet).toLowerCase();
            const standing = standingWords(application.standing);
            const note = notes[wallet];
            const held = toBig(application.held);
            const post = application.postUrl !== null && POST_URL.test(application.postUrl) ? application.postUrl : null;
            const pending = application.status === "pending";
            const waiting = standing.key === "waiting" || standing.key === "unread";
            const idle = busy === null && !working;
            return (
              <li key={wallet} className="room-app" data-testid="room-application" data-wallet={wallet} data-status={application.status} data-standing={standing.key}>
                <div className="room-app-head">
                  <a className="room-profile" href={`#/u/${wallet}`}><AuthorName className="room-author" address={wallet} name={application.name} clan={application.clan} /></a>
                  <span className={`tag tag-${standing.key === "member" ? "good" : standing.key === "admitted" ? "gold" : "muted"}`} data-testid="room-application-standing">{standing.text}</span>
                  {!pending && <span className="tag tag-muted">declined</span>}
                  <span className="dim room-app-time">applied {ago(application.createdAt, now)}</span>
                </div>
                <dl className="trade-quote room-app-facts">
                  {(wantPost || application.postUrl !== null) && (
                    <div>
                      <dt>Post on X</dt>
                      <dd data-state={application.postState ?? undefined}>
                        {post !== null ? <a href={post} target="_blank" rel="noopener noreferrer nofollow">{post} ↗</a> : (application.postUrl ?? "None handed in.")}{" "}
                        {application.postState !== null && <span className="dim">{POST_WORDS[application.postState] ?? application.postState}</span>}
                      </dd>
                    </div>
                  )}
                  {gated && (
                    <div>
                      <dt>Holdings</dt>
                      <dd data-state={application.holdState ?? undefined}>
                        {held !== null ? `Holds ${gateText(held)}, needs ${gateText(info.gateAmount)}.` : `Needs ${gateText(info.gateAmount)}.`}{" "}
                        {application.holdState !== null && <span className="dim">{HOLD_WORDS[application.holdState] ?? application.holdState}</span>}
                      </dd>
                    </div>
                  )}
                  {application.role !== null && <div><dt>Role</dt><dd>{application.role}</dd></div>}
                  {application.portfolio !== null && <div><dt>Portfolio</dt><dd className="room-app-text"><Linked text={application.portfolio} /></dd></div>}
                  {typeof application.checkedAt === "number" && application.checkedAt > 0 && <div><dt>Last checked</dt><dd>{ago(application.checkedAt, now)}</dd></div>}
                </dl>
                {note?.openPost && post !== null && (
                  <div className="room-app-confirm" data-testid="room-application-open-post">
                    <a className="button button-quiet" href={post} target="_blank" rel="noopener noreferrer nofollow">Open the post ↗</a>
                    <label className="room-toggle">
                      <input type="checkbox" className="room-check" data-testid="room-application-confirm-post" checked={confirmed[wallet] === true} onChange={(event) => setConfirmed((previous) => ({ ...previous, [wallet]: event.target.checked }))} />
                      <span>I opened the post and it is still up</span>
                    </label>
                  </div>
                )}
                <div className="actions">
                  <button type="button" className="button button-quiet" data-testid="room-application-check" disabled={!idle} onClick={() => void check(wallet)}>{busy === wallet ? "Checking…" : "Check now"}</button>
                  {pending && waiting && open && (
                    <button type="button" className="button" data-testid="room-application-admit" disabled={!idle || !ready || (note?.openPost === true && confirmed[wallet] !== true)} onClick={() => void letIn(wallet)}>Let in</button>
                  )}
                  {standing.key === "admitted" && (
                    <button type="button" className="button button-quiet" data-testid="room-application-revoke" disabled={!idle || !ready} onClick={() => void act("Taking the invite back", encodeFunctionData({ abi: roomAbi, functionName: "revoke", args: [[wallet as Address]] }))}>Take the invite back</button>
                  )}
                  {pending && standing.key !== "member" && <button type="button" className="button button-warn" data-testid="room-application-decline" disabled={!idle} onClick={() => void decide(wallet, "decline")}>Decline</button>}
                  {!pending && <button type="button" className="button button-quiet" data-testid="room-application-reopen" disabled={!idle} onClick={() => void decide(wallet, "reopen")}>Reopen</button>}
                </div>
                {standing.key === "barred" && <p className="trade-foot dim">This wallet is barred from the room. Lift the bar below before letting it in.</p>}
                {note && <p className={`trade-outcome trade-${note.kind}`} role={note.kind === "error" ? "alert" : "status"} data-testid="room-application-note">{note.text}</p>}
              </li>
            );
          })}
        </ol>
      )}
      <p className="trade-foot dim">
        Letting a wallet in reads every requirement again first, and sends nothing when one is not met.{gated ? " Whatever this page says, the room's contract itself refuses a wallet that does not hold the required token." : ""}
      </p>
    </section>
  );
}

/** Letting a wallet in by its address, and barring a wallet that is not a member. */
function Door(context: RoomContext & { ready: boolean; open: boolean }) {
  const { room, data, account, ready, open, refresh } = context;
  const { info } = data;
  const gated = info.gateToken !== ZERO;
  const admitting = useRoomAction(room, account, refresh);
  const barring = useRoomAction(room, account, refresh);
  const [admitted, setAdmitted] = useState("");
  const [barred, setBarred] = useState("");
  const admitAddress = isAddress(admitted.trim()) ? (admitted.trim() as Address) : null;
  const barAddress = isAddress(barred.trim()) ? (barred.trim() as Address) : null;

  const admit = async (event: FormEvent) => {
    event.preventDefault();
    if (!admitAddress || admitting.working) return;
    if (await admitting.act("Letting the wallet in", encodeFunctionData({ abi: roomAbi, functionName: "admit", args: [[admitAddress]] }))) setAdmitted("");
  };
  const setBanned = async (banned: boolean) => {
    if (!barAddress || barring.working) return;
    if (await barring.act(banned ? "Barring the wallet" : "Lifting the bar", encodeFunctionData({ abi: roomAbi, functionName: "setBanned", args: [barAddress, banned] }))) setBarred("");
  };

  return (
    <>
      <section className="trade-panel room-panel">
        <h2>Let a wallet in directly</h2>
        {open ? (
          <form className="room-inline" onSubmit={(event) => void admit(event)} data-testid="room-admit-form">
            <Field label="Wallet address"><input name="wallet" value={admitted} onChange={(event) => setAdmitted(event.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false} /></Field>
            <button type="submit" className="button" data-testid="room-admit" disabled={!ready || !admitAddress || admitting.working}>Let in</button>
            {account && <button type="button" className="button button-quiet" data-testid="room-admit-self" onClick={() => setAdmitted(account)}>Use my wallet</button>}
          </form>
        ) : (
          <p className="trade-note">{info.launched ? "The room has launched" : "The deadline has passed"}, so nobody else can be let in.</p>
        )}
        <p className="trade-foot dim">
          No application needed: the wallet can buy its pass as soon as this confirms. It is also how you take a seat yourself.
          {gated ? " The holding requirement still applies: the room's contract refuses a wallet that does not hold enough of the token." : ""}
        </p>
        <TxNote tx={admitting.tx} />
      </section>

      <section className="trade-panel room-panel">
        <h2>Bar a wallet that is not a member</h2>
        {info.launched ? (
          <p className="trade-note">The room has launched: nobody can be barred or removed any more.</p>
        ) : (
          <form className="room-inline" onSubmit={(event) => { event.preventDefault(); void setBanned(true); }} data-testid="room-ban-form">
            <Field label="Wallet address"><input name="wallet" value={barred} onChange={(event) => setBarred(event.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false} /></Field>
            <button type="submit" className="button button-warn" data-testid="room-ban" disabled={!ready || !barAddress || barring.working}>Bar this wallet</button>
            <button type="button" className="button button-quiet" data-testid="room-unban" disabled={!ready || !barAddress || barring.working} onClick={() => void setBanned(false)}>Lift the bar</button>
          </form>
        )}
        <p className="trade-foot dim">A barred wallet cannot be let in or buy a pass, and an invite it already had is taken back. Lifting the bar also works for a member you removed. To remove a member, use Remove in the member list: that sends their BNB back.</p>
        <TxNote tx={barring.tx} />
      </section>
    </>
  );
}

function Settings(context: RoomContext) {
  const { room, detail, reloadListing } = context;
  const address = room.toLowerCase();
  // What was typed when the room was created, when the API could not store it then.
  const unsaved = unsavedSettings?.room === address ? unsavedSettings : null;
  const [form, setForm] = useState(() => ({
    about: unsaved?.about ?? detail?.room.about ?? "",
    wantPost: unsaved?.wantPost ?? detail?.room.wantPost === true,
    postBrief: unsaved?.postBrief ?? detail?.room.postBrief ?? "",
    postPhrase: detail?.room.postPhrase ?? "",
    wantRole: unsaved?.wantRole ?? detail?.room.wantRole === true,
    roleBrief: unsaved?.roleBrief ?? detail?.room.roleBrief ?? "",
  }));
  const [pending, setPending] = useState(unsaved !== null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said>(null);
  // The API's copy fills the form once, when it arrives after the form was drawn. What the dev typed stays.
  const filled = useRef(unsaved !== null || detail !== null);
  useEffect(() => {
    if (filled.current || !detail) return;
    filled.current = true;
    setForm({ about: detail.room.about ?? "", wantPost: detail.room.wantPost === true, postBrief: detail.room.postBrief ?? "", postPhrase: detail.room.postPhrase ?? "", wantRole: detail.room.wantRole === true, roleBrief: detail.room.roleBrief ?? "" });
  }, [detail]);

  const problems: string[] = [];
  if (lengthOf(form.about.trim()) > MAX_ABOUT_LENGTH) problems.push(`About: at most ${MAX_ABOUT_LENGTH} characters.`);
  if (form.wantPost && lengthOf(form.postBrief.trim()) > MAX_BRIEF_LENGTH) problems.push(`What the post should say: at most ${MAX_BRIEF_LENGTH} characters.`);
  if (form.wantRole && lengthOf(form.roleBrief.trim()) > MAX_BRIEF_LENGTH) problems.push(`Who you are looking for: at most ${MAX_BRIEF_LENGTH} characters.`);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || problems.length > 0) return;
    setBusy(true);
    setSaid(null);
    try {
      await api("/api/rooms", { body: { room: address, about: form.about.trim(), wantPost: form.wantPost, postBrief: form.wantPost ? form.postBrief.trim() : "", postPhrase: form.wantPost ? form.postPhrase.trim() : "", wantRole: form.wantRole, roleBrief: form.wantRole ? form.roleBrief.trim() : "" } });
      if (unsavedSettings?.room === address) unsavedSettings = null;
      setPending(false);
      setSaid({ kind: "done", text: "Saved." });
      reloadListing();
    } catch (cause) {
      setSaid({ kind: "error", text: messageOf(cause) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="trade-panel room-panel" data-testid="room-settings">
      <h2>Room settings</h2>
      {pending && unsaved && <p className="trade-outcome trade-error" role="alert" data-testid="room-settings-unsaved">The room is on BNB Chain, but its description was not saved: {unsaved.reason} What you typed is below. Save it here.</p>}
      <form className="room-settings-form" onSubmit={(event) => void save(event)}>
        <label className="field">
          <span className="stat-label">About</span>
          <textarea className="room-text" name="about" rows={4} value={form.about} maxLength={MAX_ABOUT_LENGTH} onChange={(event) => setForm((previous) => ({ ...previous, about: event.target.value }))} />
        </label>
        <fieldset className="room-requirement">
          <label className="room-toggle"><input type="checkbox" name="wantPost" checked={form.wantPost} onChange={(event) => setForm((previous) => ({ ...previous, wantPost: event.target.checked }))} /><span>Applicants make a post on X</span></label>
          {form.wantPost && (<>
            <label className="field">
              <span className="stat-label">What should the post say?</span>
              <textarea className="room-text" name="postBrief" rows={3} value={form.postBrief} maxLength={MAX_BRIEF_LENGTH} onChange={(event) => setForm((previous) => ({ ...previous, postBrief: event.target.value }))} />
            </label>
            <label className="field">
              <span className="stat-label">Words the post must contain</span>
              <input name="postPhrase" value={form.postPhrase} maxLength={MAX_PHRASE_LENGTH} autoComplete="off" onChange={(event) => setForm((previous) => ({ ...previous, postPhrase: event.target.value }))} />
              <span className="dim field-hint">Optional. The site checks with X that the post contains exactly these words, in any capitals.</span>
            </label>
          </>)}
        </fieldset>
        <fieldset className="room-requirement">
          <label className="room-toggle"><input type="checkbox" name="wantRole" checked={form.wantRole} onChange={(event) => setForm((previous) => ({ ...previous, wantRole: event.target.checked }))} /><span>Applicants state a role and show a portfolio</span></label>
          {form.wantRole && (
            <label className="field">
              <span className="stat-label">Who are you looking for?</span>
              <textarea className="room-text" name="roleBrief" rows={3} value={form.roleBrief} maxLength={MAX_BRIEF_LENGTH} onChange={(event) => setForm((previous) => ({ ...previous, roleBrief: event.target.value }))} />
            </label>
          )}
        </fieldset>
        {problems.length > 0 && <ul className="form-problems">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
        <div className="actions"><button type="submit" className="button" data-testid="room-settings-save" disabled={busy || problems.length > 0}>{busy ? "Saving…" : "Save settings"}</button></div>
      </form>
      <SaidNote said={said} testId="room-settings-said" />
      <p className="trade-foot dim">These can be changed at any time. Everything else about the room, the holding requirement included, is fixed in its contract.</p>
    </section>
  );
}

export default function RoomsSection({ route, mobile }: { route: RoomsRoute; mobile: boolean }) {
  if (route.name === "room-create") return <CreatePage />;
  if (route.name === "room") return <RoomPage key={route.address} address={route.address} mobile={mobile} />;
  if (route.name === "launched") return <LaunchedPage />;
  return <RoomsHome />;
}
