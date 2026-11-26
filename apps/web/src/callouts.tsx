// Callouts: links to posts on X, pump.fun or fomo.family that call a token out, kept by this site's Worker
// under /api/callouts (apps/worker/src/callouts.ts). Nobody logs in: the wallet signs each callout with
// personal_sign. A reviewer wallet approves a callout by signing the attestation the rewards vault checks,
// and the author's own wallet then takes that attestation to the vault.
//
// A link on this page is never the text somebody typed. The Worker rebuilds every link in one canonical
// spelling, and this page runs the same rules over what the Worker returns before it becomes an address to
// click: a link that does not come out identical is not shown as a link at all.
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { createWalletClient, custom, keccak256, toBytes, type Address, type Hex } from "viem";
import { bsc } from "viem/chains";
import { ago, short } from "./format";
import { VAULT, currentEpoch, epochEnd, recordCallout, recordedLinks, submissionTypedData, type Submission } from "./rewards";
import { SITES } from "./site";
import { TradeError } from "./trade";
import { connect, switchChain, useWallet } from "./wallet";
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

/** Text as the 0x hex of its UTF-8 bytes, the form personal_sign takes a message in. */
function utf8Hex(text: string): string {
  let hex = "0x";
  for (const byte of new TextEncoder().encode(text)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

// ── What the API returns ─────────────────────────────────────────────────

interface Callout {
  id: number;
  /** Lowercase address of the wallet that signed the callout. */
  author: string;
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
}

interface ReviewCallout extends Callout {
  /** Lowercase address of the token the callout was posted under. */
  token: string;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;
const ATTESTATION = /^0x[0-9a-f]{130}$/;
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function isCallout(value: unknown): value is Callout {
  if (typeof value !== "object" || value === null) return false;
  const { id, author, kind, url, note, status, createdAt, epoch, deadline, attestation } = value as Record<string, unknown>;
  return (
    isCount(id) && typeof author === "string" && ADDRESS.test(author) && isCount(kind) && typeof url === "string" && typeof note === "string" &&
    (status === "pending" || status === "approved") && isCount(createdAt) &&
    (epoch === null || isCount(epoch)) && (deadline === null || isCount(deadline)) &&
    (attestation === null || (typeof attestation === "string" && ATTESTATION.test(attestation)))
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

/** What the reviewer attests and the vault checks, built from the checked link rather than from hashes handed over. */
function submissionOf(callout: Pick<Callout, "id" | "author">, token: string, link: CalloutLink, epoch: number, deadline: number): Submission {
  return {
    holder: callout.author as Address,
    token: token.toLowerCase() as Address,
    epoch: BigInt(epoch),
    kind: link.kind,
    linkHash: linkHashOf(link),
    profileHash: link.profile === "" ? ZERO_HASH : keccak256(toBytes(link.profile)),
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

/** Asks the wallet for a personal_sign signature over `text`. Throws the message to show when it does not give one. */
async function personalSign(text: string, account: string): Promise<unknown> {
  const provider = window.ethereum;
  if (!provider) throw new Error("No browser wallet was found.");
  try {
    return await provider.request({ method: "personal_sign", params: [utf8Hex(text), account] });
  } catch (cause) {
    // 4001: the visitor closed the wallet's prompt.
    const rejected = (cause as { code?: number } | null)?.code === 4001;
    throw new Error(rejected ? "The signature request was rejected in the wallet." : "The wallet could not sign the message.");
  }
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

// ── The feed on a token's page ───────────────────────────────────────────

const RECORD_STEPS = { checking: "Checking…", confirm: "Confirm in wallet…", pending: "Recording…" } as const;

export function Callouts({ token }: { token: Address }) {
  const wallet = useWallet();
  const feed = `${API}/${token.toLowerCase()}`;
  const titleId = useId();
  const [callouts, setCallouts] = useState<Callout[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  // The server's idea of now, so "2m ago" is right on a device whose clock is not.
  const [now, setNow] = useState(() => Date.now());
  /** Counts the feed's successful loads: what was read from the vault is read again with each. */
  const [loads, setLoads] = useState(0);
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
        const page = ((await response.json()) as { callouts?: unknown }).callouts;
        if (!Array.isArray(page) || !page.every(isCallout)) throw new Error("unexpected response");
        if (!current) return;
        clockAhead.current = clockAheadOf(response);
        setNow(Date.now() + clockAhead.current);
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
  const cards = useMemo(() => callouts.map((callout) => ({ callout, link: checkedLink(callout, token) })), [callouts, token]);

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
    if (!account || recording || callout.epoch === null || callout.deadline === null || callout.attestation === null) return;
    setRecordError(null);
    setRecording({ id: callout.id, step: "checking" });
    try {
      await recordCallout(account, submissionOf(callout, token, checked, callout.epoch, callout.deadline), checked.url, callout.attestation as Hex, (next) =>
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

  return (
    <section className="callouts-panel" data-testid="token-callouts" aria-labelledby={titleId}>
      <header className="callouts-head">
        <h2 id={titleId}>Callouts</h2>
        <p className="callouts-help">Post your X, pump.fun or fomo.family callout for this token. Verified callouts earn from the reward pool.</p>
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
            const live = callout.epoch === currentEpoch() && callout.deadline !== null && callout.deadline > nowSeconds && callout.attestation !== null;
            const busy = recording?.id === callout.id ? recording.step : null;
            return (
              <li key={callout.id} className="callout-card" data-own={callout.author === me}>
                <div className="callout-meta">
                  <SiteBadge kind={callout.kind} />
                  <span className="callout-author" title={callout.author}>{short(callout.author)}</span>
                  <time className="callout-time" dateTime={new Date(callout.createdAt * 1000).toISOString()}>{ago(callout.createdAt, now)}</time>
                  {counted === true ? (
                    <span className="callout-status" data-status="counted">Counted on-chain</span>
                  ) : (
                    <span className="callout-status" data-status={callout.status}>{callout.status === "approved" ? "Verified" : "Awaiting review"}</span>
                  )}
                </div>
                {callout.note && <p className="callout-note">{callout.note}</p>}
                <div className="callout-actions">
                  <OpenLink link={checked} />
                  {mine && checked && counted === false && live && (
                    <button type="button" className="button callout-record" disabled={recording !== null} onClick={() => void record(callout, checked)}>
                      {busy ? RECORD_STEPS[busy] : "Record on-chain"}
                    </button>
                  )}
                </div>
                {mine && checked && counted === false && !live && (
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

export function ReviewPage() {
  const wallet = useWallet();
  const [queue, setQueue] = useState<ReviewQueue | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** Link hash to whether the vault has counted it, for approvals whose round has passed. */
  const [recorded, setRecorded] = useState<Record<string, boolean> | null>(null);
  const [vaultUnread, setVaultUnread] = useState(false);
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

  const send = async (id: number, decision: "approve" | "reject", body: Record<string, unknown>): Promise<void> => {
    const response = await fetch(`${API}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, decision, ...body }),
    });
    if (!response.ok) throw new Error(await errorOf(response, "The decision could not be stored. Try again."));
    setQueue((previous) => previous && { ...previous, callouts: previous.callouts.filter((callout) => callout.id !== id) });
  };

  const approve = async (callout: ReviewCallout, link: CalloutLink) => {
    const provider = window.ethereum;
    if (!provider || !account || busy) return;
    setError(null);
    setBusy({ id: callout.id, decision: "approve" });
    try {
      const round = currentEpoch();
      const deadline = epochEnd(round);
      let signature: Hex;
      try {
        signature = await createWalletClient({ chain: bsc, transport: custom(provider) }).signTypedData({
          account,
          ...submissionTypedData(submissionOf(callout, callout.token, link, round, deadline)),
        });
      } catch (cause) {
        // 4001: the reviewer closed the wallet's prompt. The chain library hands it on under its own error.
        const failure = cause as { code?: number; cause?: { code?: number } } | null;
        const rejected = failure?.code === 4001 || failure?.cause?.code === 4001;
        throw new Error(rejected ? "The signature request was rejected in the wallet." : "The wallet could not sign the approval.");
      }
      await send(callout.id, "approve", { epoch: round, deadline, signature });
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
                  <span className="callout-author" title={callout.author}>{short(callout.author)}</span>
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
                  {callout.note && <div><dt>Note</dt><dd>{callout.note}</dd></div>}
                </dl>
                <div className="callout-actions">
                  <OpenLink link={link} />
                  {isReviewer && (
                    <span className="review-buttons">
                      {link && sameVault && onChain && (
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
                {error?.id === callout.id && <p className="callouts-error" role="alert">{error.text}</p>}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
