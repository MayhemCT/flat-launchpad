/**
 * `/api/preview...`: what a link in a chat points at, read by the Worker so no visitor's browser talks to the
 * linked site.
 *
 * Signed in (`Authorization: Bearer <token>`, see apps/worker/src/session.ts), GET only:
 *   GET /api/preview?url=<url>             → { url, site, title, description, image } for a web page: its title,
 *                                            description and preview picture, as plain text and one https address.
 *                                            For a link that is itself a picture: the picture, and no text.
 *   GET /api/preview/post?url=<x post url> → { url, handle, authorName, text, date } for a post on X, from X's
 *                                            public embed endpoint, which needs no key.
 *   GET /api/preview/image?url=<https url> → the bytes of a PNG, JPEG, WebP or GIF of at most 2 MB. This is how
 *                                            the page shows the `image` of a preview from its own origin.
 *
 * These routes fetch addresses that people typed, so every request this file makes follows the same rules:
 *
 *   - Only `https:` is fetched. An address without a scheme is read as https, `http:` is upgraded, and every
 *     other scheme is refused.
 *   - The host must be a public DNS name: at least two labels, ending in a top-level label of letters only.
 *     That refuses every IP address in any spelling, `localhost`, single-label hosts and the names private
 *     networks use. An address with a username, a password or a port other than 443 is refused, and so are
 *     this site's own hosts, so the Worker never calls itself. See `previewTarget`.
 *   - Redirects are not followed by the runtime. This file follows three at most, and holds every `Location`
 *     to the same rules before it is fetched.
 *   - One chain of requests has 6 seconds in all. A body is read through a streaming reader up to its cap
 *     (256 KB of a page, 2 MB of a picture, 64 KB of X's answer) and the rest is cancelled.
 *   - A request carries a user agent and an `accept` header and nothing else: no cookie, no credential, and
 *     nothing of the visitor who asked.
 *   - Nothing of the answer is passed on as it came: no upstream header, no HTML. A page is read for a few
 *     `<meta>` tags and its `<title>`, which leave here as plain text. `<meta http-equiv="refresh">` is never
 *     followed. A picture is passed on only when its first bytes say it is one of the four kinds, and is
 *     served as exactly that kind under a policy that lets it run nothing.
 *
 * Answers are kept in the Workers Cache for a day ("there is nothing to show" for ten minutes) under the
 * SHA-256 of the address they were read from. An answer says nothing about who asked, so one copy serves
 * everyone; the session is still checked before the cache is.
 *
 * There is no limit per wallet: counting requests needs a table, and this API has none for it. What stands in
 * its place is that every route needs a session, and that every limit above is tight: one preview costs at
 * most four requests, 6 seconds and 2 MB, and the same address is fetched once a day.
 */
import { cleanBody } from './chat.js'
import { parsePostUrl, pictureType } from './rooms.js'
import { failure, sessionWallet, sha256Hex, signInFirst } from './session.js'

export interface PreviewEnv {
  DB: D1Database
}

/** The longest address taken, as typed and as fetched. */
export const MAX_URL_LENGTH = 2000
export const MAX_TITLE_LENGTH = 200
export const MAX_DESCRIPTION_LENGTH = 300
/** How much of a page is read. The tags a preview is made of stand in the head. */
export const MAX_PAGE_BYTES = 262_144
/** The largest picture passed on. */
export const MAX_PICTURE_BYTES = 2_097_152
export const MAX_REDIRECTS = 3
const MAX_OEMBED_BYTES = 65_536
const MAX_SITE_LENGTH = 80
const MAX_AUTHOR_LENGTH = 100
/** A post on X can run to thousands of characters; a preview shows the start of it. */
const MAX_POST_LENGTH = 1000
const MAX_DATE_LENGTH = 40
const TIMEOUT_MS = 6000
const KEPT_SECONDS = 86_400
const NOTHING_KEPT_SECONDS = 600
const USER_AGENT = 'CallZ-LinkPreview/1.0 (+https://callz.fun)'
const ACCEPT_PAGE = 'text/html, image/png, image/jpeg, image/webp, image/gif;q=0.9, */*;q=0.1'
const ACCEPT_PICTURE = 'image/png, image/jpeg, image/webp, image/gif'
const ACCEPT_JSON = 'application/json'
const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])

// ─────────────────────────────────────────────────────────────────────────────
// The address
// ─────────────────────────────────────────────────────────────────────────────

/** Last labels that are no public top-level domain: names of private networks, of this machine, and reserved ones. */
const PRIVATE_SUFFIXES: ReadonlySet<string> = new Set([
  'local',
  'localhost',
  'localdomain',
  'internal',
  'intranet',
  'private',
  'corp',
  'lan',
  'home',
  'arpa',
  'onion',
  'test',
  'example',
  'invalid',
])
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const TOP_LABEL = /^[a-z]{2,63}$/
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
/** "mailto:x", "javascript:x": a scheme without slashes. "example.com:8443" is a host and a port instead. */
const BARE_SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d)/i

/** True for a host this Worker may fetch: a public DNS name that is not this site. `host` is lowercase. */
function publicHost(host: string): boolean {
  if (host.length > 253) return false
  const labels = host.split('.')
  // One label is a name on a local network. An IP address in any spelling ends in a label that is not letters.
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return false
  const top = labels[labels.length - 1]!
  if (!TOP_LABEL.test(top) || PRIVATE_SUFFIXES.has(top)) return false
  if (host === 'callz.fun' || host.endsWith('.callz.fun')) return false
  if (host === 'workers.dev' || host.endsWith('.workers.dev')) return false
  return true
}

/**
 * The address a link stands for, as the one https URL this Worker may fetch. Null for anything else: see the
 * rules at the top of this file. The fragment is dropped: it is never sent to a server.
 */
export function previewTarget(raw: unknown): URL | null {
  if (typeof raw !== 'string') return null
  const typed = raw.trim()
  if (typed === '' || typed.length > MAX_URL_LENGTH) return null
  // A space, a control character or a backslash is in no address a person means, and parsers disagree on them.
  if (/[\s\u0000-\u001F\u007F\\]/.test(typed)) return null
  let spelled: string
  if (HAS_SCHEME.test(typed)) {
    if (!/^https?:\/\/[^/]/i.test(typed)) return null
    spelled = typed
  } else {
    if (BARE_SCHEME.test(typed) || typed.startsWith('/')) return null
    spelled = `https://${typed}`
  }
  let url: URL
  try {
    url = new URL(spelled)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.username !== '' || url.password !== '') return null
  // The parser has dropped the port that is the default of the scheme typed. Any other must be 443.
  if (url.port !== '' && url.port !== '443') return null
  url.protocol = 'https:'
  url.port = ''
  url.hash = ''
  // The parser has turned every spelling of an IP address (decimal, hex, octal, bracketed) into its plain one.
  if (!publicHost(url.hostname)) return null
  if (url.protocol !== 'https:' || url.port !== '' || url.href.length > MAX_URL_LENGTH) return null
  return url
}

// ─────────────────────────────────────────────────────────────────────────────
// Text
// ─────────────────────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  deg: '°',
  times: '×',
}

/** Character references read back into characters, once. One that names nothing stays as it was written. */
function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,8}));/gi, (whole, decimal?: string, hexadecimal?: string, name?: string) => {
    if (name) return ENTITIES[name.toLowerCase()] ?? whole
    const point = decimal ? Number(decimal) : Number.parseInt(hexadecimal ?? '', 16)
    return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole
  })
}

/**
 * Text from somebody else's page as it is shown: one line, nothing invisible in it, every run of white space
 * one space, `max` characters at most. Null when nothing is left. It is text and stays text: the page shows it
 * as text, so markup in it is letters and nothing more.
 */
function plain(raw: string | null | undefined, max: number): string | null {
  if (typeof raw !== 'string') return null
  const text = cleanBody(raw.replace(/\s+/g, ' ')).replace(/ {2,}/g, ' ')
  const cut = [...text].slice(0, max).join('').trim()
  return cut === '' ? null : cut
}

// ─────────────────────────────────────────────────────────────────────────────
// A page
// ─────────────────────────────────────────────────────────────────────────────

export interface PageMeta {
  title: string | null
  description: string | null
  /** The address of the preview picture as the page wrote it: not yet resolved, not yet checked. */
  image: string | null
  site: string | null
}

/** Elements whose contents are not markup of the page: a `<meta` written inside one is not a tag. */
const OPAQUE: ReadonlySet<string> = new Set(['script', 'style', 'textarea', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'template', 'svg', 'math'])

const asciiLower = (text: string): string => text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase())
const isSpace = (code: number): boolean => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d

/**
 * The attributes of the tag whose name ends at `from`, and where the tag ends. A `>` inside a quoted value
 * does not end the tag. Each character is looked at once.
 */
function readTag(html: string, from: number): { attributes: Map<string, string>; end: number } {
  const attributes = new Map<string, string>()
  let at = from
  for (;;) {
    while (at < html.length && (isSpace(html.charCodeAt(at)) || html[at] === '/')) at++
    if (at >= html.length) return { attributes, end: html.length }
    if (html[at] === '>') return { attributes, end: at + 1 }
    const nameStart = at
    // A name may begin with "=": the parser of a browser reads it that way too.
    at++
    while (at < html.length && !isSpace(html.charCodeAt(at)) && html[at] !== '=' && html[at] !== '>' && html[at] !== '/') at++
    const name = asciiLower(html.slice(nameStart, at))
    while (at < html.length && isSpace(html.charCodeAt(at))) at++
    let value = ''
    if (html[at] === '=') {
      at++
      while (at < html.length && isSpace(html.charCodeAt(at))) at++
      const quote = html[at]
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, at + 1)
        value = html.slice(at + 1, close < 0 ? html.length : close)
        at = close < 0 ? html.length : close + 1
      } else {
        const valueStart = at
        while (at < html.length && !isSpace(html.charCodeAt(at)) && html[at] !== '>') at++
        value = html.slice(valueStart, at)
      }
    }
    // The first of two attributes with one name is the one that counts.
    if (!attributes.has(name)) attributes.set(name, value)
  }
}

/**
 * What a page says about itself, for a preview: Open Graph tags first, then the ones X reads, then the page's
 * own `<title>` and description. The markup is walked once, as text; nothing in it is run, and comments,
 * scripts and the like are stepped over, so a tag written inside one is not read.
 */
export function readPageMeta(html: string): PageMeta {
  const lower = asciiLower(html)
  const metas = new Map<string, string>()
  let title: string | null = null
  let at = 0
  for (;;) {
    const open = lower.indexOf('<', at)
    if (open < 0) break
    if (lower.startsWith('<!--', open)) {
      const close = lower.indexOf('-->', open + 4)
      if (close < 0) break
      at = close + 3
      continue
    }
    let nameEnd = open + 1
    while (nameEnd < lower.length && nameEnd - open <= 16 && /[a-z0-9]/.test(lower[nameEnd]!)) nameEnd++
    const name = lower.slice(open + 1, nameEnd)
    if (name === '' || !/^[a-z]/.test(name)) {
      at = open + 1
      continue
    }
    const { attributes, end } = readTag(html, nameEnd)
    at = end
    if (name === 'meta') {
      const content = plain(decodeEntities(attributes.get('content') ?? ''), 2 * MAX_URL_LENGTH)
      if (content === null) continue
      for (const key of [attributes.get('property'), attributes.get('name')]) {
        const named = key === undefined ? '' : asciiLower(key.trim())
        if (named !== '' && !metas.has(named)) metas.set(named, content)
      }
    } else if (name === 'title' || OPAQUE.has(name)) {
      const close = lower.indexOf(`</${name}`, end)
      // The contents of a title are text, whatever they look like.
      if (name === 'title' && title === null) title = plain(decodeEntities(html.slice(end, close < 0 ? html.length : close)), MAX_TITLE_LENGTH)
      if (close < 0) break
      at = close + 2
    }
  }
  const first = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = metas.get(key)
      if (value !== undefined) return value
    }
    return null
  }
  return {
    title: plain(first('og:title', 'twitter:title'), MAX_TITLE_LENGTH) ?? title,
    description: plain(first('og:description', 'twitter:description', 'description'), MAX_DESCRIPTION_LENGTH),
    image: first('og:image', 'og:image:secure_url', 'og:image:url', 'twitter:image', 'twitter:image:src'),
    site: plain(first('og:site_name'), MAX_SITE_LENGTH),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// A post on X
// ─────────────────────────────────────────────────────────────────────────────

const tagsOut = (markup: string): string => decodeEntities(markup.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ''))

/**
 * What a post says, as it is shown: the post's own paragraph out of the markup X's embed endpoint returns,
 * with its capitals kept, its line breaks as spaces, the links X wraps mentions, hashtags and cashtags in
 * taken off, and character references read back into characters. Null when the markup holds no paragraph.
 * (`postText` in rooms.ts reads the same paragraph in one case, for comparing.)
 */
export function postWords(html: string): string | null {
  const paragraph = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(html)?.[1]
  return paragraph === undefined ? null : plain(tagsOut(paragraph), MAX_POST_LENGTH)
}

/** When a post was made, as X writes it under the post ("March 21, 2006"): the text of the last link after the paragraph. */
export function postDate(html: string): string | null {
  const close = html.search(/<\/p>/i)
  if (close < 0) return null
  let last: string | null = null
  for (const match of html.slice(close).matchAll(/<a\b[^>]*>([^<]*)<\/a>/gi)) last = match[1] ?? null
  return plain(last === null ? null : decodeEntities(last), MAX_DATE_LENGTH)
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetching
// ─────────────────────────────────────────────────────────────────────────────

interface Fetched {
  /** Where the answer came from, after the redirects. */
  url: URL
  status: number
  /** The media type the server named, lowercase, without its parameters. */
  type: string
  charset: string | null
  /** The body, up to the cap. */
  bytes: Uint8Array
  /** True when the body was longer than the cap and the rest was dropped. */
  cut: boolean
}

/** A body up to `max` bytes; the rest is cancelled, unread. */
async function readUpTo(response: Response, max: number): Promise<{ bytes: Uint8Array; cut: boolean }> {
  const reader = response.body?.getReader()
  if (!reader) return { bytes: new Uint8Array(0), cut: false }
  const chunks: Uint8Array[] = []
  let size = 0
  let cut = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.byteLength
    if (size > max) {
      cut = true
      // Not waited for: the rest is dropped whether or not the other side says so.
      void reader.cancel().catch(() => undefined)
      break
    }
  }
  const bytes = new Uint8Array(Math.min(size, max))
  let offset = 0
  for (const chunk of chunks) {
    const room = bytes.byteLength - offset
    if (room <= 0) break
    bytes.set(chunk.byteLength > room ? chunk.subarray(0, room) : chunk, offset)
    offset += Math.min(chunk.byteLength, room)
  }
  return { bytes, cut }
}

/**
 * The one way this file reaches another server. `start` has passed `previewTarget`; so does every address a
 * redirect names before it is asked. Null when the server could not be reached in time, or sent the request
 * somewhere it may not go, or on a fourth redirect.
 */
async function fetchPublic(start: URL, accept: string, maxBytes: number, fetcher: typeof fetch): Promise<Fetched | null> {
  // One clock for the whole chain, bodies included.
  const signal = AbortSignal.timeout(TIMEOUT_MS)
  let url = start
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      // Only these two headers are sent. The runtime adds no cookie, and none is kept between requests.
      const response = await fetcher(url.href, { method: 'GET', headers: { 'user-agent': USER_AGENT, accept }, redirect: 'manual', signal })
      if (REDIRECTS.has(response.status)) {
        void response.body?.cancel().catch(() => undefined)
        const location = response.headers.get('location')
        if (location === null || location.length > MAX_URL_LENGTH) return null
        let next: URL | null
        try {
          next = previewTarget(new URL(location, url).href)
        } catch {
          next = null
        }
        if (!next) return null
        url = next
        continue
      }
      const header = response.headers.get('content-type') ?? ''
      const { bytes, cut } = await readUpTo(response, maxBytes)
      return {
        url,
        status: response.status,
        type: header.split(';')[0]!.trim().toLowerCase(),
        charset: /;\s*charset\s*=\s*"?([a-z0-9._:-]{1,40})/i.exec(header)?.[1] ?? null,
        bytes,
        cut,
      }
    }
    return null
  } catch {
    return null
  }
}

/** A page's bytes as text, in the encoding its server named; UTF-8 when it named none or one nobody knows. */
function decodePage(bytes: Uint8Array, charset: string | null): string {
  if (charset !== null) {
    try {
      return new TextDecoder(charset).decode(bytes)
    } catch {
      // An unknown label: read as UTF-8 below.
    }
  }
  return new TextDecoder().decode(bytes)
}

// ─────────────────────────────────────────────────────────────────────────────
// The cache
// ─────────────────────────────────────────────────────────────────────────────

/** An answer as it is kept and made again: nothing in it depends on who asked. */
interface Answer {
  status: number
  type: string
  body: Uint8Array
}

const STATUS_HEADER = 'x-preview-status'

const answerJson = (body: unknown, status = 200): Answer => ({ status, type: 'application/json; charset=utf-8', body: new TextEncoder().encode(JSON.stringify(body)) })
const answerError = (status: number, message: string): Answer => answerJson({ error: message }, status)

/** The response a visitor gets for an answer: JSON as every route of this API sends it, a picture as a picture and nothing else. */
function respond(answer: Answer): Response {
  if (answer.type.startsWith('application/json')) {
    return new Response(answer.body, { status: answer.status, headers: { 'content-type': answer.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
  }
  return new Response(answer.body, {
    status: answer.status,
    headers: {
      'content-type': answer.type,
      'content-length': String(answer.body.byteLength),
      'cache-control': 'private, max-age=86400',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'content-disposition': 'inline',
      'cross-origin-resource-policy': 'same-origin',
    },
  })
}

/** The Workers Cache, where there is one. */
const edgeCache = (): Cache | null => (globalThis as { caches?: CacheStorage }).caches?.default ?? null

async function cacheKey(request: Request, kind: string, address: string): Promise<Request> {
  return new Request(`${new URL(request.url).origin}/api/preview/kept/${kind}/${await sha256Hex(new TextEncoder().encode(address))}`)
}

async function kept(key: Request): Promise<Answer | null> {
  const cached = await edgeCache()?.match(key)
  if (!cached) return null
  const status = Number(cached.headers.get(STATUS_HEADER))
  const type = cached.headers.get('content-type')
  if (!Number.isInteger(status) || status < 200 || status > 599 || type === null) return null
  return { status, type, body: new Uint8Array(await cached.arrayBuffer()) }
}

/** Keeps an answer for `seconds`. It is stored as a 200 with its own status beside it: the cache keeps those for as long as they say. */
function keep(ctx: ExecutionContext, key: Request, answer: Answer, seconds: number): void {
  const cache = edgeCache()
  if (!cache) return
  const stored = new Response(answer.body, { headers: { 'content-type': answer.type, 'cache-control': `public, max-age=${seconds}`, [STATUS_HEADER]: String(answer.status) } })
  ctx.waitUntil(cache.put(key, stored).catch(() => undefined))
}

/** Answers from the cache, or with what `read` finds, kept when it is an answer worth keeping. */
async function answered(request: Request, ctx: ExecutionContext, kind: string, address: string, read: () => Promise<Answer>): Promise<Response> {
  const key = await cacheKey(request, kind, address)
  const known = await kept(key)
  if (known) return respond(known)
  const answer = await read()
  if (answer.status === 200) keep(ctx, key, answer, KEPT_SECONDS)
  // "Nothing there" is kept for a short while. "Could not be asked" is not kept at all.
  else if (answer.status === 404 || answer.status === 415) keep(ctx, key, answer, NOTHING_KEPT_SECONDS)
  return respond(answer)
}

// ─────────────────────────────────────────────────────────────────────────────
// The three routes
// ─────────────────────────────────────────────────────────────────────────────

const NOTHING_TO_SHOW = 'That page has nothing to show as a preview.'
const UNREACHABLE = 'That page could not be reached.'

async function readPage(target: URL, fetcher: typeof fetch): Promise<Answer> {
  const fetched = await fetchPublic(target, ACCEPT_PAGE, MAX_PAGE_BYTES, fetcher)
  if (!fetched) return answerError(502, UNREACHABLE)
  if (fetched.status < 200 || fetched.status > 299) return answerError(404, NOTHING_TO_SHOW)
  const url = fetched.url.href
  const host = fetched.url.hostname
  // The link is a picture itself. Whether it is small enough to show is for the picture route to say.
  if (pictureType(fetched.bytes)) return answerJson({ url, site: host, title: null, description: null, image: url })
  if (fetched.type !== 'text/html') return answerError(404, NOTHING_TO_SHOW)
  const meta = readPageMeta(decodePage(fetched.bytes, fetched.charset))
  let image: string | null = null
  if (meta.image !== null) {
    try {
      image = previewTarget(new URL(meta.image, fetched.url).href)?.href ?? null
    } catch {
      image = null
    }
  }
  if (meta.title === null && meta.description === null && image === null) return answerError(404, NOTHING_TO_SHOW)
  return answerJson({ url, site: meta.site ?? host, title: meta.title, description: meta.description, image })
}

async function readPost(post: { url: string; handle: string }, fetcher: typeof fetch): Promise<Answer> {
  const unreachable = () => answerError(502, 'X could not be asked about that post right now. Try again in a moment.')
  const endpoint = previewTarget(`https://publish.x.com/oembed?url=${encodeURIComponent(post.url)}&omit_script=1&dnt=1`)
  if (!endpoint) return unreachable()
  const fetched = await fetchPublic(endpoint, ACCEPT_JSON, MAX_OEMBED_BYTES, fetcher)
  if (!fetched) return unreachable()
  // X answers 404 for a post that does not exist or was deleted, and 403 for one that is not public.
  if (fetched.status === 404 || fetched.status === 403) return answerError(404, 'X says there is no such post. It may be deleted, or from an account that is not public.')
  if (fetched.status < 200 || fetched.status > 299 || fetched.cut) return unreachable()
  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(fetched.bytes))
  } catch {
    return unreachable()
  }
  const { html, author_url: authorUrl, author_name: authorName } = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
  if (typeof html !== 'string') return unreachable()
  const text = postWords(html)
  if (text === null) return unreachable()
  // The handle as its owner spells it, where X says; as the link spells it otherwise.
  const handle = typeof authorUrl === 'string' ? /^https:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})$/.exec(authorUrl)?.[1] ?? post.handle : post.handle
  return answerJson({ url: post.url, handle, authorName: plain(typeof authorName === 'string' ? authorName : null, MAX_AUTHOR_LENGTH), text, date: postDate(html) })
}

async function readPicture(target: URL, fetcher: typeof fetch): Promise<Answer> {
  const notPicture = () => answerError(415, `Only a PNG, JPEG, WebP or GIF of at most ${MAX_PICTURE_BYTES / 1_048_576} MB is shown.`)
  const fetched = await fetchPublic(target, ACCEPT_PICTURE, MAX_PICTURE_BYTES, fetcher)
  if (!fetched) return answerError(502, 'That picture could not be reached.')
  if (fetched.status < 200 || fetched.status > 299 || fetched.cut) return notPicture()
  // What the bytes are is read from the bytes. What the server calls them is not asked.
  const type = pictureType(fetched.bytes)
  return type ? { status: 200, type, body: fetched.bytes } : notPicture()
}

/** Routes `/api/preview...`. `fetcher` is how other servers are reached. */
export async function handlePreview(request: Request, env: PreviewEnv, ctx: ExecutionContext, fetcher: typeof fetch = fetch): Promise<Response> {
  if (request.method !== 'GET') return failure(405, 'Method not allowed.', { allow: 'GET' })
  const url = new URL(request.url)
  const route = url.pathname === '/api/preview' ? 'page' : url.pathname === '/api/preview/post' ? 'post' : url.pathname === '/api/preview/image' ? 'image' : null
  if (!route) return failure(404, 'Not found.')

  try {
    if (!(await sessionWallet(request, env.DB))) return signInFirst()
    const target = previewTarget(url.searchParams.get('url'))
    // Whatever name this Worker answers to, it does not call itself.
    if (!target || target.hostname === url.hostname) return failure(400, 'url must be a link to a public web page: https, a domain name, no port and no password.')
    if (route === 'post') {
      const post = parsePostUrl(target.href)
      if (!post) return failure(400, 'url must be the link to a post on X: https://x.com/<name>/status/<number>.')
      return await answered(request, ctx, route, post.url, () => readPost(post, fetcher))
    }
    return await answered(request, ctx, route, target.href, () => (route === 'page' ? readPage(target, fetcher) : readPicture(target, fetcher)))
  } catch (error) {
    console.error(JSON.stringify({ previewFailed: String(error).slice(0, 500) }))
    return failure(500, 'Link previews are unavailable right now. Try again in a moment.')
  }
}
