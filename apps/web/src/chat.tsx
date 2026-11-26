// A public chat room per token, kept by this site's Worker under /api/chat (apps/worker/src/chat.ts).
// Nobody logs in: the wallet signs each message with personal_sign, over plain EIP-1193, so this panel
// loads no chain library.
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { ago, short } from "./format";
import { connect, useWallet } from "./wallet";
import "./chat.css";

type ChatChain = "bsc" | "bscTestnet";

interface ChatMessage {
  id: number;
  /** Lowercase address of the wallet that signed the message. */
  author: string;
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
 * Keep in sync with `chatSigningText` in apps/worker/src/chat.ts: one character of difference and no signature verifies.
 */
function chatSigningText({ chain, token, body, issuedAt }: { chain: ChatChain; token: string; body: string; issuedAt: number }): string {
  return `CallZ chat\n\nToken: ${token.toLowerCase()}\nNetwork: ${chain}\nTime: ${issuedAt}\n\n${body}`;
}

/** Text as the 0x hex of its UTF-8 bytes, the form personal_sign takes a message in. */
function utf8Hex(text: string): string {
  let hex = "0x";
  for (const byte of new TextEncoder().encode(text)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function isMessage(value: unknown): value is ChatMessage {
  if (typeof value !== "object" || value === null) return false;
  const { id, author, body, createdAt } = value as Record<string, unknown>;
  return Number.isSafeInteger(id) && typeof author === "string" && typeof body === "string" && Number.isSafeInteger(createdAt);
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
  const room = `/api/chat/${chain}/${token.toLowerCase()}`;
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
    following.current = true;

    const load = async (): Promise<void> => {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      const after = lastId;
      try {
        const response = await fetch(after === null ? `${room}?limit=${FIRST_PAGE}` : `${room}?after=${after}&limit=${POLL_PAGE}`);
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
  }, [room]);

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
      const text = chatSigningText({ chain, token, body, issuedAt });
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
      const response = await fetch(room, {
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

  return (
    <section className="chat-panel" data-testid="token-chat" aria-labelledby={titleId}>
      <header className="chat-head">
        <h2 id={titleId}>Chat</h2>
      </header>

      {/* Only new messages are announced: the times tick over without a word. */}
      <div className="chat-list" ref={list} onScroll={onScroll} role="log" aria-label="Messages" aria-relevant="additions" tabIndex={0}>
        {messages.length > 0 ? (
          <ol className="chat-messages">
            {messages.map((message) => (
              <li key={message.id} className="chat-message" data-own={message.author === me}>
                <span className="chat-meta">
                  <span className="chat-author" title={message.author}>{short(message.author)}</span>
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
              placeholder={`Message as ${short(wallet.account)}`}
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

      <p className="chat-notice">Anyone can post here. Messages are signed by the wallet shown. Nothing in chat is advice.</p>
    </section>
  );
}
