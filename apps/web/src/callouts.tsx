// Callouts: links to posts on X, pump.fun or fomo.family that call a token out, kept by this site's Worker
// under /api/callouts (apps/worker/src/callouts.ts). Nobody logs in: the wallet signs each callout with
// personal_sign. A reviewer wallet approves a callout by signing the attestation the rewards vault checks.
// Where the Worker has a gas wallet it takes that attestation to the vault itself, and the author confirms
// nothing; where it has none, or has not managed to within a few minutes, the author's own wallet can.
//
// A callout is a holder's. The Worker records what the wallet held and the token's market cap when it was
// posted, and keeps reading the balance: each card says whether the wallet still holds, has sold part, or
// has closed the position, and at what market cap.
//
// A link on this page is never the text somebody typed. The Worker rebuilds every link in one canonical
// spelling, and this page runs the same rules over what the Worker returns before it becomes an address to
// click: a link that does not come out identical is not shown as a link at all.
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { createWalletClient, custom, keccak256, parseAbi, toBytes, type Address, type Hex } from "viem";
import { bsc } from "viem/chains";
import { AuthorName, useDisplayName } from "./display-name";
import { ago, amount, short, usd } from "./format";
import { VAULT, currentEpoch, epochEnd, recordCallout, recordedLinks, submissionTypedData, type Submission } from "./rewards";
import { SITES } from "./site";
import { TradeError, client } from "./trade";
import { connect, personalSign, switchChain, useWallet } from "./wallet";
import "./callouts.css";

const API = "/api/callouts/bsc";
const MAX_LINK_LENGTH = 300;
const MAX_NOTE_LENGTH = 140;
const FEED_PAGE = 30;
const POLL_MS = 20_000;
/** A device clock further than this from the server's is corrected for; anything less is network delay. */
const CLOCK_SLACK_MS = 30_000;
const ZERO_HASH: Hex = `0x${"00".repeat(32)}`;

const KIND_X = 0;
const KIND_PUMP = 1;
const KIND_FOMO = 2;
type CalloutKind = typeof KIND_X | typeof KIND_PUMP | typeof KIND_FOMO;
const SITE_NAMES: Record<CalloutKind, string> = { [KIND_X]: "X", [KIND_PUMP]: "pump.fun", [KIND_FOMO]: "fomo.family" };

// ── Links ────────────────────────────────────────────────────────────────

type CalloutLink = { ok: true; kind: CalloutKind; url: string; profile: string };
type ParsedCalloutLink = CalloutLink | { ok: false; error: string };

const refused = (error: string): ParsedCalloutLink => ({ ok: false, error });

const NOT_ACCEPTED = "Only https links to a post on x.com, a callout on pump.fun or a trade on fomo.family are accepted.";
const PUMP_OTHER_CONTRACT = "This pump.fun callout is for a different contract, so it cannot earn rewards here.";
const FOMO_OTHER_CONTRACT = "This fomo.family callout is for a different contract, so it cannot earn rewards here.";
const FOMO_SHARE_LINK = "Share the link of your trade on fomo.family: it carries your name and the trade.";

const X_HOSTS = new Set(["x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"]);
const PUMP_HOSTS = new Set(["pump.fun", "www.pump.fun"]);
const FOMO_HOSTS = new Set(["fomo.family", "www.fomo.family"]);

/** Scheme, host, path, query. The fragment is dropped. A host with a port or a "user@" part matches no accepted host. */
const LINK = /^https:\/\/([^/?#]+)(\/[^?#]*)?(?:\?([^#]*))?(?:#.*)?$/i;
/** Anything after the post's id ("/photo/1") is ignored. */
const X_PATH = /^\/([A-Za-z0-9_]{1,15})\/status\/([0-9]{1,25})(?:\/.*)?$/;
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const PUMP_PATH = new RegExp(`^/callouts/(0x[0-9a-fA-F]{40})/(${UUID})$`);
const FOMO_PATH = /^\/tokens\/bnb\/(0x[0-9a-fA-F]{40})$/;
const FOMO_TRADE = new RegExp(`^${UUID}$`);
const FOMO_NAME = /^[A-Za-z0-9_.-]{1,40}$/;

/** The value of `name` in a query string, as written. Null when it is absent or given more than once. */
function queryValue(query: string, name: string): string | null {
  let found: string | null = null;
  for (const part of query.split("&")) {
    const at = part.indexOf("=");
    if ((at === -1 ? part : part.slice(0, at)) !== name) continue;
    if (found !== null) return null;
    found = at === -1 ? "" : part.slice(at + 1);
  }
  return found;
}

/**
 * Takes a pasted link apart and rebuilds it in its one canonical spelling, or says why it is not accepted.
 * `token` is the address the callout is posted under: a pump.fun or fomo.family link names a contract, and it
 * must be that one. Nothing here follows the link or decodes it: a link either has exactly the accepted shape
 * in plain ASCII, or it is refused.
 * Keep in sync with `parseCalloutLink` in apps/worker/src/callouts.ts: the Worker applies the same rules, and
 * its tests (apps/worker/test/callouts.test.ts) are the tests of these.
 */
export function parseCalloutLink(raw: string, token: string): ParsedCalloutLink {
  if (typeof raw !== "string") return refused(NOT_ACCEPTED);
  const text = raw.trim();
  if (text.length === 0) return refused("Paste the link to your callout.");
  if (text.length > MAX_LINK_LENGTH) return refused(`The link is longer than ${MAX_LINK_LENGTH} characters.`);
  // Visible ASCII only: no spaces, no control characters, no letters from other scripts made to look like these.
  if (!/^[\x21-\x7E]+$/.test(text) || text.includes("\\")) return refused(NOT_ACCEPTED);
  const match = LINK.exec(text);
  if (!match) return refused(NOT_ACCEPTED);
  const host = match[1]!.toLowerCase();
  const path = match[2] ?? "/";
  const query = match[3] ?? "";

  if (X_HOSTS.has(host)) {
    const post = X_PATH.exec(path);
    if (!post) return refused("Link to the post itself: https://x.com/<name>/status/<number>.");
    const user = post[1]!.toLowerCase();
    return { ok: true, kind: KIND_X, url: `https://x.com/${user}/status/${post[2]!}`, profile: `x:${user}` };
  }

  if (PUMP_HOSTS.has(host)) {
    const callout = PUMP_PATH.exec(path);
    if (!callout) return refused("Link to the callout itself: https://pump.fun/callouts/<contract>/<id>.");
    const contract = callout[1]!.toLowerCase();
    if (contract !== token.toLowerCase()) return refused(PUMP_OTHER_CONTRACT);
    return { ok: true, kind: KIND_PUMP, url: `https://pump.fun/callouts/${contract}/${callout[2]!.toLowerCase()}`, profile: "" };
  }

  if (FOMO_HOSTS.has(host)) {
    const page = FOMO_PATH.exec(path);
    if (!page) return refused(FOMO_SHARE_LINK);
    const contract = page[1]!.toLowerCase();
    if (contract !== token.toLowerCase()) return refused(FOMO_OTHER_CONTRACT);
    const name = queryValue(query, "r");
    const trade = queryValue(query, "tradeId");
    if (name === null || trade === null || !FOMO_NAME.test(name) || !FOMO_TRADE.test(trade)) return refused(FOMO_SHARE_LINK);
    // The trade is what makes the callout one of a kind, the name is whose it is. Every other parameter is dropped.
    return {
      ok: true,
      kind: KIND_FOMO,
      url: `https://fomo.family/tokens/bnb/${contract}?r=${name}&tradeId=${trade.toLowerCase()}`,
      profile: `fomo:${name.toLowerCase()}`,
    };
  }

  return refused(NOT_ACCEPTED);
}

// ── Text ─────────────────────────────────────────────────────────────────

/**
 * Characters that never reach a note: control characters (which include tabs and line breaks), zero-width
 * and text-direction marks, and unpaired surrogates, which are not text at all.
 */
const REMOVED = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩\uD800-\uDFFF]/gu;

/**
 * A note as it is signed, stored and shown: one line, with nothing invisible in it.
 * Keep in sync with `cleanBody` in apps/worker/src/chat.ts: the Worker verifies the text this produces.
 */
function cleanBody(raw: string): string {
  return raw.replace(REMOVED, "").trim();
}

/**
 * Top-level domains for which a bare "name.tld" counts as a link. Anything with a scheme ("https://", "tg://"),
 * a "www." or a numeric address is caught without this list.
 */
const LINK_TLDS =
  "com|net|org|io|co|xyz|fun|me|gg|app|ai|dev|sh|to|tv|cc|ly|link|site|online|top|club|vip|pro|info|biz|finance|exchange|money|trade|bet|win|lol|wtf|meme|family|network|page|store|live|life|world|tech|cloud|social|chat|group|team|zone|art|run|one|xxx|ru|cn|uk|us|eu|de|fr|jp|kr|in|id|vn|th|ph|tr|br|ua|pl|nl|es|it|ca|au|sg|hk|tw|im|is|ws|bz|ag|la|pw|tk|ml|ga|cf|gq|eth|bnb|sol|crypto|nft|dao";
const LINK_PATTERNS = [
  /[a-z][a-z0-9+.-]{1,15}:\/\//i,
  /(?:^|[^a-z0-9])www\./i,
  /(?:^|[^0-9])\d{1,3}(?:\.\d{1,3}){3}(?:[^0-9]|$)/,
  new RegExp(`(?:^|[^a-z0-9-])[a-z0-9-]{1,63}\\.(?:${LINK_TLDS})(?:[^a-z0-9-]|$)`, "i"),
];

/**
 * True when a note carries a link, written plainly or dressed up ("example[.]com", "example dot com",
 * a full-width dot). The only link in a callout is the one in its own box, which is checked.
 * Keep in sync with `containsLink` in apps/worker/src/chat.ts.
 */
function containsLink(body: string): boolean {
  const plain = body
    .replace(/[。．｡․]/g, ".")
    .replace(/\s*[\[({]\s*(?:\.|dot)\s*[\])}]\s*/gi, ".")
    .replace(/\s+dot\s+/gi, ".");
  return LINK_PATTERNS.some((pattern) => pattern.test(plain));
}

/**
 * The exact text the wallet signs for one callout. `url` is the canonical link, `note` the cleaned note,
 * `issuedAt` unix seconds.
 * Keep in sync with `calloutSigningText` in apps/worker/src/callouts.ts: one character of difference and no signature verifies.
 */
function calloutSigningText({ token, url, note, issuedAt }: { token: string; url: string; note: string; issuedAt: number }): string {
  return `CallZ callout\n\nToken: ${token.toLowerCase()}\nNetwork: bsc\nLink: ${url}\nTime: ${issuedAt}\n\n${note}`;
}

/**
 * The exact text the reviewer wallet signs to reject one callout.
 * Keep in sync with `reviewRejectText` in apps/worker/src/callouts.ts.
 */
function reviewRejectText(id: number, issuedAt: number): string {
  return `CallZ review\n\nReject callout ${id}\nTime: ${issuedAt}`;
}

// ── What the API returns ─────────────────────────────────────────────────

interface Callout {
  id: number;
  /** Lowercase address of the wallet that signed the callout. */
  author: string;
  /** The display name that wallet has now. Null, or absent, for a wallet without one. */
  authorName?: string | null;
  /** The tag of the clan that wallet is in now. Null, or absent, for a wallet in none. */
  authorClan?: string | null;
  kind: number;
  /** The canonical link. Shown as a link only after `checkedLink` has rebuilt the same one. */
  url: string;
  note: string;
  status: "pending" | "approved";
  /** Unix seconds, by the server's clock. */
  createdAt: number;
  /** The round the approval is for, when it stops being valid, and the reviewer's signature. Null until approved. */
  epoch: number | null;
  deadline: number | null;
  attestation: string | null;
  /** The token's market cap when the callout was posted, in whole US dollars. Null for one posted before it was recorded. */
  callMcap: number | null;
  /** What the author held when the callout was posted, and at the latest reading: token base units, as decimal strings. */
  callBalance: string | null;
  heldBalance: string | null;
  /** Closed once the author holds less than a tenth of what they held at the call. A closed position stays closed. */
  position: "open" | "closed";
  /** When the position was found closed (unix seconds), and the token's market cap then. */
  closedAt: number | null;
  closedMcap: number | null;
  /** When the reviewer approved it (unix seconds), and the transaction with which the Worker took it to the vault, if it did. */
  reviewedAt?: number | null;
  recordTx?: string | null;
}

interface ReviewCallout extends Callout {
  /** Lowercase address of the token the callout was posted under. */
  token: string;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;
const ATTESTATION = /^0x[0-9a-f]{130}$/;
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
/** A uint256 as a decimal string. */
const isUnits = (value: unknown): value is string => typeof value === "string" && /^[0-9]{1,78}$/.test(value);

function isCallout(value: unknown): value is Callout {
  if (typeof value !== "object" || value === null) return false;
  const { id, author, authorName, kind, url, note, status, createdAt, epoch, deadline, attestation, callMcap, callBalance, heldBalance, position, closedAt, closedMcap, reviewedAt, recordTx } =
    value as Record<string, unknown>;
  return (
    isCount(id) && typeof author === "string" && ADDRESS.test(author) && isCount(kind) && typeof url === "string" && typeof note === "string" &&
    (authorName === undefined || authorName === null || typeof authorName === "string") &&
    (status === "pending" || status === "approved") && isCount(createdAt) &&
    (epoch === null || isCount(epoch)) && (deadline === null || isCount(deadline)) &&
    (attestation === null || (typeof attestation === "string" && ATTESTATION.test(attestation))) &&
    (callMcap === null || isCount(callMcap)) && (callBalance === null || isUnits(callBalance)) && (heldBalance === null || isUnits(heldBalance)) &&
    (position === "open" || position === "closed") && (closedAt === null || isCount(closedAt)) && (closedMcap === null || isCount(closedMcap)) &&
    (reviewedAt === undefined || reviewedAt === null || isCount(reviewedAt)) && (recordTx === undefined || recordTx === null || typeof recordTx === "string")
  );
}

function isReviewCallout(value: unknown): value is ReviewCallout {
  if (!isCallout(value)) return false;
  const { token } = value as unknown as Record<string, unknown>;
  return typeof token === "string" && ADDRESS.test(token);
}

/**
 * The callout's link, rebuilt by this page's own rules. Null unless that gives back exactly the link and the
 * site the API returned: only then is it safe to use as an address to click, and only then do its hashes mean
 * what the reviewer and the vault take them to mean.
 */
function checkedLink(callout: Pick<Callout, "url" | "kind">, token: string): CalloutLink | null {
  const parsed = parseCalloutLink(callout.url, token);
  return parsed.ok && parsed.url === callout.url && parsed.kind === callout.kind ? parsed : null;
}

/** keccak256 of the canonical link's UTF-8 bytes: what the vault knows a link by. */
const linkHashOf = (link: CalloutLink): Hex => keccak256(toBytes(link.url));

/**
 * What the reviewer attests and the vault checks, built from the checked link rather than from hashes handed
 * over. `mcap` is the market cap recorded when the callout was posted: a callout without one cannot be attested.
 */
function submissionOf(callout: Pick<Callout, "id" | "author" | "callBalance">, token: string, link: CalloutLink, mcap: number, epoch: number, deadline: number): Submission {
  return {
    holder: callout.author as Address,
    token: token.toLowerCase() as Address,
    epoch: BigInt(epoch),
    kind: link.kind,
    linkHash: linkHashOf(link),
    profileHash: link.profile === "" ? ZERO_HASH : keccak256(toBytes(link.profile)),
    mcap: BigInt(mcap),
    // What the wallet held when the callout was posted: the vault never counts more than this.
    held: BigInt(callout.callBalance ?? "0"),
    nonce: BigInt(callout.id),
    deadline: BigInt(deadline),
  };
}

/** Milliseconds the server's clock is ahead of this device's, from a response's Date header. Zero within the slack. */
function clockAheadOf(response: Response): number {
  const served = Date.parse(response.headers.get("date") ?? "");
  if (!Number.isFinite(served)) return 0;
  const ahead = served - Date.now();
  return Math.abs(ahead) > CLOCK_SLACK_MS ? ahead : 0;
}

/** The error a failed request carries, or `fallback`. Shown as text. */
async function errorOf(response: Response, fallback: string): Promise<string> {
  const failure = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof failure?.error === "string" ? failure.error : fallback;
}

function SiteBadge({ kind }: { kind: number }) {
  const name = kind === KIND_X || kind === KIND_PUMP || kind === KIND_FOMO ? SITE_NAMES[kind] : "Link";
  return <span className="callout-site" data-kind={kind}>{name}</span>;
}

/** The only place a callout's link becomes something to click: `link` has been through `checkedLink`. */
function OpenLink({ link }: { link: CalloutLink | null }) {
  if (!link) return <span className="callout-hint">This link did not pass the checks, so it is not shown.</span>;
  return (
    <a className="callout-open" href={link.url} target="_blank" rel="noopener noreferrer nofollow">
      Open on {SITE_NAMES[link.kind]} ↗
    </a>
  );
}

const balanceAbi = parseAbi(["function balanceOf(address account) view returns (uint256)"]);
/** Ratios of base-unit amounts are taken to nine decimal places before they become a number. */
const RATIO_SCALE = 1_000_000_000n;

/** `part / whole` as a number, from whole-number maths: a balance does not fit a double. Null when it cannot be said. */
function ratio(part: bigint, whole: bigint): number | null {
  if (whole <= 0n || part < 0n) return null;
  const value = Number((part * RATIO_SCALE) / whole) / Number(RATIO_SCALE);
  return Number.isFinite(value) ? value : null;
}

/** A dollar amount that is not negative, short enough for a narrow column: "$0", "<$0.01", "$841.25", "$8.41K", "$48.2K". */
function dollars(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return "<$0.01";
  if (value < 1000) return `$${value.toLocaleString("en", { maximumFractionDigits: 2 })}`;
  return `$${new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(value)}`;
}

/** A change as a percentage with its sign: "+8.3%", "-12.4%". Null when it is not a number to show. */
function signedPercent(change: number): string | null {
  if (!Number.isFinite(change)) return null;
  const rounded = Math.round(change * 1000) / 10;
  return `${rounded < 0 ? "-" : "+"}${Math.abs(rounded).toFixed(1)}%`;
}

interface PositionStat {
  label: string;
  value: string;
  /** A second, smaller line under the value. */
  detail?: string;
  tone?: "good" | "warn";
}

const UNKNOWN = "—";

/**
 * The four figures of the position behind a callout. `held` is what the author holds now (read live from the
 * token where that worked, else the Worker's latest reading), `supply` the token's total supply, `cap` its
 * market cap now. Null for a callout posted before market caps were recorded. A figure that cannot be worked
 * out from what is known is a dash, never a guess.
 */
function positionStats(callout: Callout, held: bigint | null, liveClosed: boolean, supply: bigint | null, cap: number | null, now: number): PositionStat[] | null {
  const called = callout.callMcap;
  if (called === null || called <= 0) return null;
  const calledAt: PositionStat = { label: "Called at", value: `${usd(called)} MC` };

  if (callout.position === "closed" || liveClosed) {
    // Until the Worker has stored the market cap of the closing, the one the page has now stands in for it.
    const closedCap = callout.closedMcap !== null && callout.closedMcap > 0 ? callout.closedMcap : cap;
    const result = closedCap === null ? null : signedPercent(closedCap / called - 1);
    const when = callout.closedAt !== null ? ago(callout.closedAt, now) : callout.position === "closed" ? undefined : "now";
    return [
      { label: "Position", value: "Closed" },
      { label: "Closed at", value: closedCap === null ? UNKNOWN : `${usd(closedCap)} MC`, ...(closedCap !== null && when ? { detail: when } : {}) },
      calledAt,
      result === null || closedCap === null ? { label: "Result", value: UNKNOWN } : { label: "Result", value: result, tone: closedCap >= called ? "good" : "warn" },
    ];
  }

  const share = held !== null && supply !== null ? ratio(held, supply) : null;
  const worth = share !== null && cap !== null ? share * cap : null;
  const profit = share !== null && cap !== null ? share * (cap - called) : null;
  const change = cap !== null ? signedPercent(cap / called - 1) : null;
  const percentHeld = share === null ? null : share * 100;
  return [
    { label: "Position", value: worth !== null && Number.isFinite(worth) ? dollars(worth) : UNKNOWN },
    profit !== null && change !== null && Number.isFinite(profit)
      ? {
          label: "Profit since call",
          value: `${profit < 0 ? "-" : "+"}${Math.abs(profit) < 0.01 ? "$0" : dollars(Math.abs(profit))}`,
          // The gain is written without its plus, as in "+$22.1K (8.3%)".
          detail: `(${change.replace(/^\+/, "")})`,
          tone: profit < 0 ? "warn" : "good",
        }
      : { label: "Profit since call", value: UNKNOWN },
    calledAt,
    {
      label: "Supply held",
      value: percentHeld === null ? UNKNOWN : held === 0n ? "0%" : percentHeld < 0.01 ? "<0.01%" : `${percentHeld.toFixed(2)}%`,
    },
  ];
}

/** The box of figures on a card. Each label is followed by a space, so the card reads "Called at $26.5M MC" as text too. */
function PositionStats({ stats }: { stats: PositionStat[] }) {
  return (
    <dl className="callout-stats" data-testid="callout-position">
      {stats.map((stat) => (
        <div key={stat.label} className="callout-stat">
          <dt>{stat.label}{" "}</dt>
          <dd className="num" data-tone={stat.tone}>
            {stat.value}
            {stat.detail && <>{" "}<span className="callout-stat-detail">{stat.detail}</span></>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ── The feed on a token's page ───────────────────────────────────────────

/**
 * How long, in seconds, an approved callout is left to the Worker to bring to the vault before its author is
 * offered the button to do it themselves.
 */
const AUTO_RECORD_WAIT_SECONDS = 180;

const SHARE_CARD_ALT: Partial<Record<number, string>> = {
  [KIND_PUMP]: "The callout as shared on pump.fun",
  [KIND_FOMO]: "The thesis as shared on fomo.family",
};

/**
 * The picture pump.fun or fomo.family shares for a callout, served by this site's Worker from its own origin
 * (/api/callouts/bsc/card/<id>): the Worker fetches it from an address it builds from the stored link. A post
 * on X has none. A picture that does not load leaves the card without one.
 */
function ShareCard({ id, kind }: { id: number; kind: number }) {
  const [failed, setFailed] = useState(false);
  const alt = SHARE_CARD_ALT[kind];
  if (failed || alt === undefined) return null;
  return <img className="callout-share-card" loading="lazy" decoding="async" width={1200} height={630} src={`${API}/card/${id}`} alt={alt} onError={() => setFailed(true)} />;
}

const RECORD_STEPS = { checking: "Checking…", confirm: "Confirm in wallet…", pending: "Recording…" } as const;

/**
 * `marketCap` is the token's market cap now, in US dollars, and `supply` its total supply in base units,
 * where the page showing the feed knows them: with both, each card values the position behind it.
 */
export function Callouts({ token, marketCap, supply }: { token: Address; marketCap?: number | null; supply?: bigint | null }) {
  const wallet = useWallet();
  const feed = `${API}/${token.toLowerCase()}`;
  const titleId = useId();
  const [callouts, setCallouts] = useState<Callout[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  // The server's idea of now, so "2m ago" is right on a device whose clock is not.
  const [now, setNow] = useState(() => Date.now());
  /** Counts the feed's successful loads: what was read from the vault is read again with each. */
  const [loads, setLoads] = useState(0);
  /** True when the Worker brings approved callouts to the vault itself, so their authors confirm nothing. */
  const [autoRecord, setAutoRecord] = useState(false);
  /** Author to the balance of the token read from the chain just now. An author is absent until that read succeeds. */
  const [heldNow, setHeldNow] = useState<Record<string, bigint>>({});
  const [link, setLink] = useState("");
  const [note, setNote] = useState("");
  const [step, setStep] = useState<"idle" | "signing" | "sending">("idle");
  const [error, setError] = useState<string | null>(null);
  /** Link hash to whether the vault has counted it. A hash is absent until it has been looked up. */
  const [recorded, setRecorded] = useState<Record<string, boolean>>({});
  const [recording, setRecording] = useState<{ id: number; step: keyof typeof RECORD_STEPS } | null>(null);
  const [recordError, setRecordError] = useState<{ id: number; title: string; text: string } | null>(null);
  /** Milliseconds the server's clock is ahead of this device's. */
  const clockAhead = useRef(0);
  /** Asks for the feed now. */
  const pollNow = useRef<() => void>(() => undefined);

  useEffect(() => {
    let current = true;
    let busy = false;
    let loaded = false;
    setCallouts([]);
    setState("loading");
    setError(null);

    const load = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      try {
        const response = await fetch(`${feed}?limit=${FEED_PAGE}`);
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as { callouts?: unknown; autoRecord?: unknown };
        const page = body.callouts;
        if (!Array.isArray(page) || !page.every(isCallout)) throw new Error("unexpected response");
        if (!current) return;
        clockAhead.current = clockAheadOf(response);
        setNow(Date.now() + clockAhead.current);
        setAutoRecord(body.autoRecord === true);
        setCallouts(page);
        setLoads((count) => count + 1);
        setState("ready");
        loaded = true;
      } catch {
        // A failed poll is tried again at the next tick. Only a feed that never loaded says so.
        if (current && !loaded) setState("error");
      } finally {
        busy = false;
      }
    };

    const tick = () => {
      if (document.visibilityState !== "visible") return;
      setNow(Date.now() + clockAhead.current);
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
  }, [feed]);

  const me = wallet.account?.toLowerCase();
  // The connected wallet's own name, as it is this moment: a name it has just set or removed shows on its own
  // callouts at once, ahead of the next poll.
  const own = useDisplayName(wallet.account);
  const cards = useMemo(() => callouts.map((callout) => ({ callout, link: checkedLink(callout, token) })), [callouts, token]);

  // What each author in the feed holds right now, read from the token itself in one request: the Worker's
  // own reading can be a few minutes old. Read when the authors change, and again with every poll.
  const authors = useMemo(() => [...new Set(callouts.map((callout) => callout.author))].sort(), [callouts]);
  const authorsKey = authors.join(",");
  // Another token's balances say nothing about this one.
  useEffect(() => setHeldNow({}), [token]);
  useEffect(() => {
    if (authors.length === 0) return;
    let current = true;
    const read = () => {
      if (document.visibilityState !== "visible") return;
      client
        .multicall({
          allowFailure: true,
          // No size limit on the batch: every balance travels in the one call.
          batchSize: 0,
          contracts: authors.map((author) => ({ address: token, abi: balanceAbi, functionName: "balanceOf" as const, args: [author as Address] as const })),
        })
        .then(
          (results) =>
            current &&
            // An author whose balance the token did not answer for falls back to the Worker's reading.
            setHeldNow(Object.fromEntries(authors.flatMap((author, index) => (results[index]?.status === "success" ? [[author, results[index].result]] : [])))),
          // The chain could not be reached: the readings already on the page stand until the next poll.
          () => undefined,
        );
    };
    read();
    const timer = window.setInterval(read, POLL_MS);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
    // `authorsKey` is the content of `authors`.
  }, [authorsKey, token]);

  // The connected wallet's approved callouts: has the vault counted them yet?
  const ownHashes = useMemo(
    () => cards.flatMap(({ callout, link }) => (link && callout.status === "approved" && callout.author === me ? [linkHashOf(link)] : [])),
    [cards, me],
  );
  const ownKey = ownHashes.join(",");
  useEffect(() => {
    if (ownHashes.length === 0) return;
    let current = true;
    recordedLinks(ownHashes).then(
      (flags) => current && setRecorded((previous) => ({ ...previous, ...Object.fromEntries(ownHashes.map((hash, index) => [hash, flags[index] === true])) })),
      // The vault could not be read. The callouts are treated as not counted yet: recording one that already
      // is gets refused by the check that runs before the wallet opens.
      () => current && setRecorded((previous) => ({ ...Object.fromEntries(ownHashes.map((hash) => [hash, false])), ...previous })),
    );
    return () => {
      current = false;
    };
    // `ownKey` is the content of `ownHashes`.
  }, [ownKey, loads]);

  const onConnect = () => {
    if (!window.ethereum) {
      setError("No browser wallet was found. Open this page in a browser that has one to post.");
      return;
    }
    setError(null);
    connect();
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const account = wallet.account;
    if (!account || step !== "idle") return;
    // Said before the wallet is asked to sign anything: the server applies the same rules.
    const parsed = parseCalloutLink(link, token);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const cleaned = cleanBody(note);
    if ([...cleaned].length > MAX_NOTE_LENGTH) {
      setError(`The note is longer than ${MAX_NOTE_LENGTH} characters.`);
      return;
    }
    if (containsLink(cleaned)) {
      setError("Links are not allowed in the note. The callout link goes in its own box.");
      return;
    }
    setError(null);
    setStep("signing");
    try {
      const issuedAt = Math.floor((Date.now() + clockAhead.current) / 1000);
      let signature: unknown;
      try {
        signature = await personalSign(calloutSigningText({ token, url: parsed.url, note: cleaned, issuedAt }), account);
      } catch (cause) {
        setError((cause as Error).message);
        return;
      }

      setStep("sending");
      const response = await fetch(feed, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ author: account.toLowerCase(), url: parsed.url, note: cleaned, issuedAt, signature }),
      });
      if (!response.ok) {
        setError(await errorOf(response, "The callout could not be posted. Try again."));
        return;
      }
      setLink("");
      setNote("");
      pollNow.current();
    } catch {
      setError("Callouts could not be reached. Try again.");
    } finally {
      setStep("idle");
    }
  };

  const record = async (callout: Callout, checked: CalloutLink) => {
    const account = wallet.account;
    if (!account || recording || callout.epoch === null || callout.deadline === null || callout.attestation === null || callout.callMcap === null) return;
    setRecordError(null);
    setRecording({ id: callout.id, step: "checking" });
    try {
      await recordCallout(account, submissionOf(callout, token, checked, callout.callMcap, callout.epoch, callout.deadline), checked.url, callout.attestation as Hex, (next) =>
        setRecording({ id: callout.id, step: next }),
      );
      setRecorded((previous) => ({ ...previous, [linkHashOf(checked)]: true }));
      // The rewards panel next to the feed reads the round again.
      window.dispatchEvent(new Event("callz:recorded"));
    } catch (cause) {
      const failure = cause instanceof TradeError ? cause : null;
      setRecordError({
        id: callout.id,
        title: failure?.title ?? "Something went wrong",
        text: failure?.message ?? "The callout could not be recorded. Check your wallet's activity before trying again.",
      });
    } finally {
      setRecording(null);
    }
  };

  const nowSeconds = Math.floor(now / 1000);
  const cap = typeof marketCap === "number" && Number.isFinite(marketCap) && marketCap > 0 ? marketCap : null;
  const totalSupply = typeof supply === "bigint" && supply > 0n ? supply : null;

  return (
    <section className="callouts-panel" data-testid="token-callouts" aria-labelledby={titleId}>
      <header className="callouts-head">
        <h2 id={titleId}>Callouts</h2>
        <p className="callouts-help">
          Post your X, pump.fun or fomo.family callout for this token. Your holdings and the market cap are noted when you post.{" "}
          {autoRecord ? "Verified callouts are counted automatically. They earn" : "Verified callouts earn"} from the token's trading fees: the earlier
          the call and the longer you hold, the more.
        </p>
      </header>

      {wallet.account ? (
        <form className="callouts-form" onSubmit={(event) => void submit(event)}>
          <label className="callouts-input">
            <span className="visually-hidden">Link to your callout</span>
            <input
              type="text"
              name="callout-link"
              value={link}
              maxLength={MAX_LINK_LENGTH}
              placeholder="Link to your callout"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              inputMode="url"
              readOnly={step !== "idle"}
              onChange={(event) => setLink(event.target.value)}
            />
          </label>
          <label className="callouts-input">
            <span className="visually-hidden">Note, optional</span>
            <input
              type="text"
              name="callout-note"
              value={note}
              maxLength={MAX_NOTE_LENGTH}
              placeholder="Note (optional)"
              autoComplete="off"
              enterKeyHint="send"
              readOnly={step !== "idle"}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <button type="submit" className="button callouts-post" disabled={step !== "idle" || link.trim() === ""}>
            {step === "signing" ? "Sign in wallet…" : step === "sending" ? "Posting…" : "Post"}
          </button>
        </form>
      ) : (
        <div className="callouts-connect">
          <button type="button" className="button callouts-post" onClick={onConnect}>Connect wallet</button>
          <span className="callout-hint">Connect a wallet to post a callout.</span>
        </div>
      )}
      {error && <p className="callouts-error" role="alert">{error}</p>}

      {cards.length > 0 ? (
        <ol className="callouts-list" aria-label="Callouts, newest first">
          {cards.map(({ callout, link: checked }) => {
            const mine = callout.status === "approved" && callout.author === me;
            const counted = mine && checked ? recorded[linkHashOf(checked)] : undefined;
            const recordable =
              callout.epoch === currentEpoch() && callout.deadline !== null && callout.deadline > nowSeconds && callout.attestation !== null && callout.callMcap !== null;
            const busy = recording?.id === callout.id ? recording.step : null;
            // For its first minutes an approval is the Worker's to bring to the vault. After that, or where the
            // Worker does not do this, the author can.
            const beingCounted = autoRecord && callout.reviewedAt != null && nowSeconds - callout.reviewedAt <= AUTO_RECORD_WAIT_SECONDS;
            const live = heldNow[callout.author];
            const held = live ?? (callout.heldBalance !== null ? BigInt(callout.heldBalance) : null);
            // Closed the moment the chain shows under a tenth of the call balance, ahead of the Worker noticing.
            const liveClosed = live !== undefined && callout.callBalance !== null && live * 10n < BigInt(callout.callBalance);
            const stats = positionStats(callout, held, liveClosed, totalSupply, cap, now);
            return (
              <li key={callout.id} className="callout-card" data-own={callout.author === me}>
                <div className="callout-meta">
                  <SiteBadge kind={callout.kind} />
                  <AuthorName className="callout-author" address={callout.author} name={callout.author === me && own.state === "ready" ? own.name : callout.authorName} clan={callout.authorClan} />
                  <time className="callout-time" dateTime={new Date(callout.createdAt * 1000).toISOString()}>{ago(callout.createdAt, now)}</time>
                  {counted === true ? (
                    <span className="callout-status" data-status="counted">Counted on-chain</span>
                  ) : (
                    <span className="callout-status" data-status={callout.status}>{callout.status === "approved" ? "Verified" : "Awaiting review"}</span>
                  )}
                </div>
                {callout.note && <p className="callout-note">{callout.note}</p>}
                <ShareCard id={callout.id} kind={callout.kind} />
                {stats && <PositionStats stats={stats} />}
                <div className="callout-actions">
                  <OpenLink link={checked} />
                  {cap !== null && <span className="callout-cap num" title="The token's market cap now">◎ {usd(cap)} MC</span>}
                  {mine && checked && counted === false && recordable && beingCounted && (
                    <span className="callout-counting" role="status">Counting on-chain…</span>
                  )}
                  {mine && checked && counted === false && recordable && !beingCounted && (
                    <button type="button" className="button callout-record" disabled={recording !== null} onClick={() => void record(callout, checked)}>
                      {busy ? RECORD_STEPS[busy] : "Record on-chain"}
                    </button>
                  )}
                </div>
                {mine && checked && counted === false && !recordable && (
                  <p className="callout-hint">Approval expired. It will be re-approved for the current round.</p>
                )}
                {recordError?.id === callout.id && (
                  <p className="callouts-error" role="alert"><strong>{recordError.title}.</strong> {recordError.text}</p>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="callouts-empty">
          {state === "loading" && "Loading…"}
          {state === "error" && "Callouts could not be reached. Trying again shortly."}
          {state === "ready" && "No callouts yet. Be the first to post one."}
        </p>
      )}

      <p className="callouts-notice">Anyone can post a callout. Each link can be posted once, and is checked before it counts. Nothing here is advice.</p>
    </section>
  );
}

// ── The reviewer's page ──────────────────────────────────────────────────

interface ReviewQueue {
  /** Lowercase address of the reviewer wallet, as the Worker is configured. */
  attester: string;
  /** Lowercase address of the vault the Worker checks attestations for. */
  vault: string;
  callouts: ReviewCallout[];
}

const decimalsAbi = parseAbi(["function decimals() view returns (uint8)"]);

/** A balance at the call for the reviewer: in whole tokens where the token's decimals are known, in base units otherwise. */
function heldAtCall(balance: string, tokenDecimals: number | undefined): string {
  return tokenDecimals === undefined ? `${balance} base units` : `${amount(balance, 4, tokenDecimals)} tokens`;
}

export function ReviewPage() {
  const wallet = useWallet();
  const [queue, setQueue] = useState<ReviewQueue | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** Link hash to whether the vault has counted it, for approvals whose round has passed. */
  const [recorded, setRecorded] = useState<Record<string, boolean> | null>(null);
  const [vaultUnread, setVaultUnread] = useState(false);
  /** Why the last approval is not on-chain yet, when it is not. */
  const [notice, setNotice] = useState<string | null>(null);
  /** Token address to its decimals, for the tokens whose contract answered. */
  const [decimals, setDecimals] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<{ id: number; decision: "approve" | "reject" } | null>(null);
  const [error, setError] = useState<{ id: number; text: string } | null>(null);
  const clockAhead = useRef(0);

  useEffect(() => {
    const title = document.title;
    document.title = "Review callouts · CallZ";
    let current = true;
    (async () => {
      try {
        const response = await fetch(`${API}/review`);
        if (!response.ok) {
          const text = await errorOf(response, "The review queue could not be loaded. Reload to try again.");
          if (current) setLoadError(text);
          return;
        }
        const body = (await response.json()) as { attester?: unknown; vault?: unknown; callouts?: unknown };
        if (
          typeof body.attester !== "string" || !ADDRESS.test(body.attester) || typeof body.vault !== "string" || !ADDRESS.test(body.vault) ||
          !Array.isArray(body.callouts) || !body.callouts.every(isReviewCallout)
        ) {
          throw new Error("unexpected response");
        }
        if (!current) return;
        clockAhead.current = clockAheadOf(response);
        setNow(Date.now() + clockAhead.current);
        setQueue({ attester: body.attester, vault: body.vault, callouts: body.callouts });
      } catch {
        if (current) setLoadError("The review queue could not be loaded. Reload to try again.");
      }
    })();
    return () => {
      current = false;
      document.title = title;
    };
  }, []);

  const rows = useMemo(
    () => (queue?.callouts ?? []).map((callout) => ({ callout, link: checkedLink(callout, callout.token) })),
    [queue],
  );
  // How many decimals each token in the queue has, to show what was held at the call in whole tokens.
  const tokens = useMemo(() => [...new Set((queue?.callouts ?? []).map((callout) => callout.token))], [queue]);
  useEffect(() => {
    if (tokens.length === 0) return;
    let current = true;
    client
      .multicall({ allowFailure: true, contracts: tokens.map((token) => ({ address: token as Address, abi: decimalsAbi, functionName: "decimals" as const })) })
      .then(
        (results) =>
          current && setDecimals(Object.fromEntries(tokens.flatMap((token, index) => (results[index]?.status === "success" ? [[token, Number(results[index].result)]] : [])))),
        // Without the decimals the balance is shown in the token's base units, and says so.
        () => undefined,
      );
    return () => {
      current = false;
    };
  }, [tokens]);

  const epoch = currentEpoch();
  /** Approvals whose round has passed: they come back for approval unless the vault already counted them. */
  const expired = useMemo(
    () => rows.filter(({ callout }) => callout.status === "approved" && callout.epoch !== null && callout.epoch < epoch),
    [rows, epoch],
  );

  useEffect(() => {
    const hashes = expired.flatMap(({ link }) => (link ? [linkHashOf(link)] : []));
    if (hashes.length === 0) {
      setRecorded({});
      return;
    }
    let current = true;
    recordedLinks(hashes).then(
      (flags) => current && setRecorded(Object.fromEntries(hashes.map((hash, index) => [hash, flags[index] === true]))),
      () => {
        if (!current) return;
        setVaultUnread(true);
        setRecorded({});
      },
    );
    return () => {
      current = false;
    };
  }, [expired]);

  const listed = useMemo(
    () =>
      rows.filter(({ callout, link }) => {
        if (callout.status === "pending") return true;
        if (callout.epoch === null || callout.epoch >= epoch || recorded === null) return false;
        return !(link && recorded[linkHashOf(link)] === true);
      }),
    [rows, epoch, recorded],
  );

  const account = wallet.account;
  const isReviewer = !!queue && !!account && account.toLowerCase() === queue.attester;
  const sameVault = !!queue && queue.vault === VAULT.toLowerCase();
  const onChain = wallet.chainId === SITES.bsc.id;

  /** Stores a decision and takes the callout off the page. Resolves with why the approval is not on-chain yet, when the Worker says so. */
  const send = async (id: number, decision: "approve" | "reject", body: Record<string, unknown>): Promise<string | null> => {
    const response = await fetch(`${API}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, decision, ...body }),
    });
    if (!response.ok) throw new Error(await errorOf(response, "The decision could not be stored. Try again."));
    const stored = (await response.json().catch(() => null)) as { callout?: { recordError?: unknown } } | null;
    setQueue((previous) => previous && { ...previous, callouts: previous.callouts.filter((callout) => callout.id !== id) });
    return typeof stored?.callout?.recordError === "string" ? stored.callout.recordError : null;
  };

  const approve = async (callout: ReviewCallout, link: CalloutLink) => {
    const provider = window.ethereum;
    const mcap = callout.callMcap;
    if (!provider || !account || busy || mcap === null) return;
    setError(null);
    setBusy({ id: callout.id, decision: "approve" });
    try {
      const round = currentEpoch();
      const deadline = epochEnd(round);
      let signature: Hex;
      try {
        signature = await createWalletClient({ chain: bsc, transport: custom(provider) }).signTypedData({
          account,
          ...submissionTypedData(submissionOf(callout, callout.token, link, mcap, round, deadline)),
        });
      } catch (cause) {
        // 4001: the reviewer closed the wallet's prompt. The chain library hands it on under its own error.
        const failure = cause as { code?: number; cause?: { code?: number } } | null;
        const rejected = failure?.code === 4001 || failure?.cause?.code === 4001;
        throw new Error(rejected ? "The signature request was rejected in the wallet." : "The wallet could not sign the approval.");
      }
      const recordError = await send(callout.id, "approve", { epoch: round, deadline, signature });
      // The approval is stored either way. Where it could not be counted on-chain at once, the reviewer is told why.
      setNotice(recordError === null ? null : `Callout ${callout.id} is approved, and not counted on-chain yet. ${recordError}`);
    } catch (cause) {
      setError({ id: callout.id, text: cause instanceof Error && cause.message ? cause.message : "The approval could not be stored. Try again." });
    } finally {
      setBusy(null);
    }
  };

  const reject = async (callout: ReviewCallout) => {
    if (!account || busy) return;
    setError(null);
    setBusy({ id: callout.id, decision: "reject" });
    try {
      const issuedAt = Math.floor((Date.now() + clockAhead.current) / 1000);
      const signature = await personalSign(reviewRejectText(callout.id, issuedAt), account);
      await send(callout.id, "reject", { issuedAt, signature });
    } catch (cause) {
      setError({ id: callout.id, text: cause instanceof Error && cause.message ? cause.message : "The rejection could not be stored. Try again." });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="review-page" data-testid="review-page">
      <header className="page-head">
        <h1>Review callouts</h1>
        <p className="lede">Open each link and check that it is a real callout for the token, posted by the wallet shown. Approving signs it for today's round.</p>
      </header>

      {loadError && <p className="note" role="alert">{loadError}</p>}
      {!queue && !loadError && <p className="note" role="status">Loading the review queue…</p>}

      {queue && !isReviewer && (
        <p className="note" data-testid="review-connect">
          <span>Connect the reviewer wallet (<span className="num" title={queue.attester}>{short(queue.attester)}</span>) to approve.</span>
        </p>
      )}
      {queue && isReviewer && !sameVault && (
        <p className="note note-warn" role="alert">
          <span>This page signs for the vault at <code>{VAULT.toLowerCase()}</code>, and the server checks approvals for <code>{queue.vault}</code>. Approvals are off until they are the same.</span>
        </p>
      )}
      {queue && isReviewer && sameVault && !onChain && (
        <p className="note">
          <span>Approvals are signed for BNB Chain. Switch the wallet to it to approve.</span>
          <button type="button" className="button review-switch" onClick={() => void switchChain(SITES.bsc).catch(() => undefined)}>Switch to {SITES.bsc.short}</button>
        </p>
      )}
      {notice && <p className="note" role="status">{notice}</p>}
      {queue && vaultUnread && (
        <p className="note" role="status">The vault could not be read, so approvals from past rounds are listed whether or not they were already counted.</p>
      )}

      {queue && recorded !== null && listed.length === 0 && <p className="note" role="status">Nothing is waiting for review.</p>}

      {queue && listed.length > 0 && (
        <ol className="callouts-list review-list" aria-label="Callouts waiting for review, newest first">
          {listed.map(({ callout, link }) => {
            const working = busy?.id === callout.id ? busy.decision : null;
            return (
              <li key={callout.id} className="callout-card">
                <div className="callout-meta">
                  <SiteBadge kind={callout.kind} />
                  <AuthorName className="callout-author" address={callout.author} name={callout.authorName} clan={callout.authorClan} />
                  <time className="callout-time" dateTime={new Date(callout.createdAt * 1000).toISOString()}>{ago(callout.createdAt, now)}</time>
                  <span className="callout-status" data-status={callout.status === "approved" ? "expired" : "pending"}>
                    {callout.status === "approved" ? "Approval expired" : "Awaiting review"}
                  </span>
                </div>
                <dl className="review-facts">
                  <div><dt>Token</dt><dd><a className="num" href={`#/token/${callout.token}`}>{callout.token}</a></dd></div>
                  <div><dt>Posted by</dt><dd className="num">{callout.author}</dd></div>
                  <div><dt>Link</dt><dd className="num">{callout.url}</dd></div>
                  {link?.profile && <div><dt>Profile</dt><dd className="num">{link.profile}</dd></div>}
                  {callout.callMcap !== null && <div><dt>Market cap at the call</dt><dd className="num">{usd(callout.callMcap)}</dd></div>}
                  {callout.callBalance !== null && <div><dt>Held at the call</dt><dd className="num">{heldAtCall(callout.callBalance, decimals[callout.token])}</dd></div>}
                  {callout.note && <div><dt>Note</dt><dd>{callout.note}</dd></div>}
                </dl>
                <div className="callout-actions">
                  <OpenLink link={link} />
                  {isReviewer && (
                    <span className="review-buttons">
                      {link && sameVault && onChain && callout.callMcap !== null && (
                        <button type="button" className="button" disabled={busy !== null} onClick={() => void approve(callout, link)}>
                          {working === "approve" ? "Sign in wallet…" : "Approve"}
                        </button>
                      )}
                      <button type="button" className="button button-warn" disabled={busy !== null} onClick={() => void reject(callout)}>
                        {working === "reject" ? "Sign in wallet…" : "Reject"}
                      </button>
                    </span>
                  )}
                </div>
                {callout.callMcap === null && <p className="callout-hint">Posted before market caps were recorded: ask the author to post it again.</p>}
                {error?.id === callout.id && <p className="callouts-error" role="alert">{error.text}</p>}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
