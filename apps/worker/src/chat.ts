/**
 * `/api/chat/<chain>/<token>`: two chat rooms per token. Anyone can read both. Anyone can post in the public
 * one; in the holder room only a wallet that holds the token at that moment can.
 *
 *   GET  ?room=<room>&after=<id>&limit=<n>         messages, oldest first. Without `after` the newest `limit`;
 *                                                  with it, only messages with a larger id, for polling.
 *                                                  Each carries its author's display name, null for a
 *                                                  wallet without one.
 *   POST ?room=<room>                              stores one message: { author, body, issuedAt, signature }.
 *
 * `room` is `public` (the default) or `holders`. Each room has its own signing text, so a signature made for
 * one is never a signature for the other. The holder room reads the author's balance from the token itself,
 * after the signature has verified, and never takes a balance it could not read for one of zero.
 *
 * Nobody logs in. A message is accepted when its author's wallet signed its exact text (EIP-191
 * `personal_sign`) within the last few minutes, and that signature has not been used before. The page calls
 * this from its own origin only, so no CORS header is ever sent.
 *
 * Nothing a visitor types can become code. Every value reaches the database as a bound parameter of a
 * prepared statement, never as part of the SQL text, so there is nothing to inject into. A message is plain
 * text with control and invisible characters removed, links are refused, and the page shows it as a text
 * node: it is never parsed as HTML and never turned into a link.
 */
import { CHAINS, isChainKey, type ChainKey } from '@flat/protocol'
import { verifyMessage, type Address, type Hex } from 'viem'
import { balanceOf, bscRpc, type MarketEnv } from './market.js'

/** The part of the Worker's environment chat uses. */
export interface ChatEnv extends MarketEnv {
  DB: D1Database
}

/** A token's rooms: the one anyone can post in, and the one only its holders can. */
export type ChatRoom = 'public' | 'holders'

/** The room a request's `room` parameter names: the public one when there is none, null for anything else. */
export function chatRoomOf(value: string | null): ChatRoom | null {
  if (value === null || value === 'public') return 'public'
  return value === 'holders' ? 'holders' : null
}

/** Longest message, in characters (Unicode code points) after cleaning. */
export const MAX_BODY_LENGTH = 280
/** How far a message's `issuedAt` may be from the server clock, in seconds, either way. */
export const ISSUED_AT_WINDOW = 300

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const MAX_REQUEST_BYTES = 4096
// The rate limit is per author, across every room.
const MIN_GAP_SECONDS = 5
const HOUR_SECONDS = 3600
const MAX_PER_HOUR = 30

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/
/** The order of the secp256k1 group, and half of it. */
const CURVE_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const HALF_CURVE_ORDER = CURVE_ORDER >> 1n

/**
 * Characters that never reach a message: control characters (which include tabs and line breaks), zero-width
 * and text-direction marks, and unpaired surrogates, which are not text at all.
 */
const REMOVED = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩\uD800-\uDFFF]/gu

/**
 * A message body as it is signed, stored and shown: one line, with nothing invisible in it.
 * Keep in sync with `cleanBody` in apps/web/src/chat.tsx: the page signs the text this produces.
 */
export function cleanBody(raw: string): string {
  return raw.replace(REMOVED, '').trim()
}

/**
 * Top-level domains for which a bare "name.tld" counts as a link. Anything with a scheme ("https://", "tg://"),
 * a "www." or a numeric address is caught without this list.
 */
const LINK_TLDS =
  'com|net|org|io|co|xyz|fun|me|gg|app|ai|dev|sh|to|tv|cc|ly|link|site|online|top|club|vip|pro|info|biz|finance|exchange|money|trade|bet|win|lol|wtf|meme|family|network|page|store|live|life|world|tech|cloud|social|chat|group|team|zone|art|run|one|xxx|ru|cn|uk|us|eu|de|fr|jp|kr|in|id|vn|th|ph|tr|br|ua|pl|nl|es|it|ca|au|sg|hk|tw|im|is|ws|bz|ag|la|pw|tk|ml|ga|cf|gq|eth|bnb|sol|crypto|nft|dao'
const LINK_PATTERNS = [
  /[a-z][a-z0-9+.-]{1,15}:\/\//i,
  /(?:^|[^a-z0-9])www\./i,
  /(?:^|[^0-9])\d{1,3}(?:\.\d{1,3}){3}(?:[^0-9]|$)/,
  new RegExp(`(?:^|[^a-z0-9-])[a-z0-9-]{1,63}\\.(?:${LINK_TLDS})(?:[^a-z0-9-]|$)`, 'i'),
]

/**
 * True when a message carries a link, written plainly or dressed up ("example[.]com", "example dot com",
 * a full-width dot). Chat is text only: a link is how a room gets phished.
 * Keep in sync with `containsLink` in apps/web/src/chat.tsx.
 */
export function containsLink(body: string): boolean {
  const plain = body
    .replace(/[\u3002\uFF0E\uFF61\u2024]/g, '.')
    .replace(/\s*[\[({]\s*(?:\.|dot)\s*[\])}]\s*/gi, '.')
    .replace(/\s+dot\s+/gi, '.')
  return LINK_PATTERNS.some((pattern) => pattern.test(plain))
}

export interface ChatSigningFields {
  chain: ChainKey
  /** The token's address. */
  token: string
  /** The cleaned body: see `cleanBody`. */
  body: string
  /** Unix seconds. */
  issuedAt: number
  /** The room the message is for. The public one when left out. */
  room?: ChatRoom
}

/**
 * The exact text an author's wallet signs for one message. Its first line names the room, so what was signed
 * for one room verifies in no other.
 * Keep in sync with `chatSigningText` in apps/web/src/chat.tsx: one character of difference and no signature verifies.
 */
export function chatSigningText({ chain, token, body, issuedAt, room = 'public' }: ChatSigningFields): string {
  const title = room === 'holders' ? 'CallZ holder room' : 'CallZ chat'
  return `${title}\n\nToken: ${token.toLowerCase()}\nNetwork: ${chain}\nTime: ${issuedAt}\n\n${body}`
}

/** True when `issuedAt` (unix seconds) is within the allowed window of `now`, early or late. */
export function issuedAtInWindow(issuedAt: number, now: number): boolean {
  return Number.isSafeInteger(issuedAt) && Math.abs(now - issuedAt) <= ISSUED_AT_WINDOW
}

/**
 * A 65-byte wallet signature in the one form this API stores: lowercase hex, `s` in the lower half of the
 * curve order, and a recovery byte of 27 or 28. Every valid signature has a twin (`s` mirrored, recovery bit
 * flipped) and two spellings of its recovery byte; without this, each would count as a different signature
 * and the replay check would miss it. Null for anything that is not a 65-byte signature.
 */
export function canonicalSignature(value: unknown): Hex | null {
  if (typeof value !== 'string' || !SIGNATURE.test(value)) return null
  const hex = value.slice(2).toLowerCase()
  const recovery = Number.parseInt(hex.slice(128), 16)
  let parity: number
  if (recovery === 0 || recovery === 27) parity = 0
  else if (recovery === 1 || recovery === 28) parity = 1
  else return null
  let s = BigInt(`0x${hex.slice(64, 128)}`)
  if (s === 0n || s >= CURVE_ORDER) return null
  if (s > HALF_CURVE_ORDER) {
    s = CURVE_ORDER - s
    parity ^= 1
  }
  return `0x${hex.slice(0, 64)}${s.toString(16).padStart(64, '0')}${parity === 0 ? '1b' : '1c'}`
}

export interface ChatPost {
  /** Lowercase address. */
  author: string
  /** Cleaned body. */
  body: string
  issuedAt: number
  /** Canonical signature. */
  signature: Hex
}

export type ParsedChatPost = { ok: true; post: ChatPost } | { ok: false; error: string }

const invalid = (error: string): ParsedChatPost => ({ ok: false, error })

/** Checks the shape of a POST body and returns its fields in the form they are verified and stored in. */
export function parseChatPost(input: unknown): ParsedChatPost {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalid('Send a JSON object with author, body, issuedAt and signature.')
  }
  const { author, body, issuedAt, signature } = input as Record<string, unknown>
  if (typeof author !== 'string' || !ADDRESS.test(author)) return invalid('author must be a 0x address.')
  if (typeof body !== 'string') return invalid('body must be text.')
  const cleaned = cleanBody(body)
  const length = [...cleaned].length
  if (length === 0) return invalid('The message is empty.')
  if (length > MAX_BODY_LENGTH) return invalid(`The message is longer than ${MAX_BODY_LENGTH} characters.`)
  if (containsLink(cleaned)) return invalid('Links are not allowed in chat.')
  if (typeof issuedAt !== 'number' || !Number.isSafeInteger(issuedAt) || issuedAt < 0) {
    return invalid('issuedAt must be a unix time in whole seconds.')
  }
  const canonical = canonicalSignature(signature)
  if (!canonical) {
    return invalid('signature must be a 65-byte signature from a plain wallet. Smart contract wallets are not supported.')
  }
  return { ok: true, post: { author: author.toLowerCase(), body: cleaned, issuedAt, signature: canonical } }
}

/** True when `signature` is `author`'s wallet signature over this message's signing text. */
export async function verifyChatSignature(
  message: ChatSigningFields & { author: string; signature: Hex },
): Promise<boolean> {
  try {
    return await verifyMessage({
      address: message.author.toLowerCase() as Address,
      message: chatSigningText(message),
      signature: message.signature,
    })
  } catch {
    // Bytes that are not a signature at all recover no address.
    return false
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  })
}

const failure = (status: number, message: string, headers?: Record<string, string>) => json({ error: message }, status, headers)

type Row = Record<string, string | number | null>

/**
 * A message with its author's display name beside it (apps/worker/src/names.ts): the name the wallet has now,
 * not the one it had when it posted, and null for a wallet without one. Read with the messages, so the page
 * asks once.
 */
const MESSAGES =
  'SELECT m.id, m.author, m.body, m.created_at, n.name AS author_name, c.tag AS author_clan FROM chat_messages m LEFT JOIN wallet_names n ON n.wallet = m.author LEFT JOIN clan_members cm ON cm.wallet = m.author LEFT JOIN clans c ON c.id = cm.clan_id'

const toMessage = (row: Row) => ({
  id: row.id,
  author: row.author,
  authorName: typeof row.author_name === 'string' ? row.author_name : null,
  // The tag of the clan the author is in now (apps/worker/src/clans.ts), null for a wallet in none.
  authorClan: typeof row.author_clan === 'string' ? row.author_clan : null,
  body: row.body,
  createdAt: row.created_at,
})

async function list(db: D1Database, chain: ChainKey, token: string, room: ChatRoom, url: URL): Promise<Response> {
  const requested = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT)
  const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_LIMIT) : DEFAULT_LIMIT
  const after = url.searchParams.get('after')

  if (after === null) {
    const newest = await db
      .prepare(`${MESSAGES} WHERE m.chain = ? AND m.token = ? AND m.room = ? ORDER BY m.id DESC LIMIT ?`)
      .bind(chain, token, room, limit)
      .all<Row>()
    return json({ messages: newest.results.reverse().map(toMessage) })
  }
  if (!/^\d{1,15}$/.test(after)) return failure(400, 'after must be the id of a message.')
  const later = await db
    .prepare(`${MESSAGES} WHERE m.chain = ? AND m.token = ? AND m.room = ? AND m.id > ? ORDER BY m.id LIMIT ?`)
    .bind(chain, token, room, Number(after), limit)
    .all<Row>()
  return json({ messages: later.results.map(toMessage) })
}

/** Reads a request body up to `maxBytes`. Null when it is larger: nothing oversized is buffered. */
export async function readCapped(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  if (Number(request.headers.get('content-length') ?? 0) > maxBytes) {
    await request.body?.cancel()
    return null
  }
  const reader = request.body?.getReader()
  if (!reader) return new Uint8Array(0)
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function post(request: Request, env: ChatEnv, chain: ChainKey, token: string, room: ChatRoom, fetcher: typeof fetch): Promise<Response> {
  // Holdings are read on BNB Chain mainnet, so that is the only network with a holder room to post in.
  if (room === 'holders' && chain !== 'bsc') return failure(403, 'The holder room is for tokens on BNB Chain.')
  const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (type !== 'application/json') return failure(400, 'Send the message as application/json.')
  const bytes = await readCapped(request, MAX_REQUEST_BYTES)
  if (!bytes) return failure(413, 'The request is larger than 4 KB.')
  let input: unknown
  try {
    input = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes))
  } catch {
    return failure(400, 'The request body is not valid JSON.')
  }

  const parsed = parseChatPost(input)
  if (!parsed.ok) return failure(400, parsed.error)
  const { author, body, issuedAt, signature } = parsed.post
  const now = Math.floor(Date.now() / 1000)
  if (!issuedAtInWindow(issuedAt, now)) {
    return failure(400, 'The message time is more than 5 minutes from the server clock. Check the clock on your device and try again.')
  }
  if (!(await verifyChatSignature({ chain, token, author, body, issuedAt, signature, room }))) {
    return failure(403, 'The signature does not match this wallet and message.')
  }

  // Only now, for a wallet that has proved it is the author: does it hold the token at this moment?
  if (room === 'holders') {
    let balance: bigint
    try {
      balance = await balanceOf(bscRpc(env, fetcher), token, author)
    } catch (error) {
      console.error(JSON.stringify({ chatBalanceFailed: String(error).slice(0, 300) }))
      return failure(503, "This wallet's holdings could not be read right now. Try again in a moment.")
    }
    if (balance === 0n) return failure(403, 'The holder room is for wallets that hold this token.')
  }
  const db = env.DB

  // One transaction. The insert enforces the limits itself, so two requests racing each other cannot both get
  // past them; the first statement reads why a message was turned away. The limits are per author across
  // every room, and a signature can be used once in all of them.
  const [status, inserted] = await db.batch<Row>([
    db
      .prepare(
        `SELECT
  EXISTS (SELECT 1 FROM chat_messages WHERE signature = ?1) AS replayed,
  (SELECT MAX(created_at) FROM chat_messages WHERE author = ?2) AS latest,
  (SELECT COUNT(*) FROM chat_messages WHERE author = ?2 AND created_at > ?3) AS in_hour,
  (SELECT MIN(created_at) FROM chat_messages WHERE author = ?2 AND created_at > ?3) AS oldest_in_hour`,
      )
      .bind(signature, author, now - HOUR_SECONDS),
    db
      .prepare(
        `INSERT INTO chat_messages (chain, token, author, body, created_at, signature, room)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?10
WHERE NOT EXISTS (SELECT 1 FROM chat_messages WHERE author = ?3 AND created_at > ?7)
  AND (SELECT COUNT(*) FROM chat_messages WHERE author = ?3 AND created_at > ?8) < ?9
ON CONFLICT (signature) DO NOTHING
RETURNING id`,
      )
      .bind(chain, token, author, body, now, signature, now - MIN_GAP_SECONDS, now - HOUR_SECONDS, MAX_PER_HOUR, room),
  ])

  const id = inserted?.results[0]?.id
  if (typeof id === 'number') return json({ message: { id, author, body, createdAt: now } }, 201)

  const before = status?.results[0]
  if (before?.replayed === 1) return failure(409, 'This message was already posted.')
  const latest = before?.latest
  if (typeof latest === 'number' && latest > now - MIN_GAP_SECONDS) {
    return failure(429, `You are posting too fast. Wait ${MIN_GAP_SECONDS} seconds between messages.`, {
      'retry-after': String(latest + MIN_GAP_SECONDS - now),
    })
  }
  if (Number(before?.in_hour ?? 0) >= MAX_PER_HOUR) {
    const oldest = typeof before?.oldest_in_hour === 'number' ? before.oldest_in_hour : now
    return failure(429, `You have posted ${MAX_PER_HOUR} messages in the last hour, which is the limit. Try again later.`, {
      'retry-after': String(Math.max(1, oldest + HOUR_SECONDS - now)),
    })
  }
  return failure(503, 'The message could not be stored. Try again.')
}

/** Routes `/api/chat/<chain>/<token>`. `fetcher` is how the chain is reached for the holder room. */
export async function handleChat(request: Request, env: ChatEnv, fetcher: typeof fetch = fetch): Promise<Response> {
  const reading = request.method === 'GET' || request.method === 'HEAD'
  if (!reading && request.method !== 'POST') return failure(405, 'Method not allowed.', { allow: 'GET, HEAD, POST' })

  const url = new URL(request.url)
  const [, api, chat, chain, rawToken, extra] = url.pathname.split('/')
  if (api !== 'api' || chat !== 'chat' || chain === undefined || rawToken === undefined || extra !== undefined) {
    return failure(404, 'Not found.')
  }
  if (!isChainKey(chain)) return failure(404, `Unknown network. Use one of: ${Object.keys(CHAINS).join(', ')}.`)
  if (!ADDRESS.test(rawToken)) return failure(400, 'The token must be a 0x address.')
  const token = rawToken.toLowerCase()
  const room = chatRoomOf(url.searchParams.get('room'))
  if (!room) return failure(400, 'room must be public or holders.')

  try {
    return reading ? await list(env.DB, chain, token, room, url) : await post(request, env, chain, token, room, fetcher)
  } catch (error) {
    console.error(JSON.stringify({ chatFailed: String(error).slice(0, 500) }))
    return failure(500, 'Chat is unavailable right now. Try again in a moment.')
  }
}
