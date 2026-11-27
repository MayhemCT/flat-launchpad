// Two chat rooms per token, kept by this site's Worker under /api/chat (apps/worker/src/chat.ts): the public
// one, and a holder room that anyone can read but only wallets holding the token can post in. The Worker
// checks the holding before it stores a holder-room message. The holder room is the one a visitor sees first.
// Beside every author the panel says whether that wallet holds the token right now, read from the token itself
// on BNB Chain by this page, not taken from anyone's word.
// Nobody logs in: the wallet signs each message with personal_sign, over plain EIP-1193.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { parseAbi, type Address } from "viem";
import { AuthorName, useDisplayName } from "./display-name";
import { ago, short } from "./format";
import { client } from "./trade";
import { connect, useWallet, utf8Hex } from "./wallet";
import "./chat.css";

type ChatChain = "bsc" | "bscTestnet";
/** A token's rooms: the one anyone can post in, and the one only its holders can. */
type ChatRoom = "public" | "holders";

interface ChatMessage {
  id: number;
  /** Lowercase address of the wallet that signed the message. */
  author: string;
  /** The display name that wallet has now. Null, or absent, for a wallet without one. */
  authorName?: string | null;
  /** The tag of the clan that wallet is in now. Null, or absent, for a wallet in none. */
  authorClan?: string | null;
  body: string;
  /** Unix seconds, by the server's clock. */
  createdAt: number;
}

const MAX_LENGTH = 280;
/** Messages loaded when the panel opens. */
const FIRST_PAGE = 50;
/** The most one poll brings back. A full poll means the room moved further than that. */
const POLL_PAGE = 100;
const POLL_MS = 5000;
/** Messages kept on the page; older ones drop off the top. */
const KEPT = 300;
/** Within this many pixels of the bottom, the list counts as following the newest message. */
const FOLLOW_SLACK = 48;
/** A device clock further than this from the server's is corrected for; anything less is network delay. */
const CLOCK_SLACK_MS = 30_000;
/** How often the authors' balances are read again. */
const HOLDING_MS = 15_000;
/** The most authors whose balances are read: the ones who posted last. */
const HOLDING_AUTHORS = 100;
const balanceAbi = parseAbi(["function balanceOf(address account) view returns (uint256)"]);

/**
 * Characters that never reach a message: control characters (which include tabs and line breaks), zero-width
 * and text-direction marks, and unpaired surrogates, which are not text at all.
 */
const REMOVED = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩\uD800-\uDFFF]/gu;

/**
 * A message body as it is signed, stored and shown: one line, with nothing invisible in it.
 * Keep in sync with `cleanBody` in apps/worker/src/chat.ts: the Worker verifies the text this produces.
 */
function cleanBody(raw: string): string {
  return raw.replace(REMOVED, "").trim();
}

/**
 * The exact text the wallet signs for one message. `body` is the cleaned body, `issuedAt` unix seconds.
 * Its first line names the room, so what was signed for one room verifies in no other.
 * Keep in sync with `chatSigningText` in apps/worker/src/chat.ts: one character of difference and no signature verifies.
 */
function chatSigningText({ chain, token, body, issuedAt, room }: { chain: ChatChain; token: string; body: string; issuedAt: number; room: ChatRoom }): string {
  const title = room === "holders" ? "CallZ holder room" : "CallZ chat";
  return `${title}\n\nToken: ${token.toLowerCase()}\nNetwork: ${chain}\nTime: ${issuedAt}\n\n${body}`;
}

function isMessage(value: unknown): value is ChatMessage {
  if (typeof value !== "object" || value === null) return false;
  const { id, author, authorName, body, createdAt } = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(id) && typeof author === "string" && typeof body === "string" && Number.isSafeInteger(createdAt) &&
    (authorName === undefined || authorName === null || typeof authorName === "string")
  );
}

/**
 * Top-level domains for which a bare "name.tld" counts as a link. Anything with a scheme ("https://", "tg://"),
 * a "www." or a numeric address is caught without this list.
 */
const LINK_TLDS =
  "com|net|org|io|co|xyz|fun|me|gg|app|ai|dev|sh|to|tv|cc|ly|link|site|online|top|club|vip|pro|info|biz|finance|exchange|money|trade|bet|win|lol|wtf|meme|family|network|page|store|live|life|world|tech|cloud|social|chat|group|team|zone|art|run|one|xxx|ru|cn|uk|us|eu|de|fr|jp|kr|in|id|vn|th|ph|tr|br|ua|pl|nl|es|it|ca|au|sg|hk|tw|im|is|ws|bz|ag|la|pw|tk|ml|ga|cf|gq|eth|bnb|sol|crypto|nft|dao"
const LINK_PATTERNS = [
  /[a-z][a-z0-9+.-]{1,15}:\/\//i,
  /(?:^|[^a-z0-9])www\./i,
  /(?:^|[^0-9])\d{1,3}(?:\.\d{1,3}){3}(?:[^0-9]|$)/,
  new RegExp(`(?:^|[^a-z0-9-])[a-z0-9-]{1,63}\\.(?:${LINK_TLDS})(?:[^a-z0-9-]|$)`, "i"),
]

/**
 * True when a message carries a link, written plainly or dressed up ("example[.]com", "example dot com",
 * a full-width dot). Chat is text only: a link is how a room gets phished.
 * Keep in sync with `containsLink` in apps/worker/src/chat.ts.
 */
function containsLink(body: string): boolean {
  const plain = body
    .replace(/[\u3002\uFF0E\uFF61\u2024]/g, ".")
    .replace(/\s*[\[({]\s*(?:\.|dot)\s*[\])}]\s*/gi, ".")
    .replace(/\s+dot\s+/gi, ".")
  return LINK_PATTERNS.some((pattern) => pattern.test(plain))
}

export function TokenChat({ chain, token }: { chain: ChatChain; token: string }) {
  const wallet = useWallet();
  // Holders are heard first. Holdings are read on BNB Chain, so only a token there has a holder room.
  const [room, setRoom] = useState<ChatRoom>(chain === "bsc" ? "holders" : "public");
  /** Author to whether the wallet holds the token now. An author is absent until the chain has answered for it. */
  const [holding, setHolding] = useState<Record<string, boolean>>({});
  const base = `/api/chat/${chain}/${token.toLowerCase()}`;
  // The public room keeps the address it always had; the holder room is named in the query.
  const address = (query: string) => `${base}?${room === "holders" ? "room=holders&" : ""}${query}`;
  const titleId = useId();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  // The server's idea of now, so "2m ago" is right on a device whose clock is not.
  const [now, setNow] = useState(() => Date.now());
  const [draft, setDraft] = useState("");
  const [step, setStep] = useState<"idle" | "signing" | "sending">("idle");
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  /** True while the list follows the newest message; false once the reader scrolls up. */
  const following = useRef(true);
  /** Milliseconds the server's clock is ahead of this device's. */
  const clockAhead = useRef(0);
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
    setError(null);
    // A draft belongs to the room it was typed in: it does not follow the visitor into the other one.
    setDraft("");
    following.current = true;

    const load = async (): Promise<void> => {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      const after = lastId;
      try {
        const response = await fetch(address(after === null ? `limit=${FIRST_PAGE}` : `after=${after}&limit=${POLL_PAGE}`));
        if (!response.ok) throw new Error(String(response.status));
        const page = ((await response.json()) as { messages?: unknown }).messages;
        if (!Array.isArray(page) || !page.every(isMessage)) throw new Error("unexpected response");
        if (!current) return;

        const served = Date.parse(response.headers.get("date") ?? "");
        if (Number.isFinite(served)) {
          const ahead = served - Date.now();
          clockAhead.current = Math.abs(ahead) > CLOCK_SLACK_MS ? ahead : 0;
        }
        setNow(Date.now() + clockAhead.current);

        if (after !== null && page.length === POLL_PAGE) {
          // More arrived than one poll carries, as after a long time in a background tab: start again
          // from the newest page rather than paging through everything that was missed.
          lastId = null;
          again = true;
          return;
        }
        lastId = page.at(-1)?.id ?? after ?? 0;
        if (after === null) setMessages(page);
        else if (page.length > 0) setMessages((previous) => [...previous, ...page].slice(-KEPT));
        setState("ready");
      } catch {
        // A failed poll is tried again at the next tick. Only a room that never loaded says so.
        if (current && lastId === null) setState((previous) => (previous === "ready" ? previous : "error"));
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
  }, [base, room]);

  // Whether each author holds the token right now, read from the token itself in one request, and read again
  // every few seconds: someone who sold since posting is shown as no longer holding.
  const authors = useMemo(() => [...new Set(messages.map((message) => message.author).reverse())].slice(0, HOLDING_AUTHORS).sort(), [messages]);
  const authorsKey = authors.join(",");
  // Another token's balances say nothing about this one.
  useEffect(() => setHolding({}), [chain, token]);
  useEffect(() => {
    if (chain !== "bsc" || authors.length === 0) return;
    let current = true;
    const read = () => {
      if (document.visibilityState !== "visible") return;
      client
        .multicall({
          allowFailure: true,
          // No size limit on the batch: every balance travels in the one call.
          batchSize: 0,
          contracts: authors.map((author) => ({ address: token as Address, abi: balanceAbi, functionName: "balanceOf" as const, args: [author as Address] as const })),
        })
        .then(
          (results) =>
            current &&
            // An author the token did not answer for keeps the reading already on the page, or none.
            setHolding((previous) => ({
              ...previous,
              ...Object.fromEntries(authors.flatMap((author, index) => (results[index]?.status === "success" ? [[author, (results[index].result as bigint) > 0n]] : []))),
            })),
          // The chain could not be reached: the readings already on the page stand until the next try.
          () => undefined,
        );
    };
    read();
    const timer = window.setInterval(read, HOLDING_MS);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
    // `authorsKey` is the content of `authors`.
  }, [authorsKey, chain, token]);

  // Before the browser paints new messages, move to the newest, unless the reader has scrolled up.
  useLayoutEffect(() => {
    const element = list.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const element = list.current;
    if (element) following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_SLACK;
  };

  const onConnect = () => {
    if (!window.ethereum) {
      setError("No browser wallet was found. Open this page in a browser that has one to post.");
      return;
    }
    setError(null);
    connect();
  };

  const body = cleanBody(draft);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const provider = window.ethereum;
    const account = wallet.account;
    if (!provider || !account || !body || step !== "idle") return;
    // Said before the wallet is asked to sign anything: the server refuses links too.
    if (containsLink(body)) {
      setError("Links are not allowed in chat.");
      return;
    }
    setError(null);
    setStep("signing");
    try {
      const issuedAt = Math.floor((Date.now() + clockAhead.current) / 1000);
      const text = chatSigningText({ chain, token, body, issuedAt, room });
      let signature: unknown;
      try {
        signature = await provider.request({ method: "personal_sign", params: [utf8Hex(text), account] });
      } catch (cause) {
        // 4001: the visitor closed the wallet's prompt.
        const rejected = (cause as { code?: number } | null)?.code === 4001;
        setError(rejected ? "The signature request was rejected in the wallet." : "The wallet could not sign the message.");
        return;
      }

      setStep("sending");
      const response = await fetch(room === "holders" ? `${base}?room=holders` : base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ author: account.toLowerCase(), body, issuedAt, signature }),
      });
      if (!response.ok) {
        const failure = (await response.json().catch(() => null)) as { error?: unknown } | null;
        setError(typeof failure?.error === "string" ? failure.error : "The message could not be sent. Try again.");
        return;
      }
      setDraft("");
      // Ready for the next message: pressing Send took the cursor out of the box.
      input.current?.focus();
      // The poll brings the message back in its place among any that arrived just before it.
      following.current = true;
      pollNow.current();
    } catch {
      setError("The chat could not be reached. Try again.");
    } finally {
      setStep("idle");
    }
  };

  const me = wallet.account?.toLowerCase();
  // The connected wallet's own name, as it is this moment: a name it has just set or removed shows on the
  // messages it already posted, without waiting for them to be read again.
  const own = useDisplayName(wallet.account);
  const nameOf = (message: ChatMessage) => (message.author === me && own.state === "ready" ? own.name : message.authorName);
  const postingAs = wallet.account ? (own.name ? `${own.name} (${short(wallet.account)})` : short(wallet.account)) : "";

  return (
    <section className="chat-panel" data-testid="token-chat" aria-labelledby={titleId}>
      <header className="chat-head">
        <h2 id={titleId}>Chat</h2>
        {/* Holdings are read on BNB Chain, so that is where a token has a holder room. */}
        {chain === "bsc" && (
          <div className="seg seg-small chat-rooms" role="group" aria-label="Chat room">
            <button type="button" data-testid="chat-room-holders" aria-pressed={room === "holders"} onClick={() => setRoom("holders")}>Holders</button>
            <button type="button" data-testid="chat-room-public" aria-pressed={room === "public"} onClick={() => setRoom("public")}>Chat</button>
          </div>
        )}
      </header>
      {room === "holders" && <p className="chat-room-note">Only wallets that hold this token can post here. Anyone can read.</p>}

      {/* Only new messages are announced: the times tick over without a word. */}
      <div className="chat-list" ref={list} onScroll={onScroll} role="log" aria-label="Messages" aria-relevant="additions" tabIndex={0}>
        {messages.length > 0 ? (
          <ol className="chat-messages">
            {messages.map((message) => (
              <li key={message.id} className="chat-message" data-own={message.author === me}>
                <span className="chat-meta">
                  <AuthorName className="chat-author" address={message.author} name={nameOf(message)} clan={message.authorClan} />
                  {holding[message.author] !== undefined && (
                    <span className="chat-holding" data-testid="chat-holding" data-holding={holding[message.author]} title="Read from the token on BNB Chain just now">
                      {holding[message.author] ? "Holding" : room === "holders" ? "No longer holding" : "Not holding"}
                    </span>
                  )}
                  <time className="chat-time" dateTime={new Date(message.createdAt * 1000).toISOString()}>{ago(message.createdAt, now)}</time>
                </span>
                <span className="chat-body">{message.body}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="chat-empty">
            {state === "loading" && "Loading…"}
            {state === "error" && "The chat could not be reached. Trying again shortly."}
            {state === "ready" && "No messages yet. Be the first to post."}
          </p>
        )}
      </div>

      {wallet.account ? (
        <form className="chat-form" onSubmit={(event) => void submit(event)}>
          <label className="chat-input">
            <span className="visually-hidden">Message</span>
            <input
              ref={input}
              type="text"
              name="message"
              value={draft}
              maxLength={MAX_LENGTH}
              placeholder={room === "holders" ? `Message holders as ${postingAs}` : `Message as ${postingAs}`}
              autoComplete="off"
              enterKeyHint="send"
              readOnly={step !== "idle"}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <button type="submit" className="button chat-send" disabled={step !== "idle" || !body}>
            {step === "signing" ? "Sign in wallet…" : step === "sending" ? "Sending…" : "Send"}
          </button>
        </form>
      ) : (
        <div className="chat-connect">
          <button type="button" className="button chat-send" onClick={onConnect}>Connect wallet</button>
          <span className="chat-hint">Connect a wallet to post.</span>
        </div>
      )}
      {error && <p className="chat-error" role="alert">{error}</p>}

      <p className="chat-notice">
        {room === "holders" ? "Only holders can post here." : "Anyone can post here."} Messages are signed by the wallet shown.
        {chain === "bsc" && " Holding is read from BNB Chain as you watch."} Nothing in chat is advice.
      </p>
    </section>
  );
}
