// Links and what they point at, for every place that shows text somebody typed: rooms, applications, clans.
//
// `splitLinks` finds the web addresses in a text, `LinkedText` draws the text with them as links, and
// `LinkPreviews` adds a card for the first few: the page's name, title, description and picture, or the post
// itself when the link is a post on X. This browser never talks to the linked site. The site's Worker reads it
// (/api/preview, apps/worker/src/preview.ts) and the page shows what came back as text, with the picture
// fetched from this site's own origin. Nothing typed or fetched is ever put on the page as anything but text.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, apiBlob, ApiError, useSignedIn } from "./session";
import { useWallet } from "./wallet";
import "./links.css";

// ─────────────────────────────────────────────────────────────────────────────
// Finding the links in a text
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The endings an address written without "https://" may have. Copied from `LINK_TLDS` in chat.tsx, where the
 * same list decides what counts as a link in a token's public chat: a word and a dot are a web address only
 * when what follows the last dot is one of these.
 */
const LINK_TLDS =
  "com|net|org|io|co|xyz|fun|me|gg|app|ai|dev|sh|to|tv|cc|ly|link|site|online|top|club|vip|pro|info|biz|finance|exchange|money|trade|bet|win|lol|wtf|meme|family|network|page|store|live|life|world|tech|cloud|social|chat|group|team|zone|art|run|one|xxx|ru|cn|uk|us|eu|de|fr|jp|kr|in|id|vn|th|ph|tr|br|ua|pl|nl|es|it|ca|au|sg|hk|tw|im|is|ws|bz|ag|la|pw|tk|ml|ga|cf|gq|eth|bnb|sol|crypto|nft|dao";

/** What an address runs to: the next space, bracket of markup or quote. */
const REST = "[^\\s<>\"'`]";
/**
 * A host: DNS labels, the last of them an ending from the list. It ends there: not inside a longer word
 * ("foo.community"), not before "@" (the front of an email), not before another dotted part ("notes.io.txt").
 */
const HOST = `(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${LINK_TLDS})(?![\\p{L}\\p{N}_@-])(?!\\.[\\p{L}\\p{N}])`;
/** Either kind of address: one with its scheme written out, or a bare host with an optional port and path. */
const ADDRESS = new RegExp(`(https?:\\/\\/${REST}+)|(${HOST}(?::\\d{1,5})?(?:[/?#]${REST}*)?)`, "giu");
/** The host of a bare address, alone. */
const BARE_HOST = new RegExp(`^${HOST}`, "iu");
/** What may not stand right before a bare address: the rest of a word, of an email, of a path or of a file name. */
const JOINED = /[\p{L}\p{N}.@/:\\_\-=%#?&+]$/u;
/** A word that opens with a scheme other than a web one ("data:", "javascript:", "mailto:"): nothing in it is a link. */
const SCHEMED = /^[(["'{<]*[a-z][a-z0-9+.-]*:/i;

const OPENER: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

const count = (text: string, character: string): number => text.split(character).length - 1;

/** An address without the punctuation that ends the sentence it stands in. A bracket stays when it closes one the address opened. */
function withoutTail(found: string): string {
  let end = found.length;
  while (end > 0) {
    const last = found[end - 1] as string;
    if (".,;:!?'\"".includes(last)) {
      end--;
      continue;
    }
    const opener = OPENER[last];
    if (opener !== undefined) {
      const kept = found.slice(0, end);
      if (count(kept, last) > count(kept, opener)) {
        end--;
        continue;
      }
    }
    break;
  }
  return found.slice(0, end);
}

/** Where a written address leads, or null when it is not one this site links: only http and https, never one carrying a user name. */
function hrefOf(address: string, host: string | null): string | null {
  try {
    const url = new URL(address);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // An address carrying a user name ("https://bank.com@elsewhere") is how a link lies about where it goes.
    if (url.username !== "" || url.password !== "") return null;
    if (host === null) return url.href;
    // A bare address leads to the host that was typed and nowhere else, exactly as it was typed.
    return url.hostname === host.toLowerCase() ? address : null;
  } catch {
    return null;
  }
}

export type LinkPart = { kind: "text"; text: string } | { kind: "link"; href: string; label: string };

/**
 * A text as the parts it is drawn from: what stays text, and the web addresses in it.
 *
 * An address is either written with "http://" or "https://", or is a bare host such as "liquidlabs.io" or
 * "www.example.com/path?x=1": DNS labels ending in an ending from `LINK_TLDS`, then an optional port and path.
 * A bare host is a link only where it starts a word of its own, so "user@example.com", "name.txt", "v1.2" and
 * "3.14" stay text, and it leads to "https://" followed by exactly what was typed.
 */
export function splitLinks(text: string): LinkPart[] {
  const parts: LinkPart[] = [];
  let from = 0;
  for (const match of text.matchAll(ADDRESS)) {
    const start = match.index ?? 0;
    const bare = match[1] === undefined;
    const found = withoutTail(match[0]);
    let href: string | null = null;
    if (!bare) href = hrefOf(found, null);
    else if (!JOINED.test(text.slice(Math.max(0, start - 2), start))) {
      // The word this address stands in, up to the address itself.
      const word = /\S*$/.exec(text.slice(0, start))?.[0] ?? "";
      const host = BARE_HOST.exec(found)?.[0] ?? null;
      if (host !== null && !SCHEMED.test(word)) href = hrefOf(`https://${found}`, host);
    }
    if (href === null) continue;
    if (start > from) parts.push({ kind: "text", text: text.slice(from, start) });
    parts.push({ kind: "link", href, label: found });
    from = start + found.length;
  }
  if (from < text.length) parts.push({ kind: "text", text: text.slice(from) });
  return parts;
}

const POST = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,20})(?:[/?#].*)?$/i;

interface PostAddress {
  /** The post in the one spelling the API takes: https://x.com/<handle>/status/<number>. */
  url: string;
  /** The account named in the address. X also answers to "i" there, which names nobody. */
  handle: string | null;
}

/** A link to a post on X, read from either of X's names. Null for any other address. */
function postAddress(href: string): PostAddress | null {
  const match = POST.exec(href.trim());
  if (!match) return null;
  const [, handle = "", id = ""] = match;
  return { url: `https://x.com/${handle}/status/${id}`, handle: handle.toLowerCase() === "i" ? null : handle };
}

/** The first `limit` different links in a text, each one once. */
function linksIn(text: string, limit: number): Array<{ href: string; post: PostAddress | null }> {
  const found: Array<{ href: string; post: PostAddress | null }> = [];
  const seen = new Set<string>();
  for (const part of splitLinks(text)) {
    if (found.length >= limit) break;
    if (part.kind !== "link") continue;
    const post = postAddress(part.href);
    const key = post?.url ?? part.href;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ href: part.href, post });
  }
  return found;
}

/** A text with the web addresses in it as links, each labelled exactly as it was typed. Everything else stays the text it was. */
export function LinkedText({ text, className }: { text: string; className?: string }) {
  const parts = useMemo(() => splitLinks(text), [text]);
  const drawn = parts.map((part, index) => (
    <Fragment key={index}>
      {part.kind === "text" ? part.text : <a className="link-inline" href={part.href} target="_blank" rel="noopener noreferrer nofollow">{part.label}</a>}
    </Fragment>
  ));
  return className ? <span className={className}>{drawn}</span> : <>{drawn}</>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Asking the API what a link points at
// ─────────────────────────────────────────────────────────────────────────────

interface Preview {
  url: string;
  site: string;
  title: string | null;
  description: string | null;
  /** The https address of the page's picture, shown only through /api/preview/image. */
  image: string | null;
}

interface Post {
  url: string;
  handle: string | null;
  authorName: string | null;
  text: string;
  date: string | null;
}

const isFields = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isText = (value: unknown): value is string | null => value === null || typeof value === "string";

function isPreview(value: unknown): value is Preview {
  return isFields(value) && typeof value.url === "string" && typeof value.site === "string" && isText(value.title) && isText(value.description) && isText(value.image);
}

function isPost(value: unknown): value is Post {
  return isFields(value) && typeof value.url === "string" && isText(value.handle) && isText(value.authorName) && typeof value.text === "string" && isText(value.date);
}

/** What the API said about one link: what it found, or the status it refused with (0 when it could not be reached). */
type Answer<T> = { state: "ready"; data: T } | { state: "failed"; status: number };

interface Kept<T> {
  /** Null while the API is being asked. */
  answer: Answer<T> | null;
  asked: Promise<Answer<T>>;
  /** When this answer stops standing, in milliseconds. */
  until: number;
}

/** Every link asked about since the page loaded, by address: a chat that polls never asks twice. */
const previews = new Map<string, Kept<Preview>>();
const posts = new Map<string, Kept<Post>>();
/** The most answers one of those keeps: the oldest goes first. */
const MAX_KEPT = 400;
/** An answer that may change (the site or X could not be reached, too many requests) is asked for again after this long. */
const RETRY_MS = 60_000;
/** Links asked about at once. A chat full of links waits its turn rather than sending them all together. */
const MAX_ASKING = 4;

let asking = 0;
const queued: Array<() => void> = [];

function inTurn<T>(run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      asking++;
      run()
        .then(resolve, reject)
        .finally(() => {
          asking--;
          queued.shift()?.();
        });
    };
    if (asking < MAX_ASKING) start();
    else queued.push(start);
  });
}

/** The answer already here for `key`, if it still stands. */
function kept<T>(store: Map<string, Kept<T>>, key: string): Kept<T> | null {
  const known = store.get(key);
  return known && (known.answer === null || known.until > Date.now()) ? known : null;
}

function ask<T>(store: Map<string, Kept<T>>, key: string, path: string, guard: (value: unknown) => value is T): Kept<T> {
  const known = kept(store, key);
  if (known) return known;
  const entry: Kept<T> = {
    answer: null,
    until: Number.POSITIVE_INFINITY,
    asked: inTurn(() => api<unknown>(path)).then(
      (body): Answer<T> => (guard(body) ? { state: "ready", data: body } : { state: "failed", status: 0 }),
      (cause: unknown): Answer<T> => ({ state: "failed", status: cause instanceof ApiError ? cause.status : 0 }),
    ),
  };
  void entry.asked.then((answer) => {
    entry.answer = answer;
    // "Nothing to show" and "no such post" stand; a failure that may pass is asked about again later.
    const settled = answer.state === "ready" || (answer.status >= 400 && answer.status < 500 && answer.status !== 401 && answer.status !== 408 && answer.status !== 429);
    entry.until = settled ? Number.POSITIVE_INFINITY : Date.now() + RETRY_MS;
  });
  store.delete(key);
  store.set(key, entry);
  if (store.size > MAX_KEPT) {
    const oldest = store.keys().next();
    if (!oldest.done) store.delete(oldest.value);
  }
  return entry;
}

/** What the API says about `key`, asked once. Null while it is being asked, and for no key at all. */
function useAsked<T>(store: Map<string, Kept<T>>, key: string | null, path: string, guard: (value: unknown) => value is T): Answer<T> | null {
  const [seen, setSeen] = useState<{ key: string | null; answer: Answer<T> | null }>(() => ({ key, answer: key === null ? null : kept(store, key)?.answer ?? null }));
  useEffect(() => {
    if (key === null) {
      setSeen((previous) => (previous.key === null ? previous : { key, answer: null }));
      return;
    }
    const entry = ask(store, key, path, guard);
    setSeen((previous) => (previous.key === key && previous.answer === entry.answer ? previous : { key, answer: entry.answer }));
    if (entry.answer !== null) return;
    let current = true;
    void entry.asked.then((answer) => current && setSeen({ key, answer }));
    return () => {
      current = false;
    };
  }, [store, key, path, guard]);
  // An answer for the link shown before is not this link's.
  return seen.key === key ? seen.answer : null;
}

/** Control characters, zero-width and text-direction marks: never part of what a page or a post is shown as. */
const REMOVED = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;

/** Fetched text as one clean line of at most `most` characters. Null when nothing is left. */
function line(raw: string | null, most: number): string | null {
  if (raw === null) return null;
  const clean = raw.replace(REMOVED, "").replace(/\s+/g, " ").trim();
  if (clean === "") return null;
  const characters = [...clean];
  return characters.length > most ? `${characters.slice(0, most).join("")}…` : clean;
}

const hostOf = (href: string): string => {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// A web page as a card
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The picture of a preview. Its bytes come through this site's API, signed in, and only once the card is on
 * screen; it is shown through an object address that is let go of when the card leaves the page.
 */
function PreviewPicture({ url }: { url: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const abort = new AbortController();
    let made: string | null = null;
    const load = () => {
      apiBlob(`/api/preview/image?url=${encodeURIComponent(url)}`, abort.signal).then(
        (blob) => {
          if (abort.signal.aborted) return;
          if (!blob.type.startsWith("image/")) {
            setFailed(true);
            return;
          }
          made = URL.createObjectURL(blob);
          setShown(made);
        },
        () => {
          if (!abort.signal.aborted) setFailed(true);
        },
      );
    };
    let observer: IntersectionObserver | null = null;
    if (typeof IntersectionObserver === "function") {
      observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          observer?.disconnect();
          observer = null;
          load();
        },
        { rootMargin: "200px" },
      );
      observer.observe(element);
    } else load();
    return () => {
      observer?.disconnect();
      abort.abort();
      if (made !== null) URL.revokeObjectURL(made);
    };
  }, [url]);
  // A picture that could not be had leaves the card to its words.
  if (failed) return null;
  return (
    <span className="link-preview-picture" ref={box} data-testid="link-preview-picture" data-loaded={shown !== null}>
      {shown !== null && <img src={shown} alt="" decoding="async" onError={() => setFailed(true)} />}
    </span>
  );
}

function PagePreview({ href, onReady }: { href: string; onReady?: (() => void) | undefined }) {
  const answer = useAsked(previews, href, `/api/preview?url=${encodeURIComponent(href)}`, isPreview);
  const page = answer?.state === "ready" ? answer.data : null;
  const ready = useRef(onReady);
  ready.current = onReady;
  useLayoutEffect(() => {
    if (page) ready.current?.();
  }, [page]);
  // A preview is an extra: while it loads, and when there is none, the link in the text is all there is.
  if (!page) return null;
  const host = hostOf(href);
  const site = line(page.site, 60);
  const title = line(page.title, 160);
  const description = line(page.description, 300);
  const image = page.image !== null && /^https:\/\//i.test(page.image) ? page.image : null;
  return (
    <a className="link-preview" data-testid="link-preview" href={href} target="_blank" rel="noopener noreferrer nofollow">
      {image !== null && <PreviewPicture key={image} url={image} />}
      <span className="link-preview-text">
        {/* The host is this link's own, whatever the page calls itself. */}
        <span className="link-preview-site" data-testid="link-preview-site">{site !== null && site.toLowerCase() !== host.toLowerCase() ? `${site} · ${host}` : host}</span>
        {title !== null && <strong className="link-preview-title" data-testid="link-preview-title">{title}</strong>}
        {description !== null && <span className="link-preview-description" data-testid="link-preview-description">{description}</span>}
      </span>
    </a>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// A post on X as a card
// ─────────────────────────────────────────────────────────────────────────────

function XMark() {
  return (
    <svg className="post-mark" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

/** When a post was made, as X gave it: a date this browser can read is shown in the reader's own format, anything else as it came. */
function PostDate({ date }: { date: string | null }) {
  const clean = line(date, 40);
  if (clean === null) return null;
  const at = Date.parse(clean);
  if (Number.isNaN(at)) return <span className="post-date" data-testid="post-preview-date">{clean}</span>;
  const day = new Date(at);
  const format: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };
  // A date without a time of day is a day, not midnight: "2026-11-20" is read as that day in UTC, and shown as that day.
  let shown: string;
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) shown = day.toLocaleDateString(undefined, { ...format, timeZone: "UTC" });
  else if (!/\d:\d/.test(clean)) shown = day.toLocaleDateString(undefined, format);
  else shown = day.toLocaleString(undefined, { ...format, hour: "numeric", minute: "2-digit" });
  return <time className="post-date" data-testid="post-preview-date" dateTime={day.toISOString()}>{shown}</time>;
}

/**
 * A post on X. `quiet` is for a chat, where a preview is an extra: nothing shows until the post is read, and
 * nothing at all when it cannot be. Otherwise the card says where it stands, with the plain link beside it.
 */
function PostCard({ url, quiet, onReady }: { url: string; quiet: boolean; onReady?: (() => void) | undefined }) {
  const signedIn = useSignedIn(useWallet().account);
  const address = useMemo(() => postAddress(url), [url]);
  const answer = useAsked(posts, signedIn && address ? address.url : null, `/api/preview/post?url=${encodeURIComponent(address?.url ?? "")}`, isPost);
  const post = answer?.state === "ready" ? answer.data : null;
  const ready = useRef(onReady);
  ready.current = onReady;
  useLayoutEffect(() => {
    if (post) ready.current?.();
  }, [post]);

  // Not a post on X: the address as text, a link only if it is a web address.
  if (!address) return quiet ? null : <LinkedText text={url} className="post-plain" />;
  if (quiet && !post) return null;

  const state = !signedIn ? "signed-out" : answer === null ? "loading" : answer.state === "ready" ? "ready" : answer.status === 404 ? "missing" : "unreachable";
  const given = post?.handle?.replace(/^@/, "") ?? null;
  const handle = given !== null && HANDLE.test(given) ? given : address.handle;
  const author = line(post?.authorName ?? null, 60);
  const body = post ? post.text.replace(REMOVED, "").trim() : "";
  return (
    <article className="post-preview" data-testid="post-preview" data-state={state} aria-busy={state === "loading"}>
      <header className="post-head">
        <XMark />
        <span className="post-author">
          {author !== null && <strong data-testid="post-preview-author">{author}</strong>}
          {handle !== null && <span className="post-handle" data-testid="post-preview-handle">@{handle}</span>}
          {author === null && handle === null && <span className="post-handle">Post on X</span>}
        </span>
      </header>
      {state === "loading" && (
        <p className="post-wait" role="status">
          <span className="post-skeleton" aria-hidden="true" />
          <span className="visually-hidden">Reading the post from X…</span>
        </p>
      )}
      {state === "ready" && body !== "" && <p className="post-text" data-testid="post-preview-text"><LinkedText text={body} /></p>}
      {state === "missing" && <p className="post-said" role="status" data-testid="post-preview-said">X says this post does not exist.</p>}
      {state === "unreachable" && <p className="post-said" role="status" data-testid="post-preview-said">X could not be asked right now.</p>}
      {state === "signed-out" && <p className="post-said" data-testid="post-preview-said">Sign in to read the post here.</p>}
      <footer className="post-foot">
        {post && <PostDate date={post.date} />}
        <a className="post-open" data-testid="post-preview-open" href={address.url} target="_blank" rel="noopener noreferrer nofollow">Open on X ↗</a>
      </footer>
    </article>
  );
}

/** A post on X, read through this site's API and drawn like the post it is: who, what, when, and the way to it on X. */
export function PostPreview({ url }: { url: string }) {
  return <PostCard url={url} quiet={false} />;
}

/**
 * A card for each of the first `limit` different links in `text`: the page it leads to, or the post when it is
 * a post on X. Only for a signed-in wallet, since the API asks for one. It shows nothing while it loads and
 * nothing when there is nothing to show. `onReady` is called when a card has taken its place on the page.
 */
export function LinkPreviews({ text, limit = 2, onReady }: { text: string; limit?: number; onReady?: () => void }) {
  const signedIn = useSignedIn(useWallet().account);
  const links = useMemo(() => linksIn(text, limit), [text, limit]);
  if (!signedIn || links.length === 0) return null;
  return (
    <>
      {links.map((link) =>
        link.post ? <PostCard key={link.post.url} url={link.post.url} quiet onReady={onReady} /> : <PagePreview key={link.href} href={link.href} onReady={onReady} />,
      )}
    </>
  );
}
