/**
 * `/api/rooms/...`: rooms on BNB Chain. A room is a `CallZRoom` contract: its dev lets wallets in, each buys one
 * pass, and the passes launch a token. This API keeps what the chain does not: the room's description, the
 * applications, the private chat and its pictures, and the points and tags the dev gives.
 *
 * Anyone, signed in or not:
 *   GET  /api/rooms?q=&sort=&page=&wallet=  rooms, 100 to a page. `sort` is `latest` (newest first, the default) or
 *                                           `hot` (most applications and passes bought in the last 24 hours first).
 *                                           `q` searches names, symbols, room and dev addresses and dev names.
 *                                           `wallet` keeps only the rooms that wallet created or holds a pass of,
 *                                           each marked with which.
 *   GET  /api/rooms/<room>                  one room, its requirements and its members (wallet, name, clan, pass,
 *                                           points, tag).
 *   GET  /api/rooms/image/<hash>            a room's picture.
 *   POST /api/rooms/<room>/sync             read the room from the chain again now.
 *
 * Signed in (`Authorization: Bearer <token>`, see apps/worker/src/session.ts):
 *   POST /api/rooms/images                  the bytes of a room picture → { hash, url }. The url goes into the
 *                                           room's contract when it is created.
 *   GET  /api/rooms/<room>/application      the caller's application, their post code and where they stand.
 *   POST /api/rooms/<room>/application      { postUrl?, role?, portfolio? } apply, or change a pending application.
 *
 * The room's dev (the wallet that created the contract):
 *   POST /api/rooms                         { room, about, wantPost, postBrief, postPhrase, wantRole, roleBrief } list the
 *                                           room, or change those settings.
 *   GET  /api/rooms/<room>/applications     every applicant with what each requirement reads.
 *   POST /api/rooms/<room>/applications/<wallet>  { action: 'check' | 'decline' | 'reopen' }. 'check' reads every
 *                                           requirement again, now: the page does it right before the dev lets
 *                                           the wallet in.
 *   POST /api/rooms/<room>/points           { wallet, points, note } give a member points: 100 at most per member.
 *   POST /api/rooms/<room>/tags             { wallet, label } give a member the project's tag; null takes it back.
 *   POST /api/rooms/<room>/mutes            { wallet, muted } take a member out of the chat, or let them back.
 *
 * The dev and the wallets holding a pass:
 *   GET  /api/rooms/<room>/messages?after=<id>&limit=<n>
 *   POST /api/rooms/<room>/messages         { body, picture? }
 *   POST /api/rooms/<room>/pictures         the bytes of a picture → { hash }
 *   GET  /api/rooms/<room>/pictures/<hash>
 *
 * Who created a room, what a pass costs, who holds one and whether it launched are read from the room's
 * contract, never taken from a request. A wallet is let in, removed and barred on chain, by the dev's own
 * transactions; this API only tells the dev whether an applicant still meets the room's requirements.
 *
 * Nothing a visitor types can become code: every value reaches the database as a bound parameter, and the page
 * shows text as text. Links are allowed in a room's private chat, where every member was chosen by the dev;
 * the page makes them links itself and only for http and https. A picture is stored under the SHA-256 of its
 * bytes after its first bytes have been checked to be a PNG, JPEG, WebP or GIF, and is served as exactly that.
 */
import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, stringToHex, type Address, type Hex } from 'viem'
import { cleanBody, readCapped } from './chat.js'
import { bscRpc, type MarketEnv } from './market.js'
import { ADDRESS, failure, json, readObject, sessionWallet, sha256Hex, signInFirst, type Row } from './session.js'
import factory from './room-factory.json'

export interface RoomsEnv extends MarketEnv {
  DB: D1Database
}

type Rpc = ReturnType<typeof bscRpc>

/** The CallZRoomFactory whose rooms this API lists. */
export const ROOM_FACTORY = factory.address.toLowerCase() as Address
/** Where a room picture is served from: what the page writes into a room's contract. */
export const PICTURE_ORIGIN = 'https://callz.fun'

const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11'
const HASH = /^[0-9a-f]{64}$/
const OWN_PICTURE = /^https:\/\/callz\.fun\/api\/rooms\/image\/([0-9a-f]{64})$/

/** The most members one reading brings back: `CallZRoom.MAX_SEATS`. */
const MAX_SEATS = 1000
/** How old a room's copy of the chain may be before a page view reads it again, in seconds. */
const ROOM_FRESH_SECONDS = 15
/** The same for the chat, which is asked every few seconds: a removed member is out within this. */
const CHAT_FRESH_SECONDS = 30
/** After the launch nothing about a room's members can change, so it is read rarely. */
const LAUNCHED_FRESH_SECONDS = 3600

export const MAX_ABOUT_LENGTH = 600
export const MAX_BRIEF_LENGTH = 300
/** Longest text a dev can require a post on X to contain. A post is 280 characters and also carries the code. */
export const MAX_PHRASE_LENGTH = 120
export const MAX_ROLE_LENGTH = 60
export const MAX_PORTFOLIO_LENGTH = 600
export const MAX_MESSAGE_LENGTH = 1000
export const MAX_NOTE_LENGTH = 140
export const MAX_TAG_LENGTH = 24
/** The most points one member can have from one room. */
export const MAX_POINTS = 100
/** The largest picture, in bytes. A database row holds 2 MB. */
export const MAX_PICTURE_BYTES = 1_500_000
const ROOM_PICTURES_PER_DAY = 10
const CHAT_PICTURES_PER_HOUR = 60
const MIN_GAP_SECONDS = 1
const MAX_MESSAGES_PER_HOUR = 300
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const MAX_APPLICATIONS = 300

const multicallAbi = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
])
const factoryAbi = parseAbi(['function isRoom(address room) view returns (bool)'])
const roomAbi = parseAbi([
  'struct CallZRoomInfo { address creator; string tokenName; string tokenSymbol; string image; uint256 seatPrice; uint256 seats; uint256 seated; uint256 minted; uint256 raised; uint256 saleDeadline; uint16 poolShareBps; uint16 launchFeeBps; address gateToken; uint256 gateAmount; uint256 tokensPerSeat; bool launched; address token; address pair; }',
  'struct CallZRoomStanding { bool admitted; bool banned; uint256 seat; bool claimed; uint256 owed; bool meetsGate; }',
  'function info() view returns (CallZRoomInfo)',
  'function members(uint256 offset, uint256 limit) view returns (address[] wallets, uint256[] tokenIds)',
  'function standingOf(address wallet) view returns (CallZRoomStanding)',
])
const tokenAbi = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
])

const ZERO = '0x0000000000000000000000000000000000000000'

// ─────────────────────────────────────────────────────────────────────────────
// Text
// ─────────────────────────────────────────────────────────────────────────────

/** Control and invisible characters, except the line break. */
const REMOVED_KEEPING_BREAKS = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩\uD800-\uDFFF]/gu

/** Text that may run over several lines: nothing invisible in it, and no more than one empty line in a row. */
export function cleanText(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').replace(REMOVED_KEEPING_BREAKS, '').replace(/\n{3,}/g, '\n\n').trim()
}

const lengthOf = (text: string): number => [...text].length

/** A field of a request as cleaned text of at most `max` characters. A string naming the problem otherwise. */
function textField(value: unknown, label: string, max: number, lines: boolean): { text: string } | string {
  if (value === undefined || value === null) return { text: '' }
  if (typeof value !== 'string') return `${label} must be text.`
  const text = lines ? cleanText(value) : cleanBody(value)
  return lengthOf(text) > max ? `${label} is longer than ${max} characters.` : { text }
}

// ─────────────────────────────────────────────────────────────────────────────
// The post on X
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The code an applicant puts in their post on X: it ties the post to this wallet and this room, so a post
 * somebody else made cannot be handed in.
 */
export function postCode(room: string, wallet: string): string {
  return `CZ-${keccak256(stringToHex(`${room.toLowerCase()}:${wallet.toLowerCase()}`)).slice(2, 8).toUpperCase()}`
}

/** A link to one post on X, in its one canonical spelling. Null for anything else. */
export function parsePostUrl(raw: unknown): { url: string; handle: string } | null {
  if (typeof raw !== 'string') return null
  const match = /^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,20})(?:[/?#].*)?$/.exec(raw.trim())
  if (!match) return null
  return { url: `https://x.com/${match[1]}/status/${match[2]}`, handle: match[1]!.toLowerCase() }
}

export type PostState = 'ok' | 'missing' | 'nocode' | 'unreachable'

/**
 * Asks X whether a post is up and whether it carries `code`, through X's public embed endpoint, which needs
 * no key. 'unreachable' when X could not be asked or answered something else: an unread post is never 'ok'.
 */
export async function checkPost(
  url: string,
  code: string,
  fetcher: typeof fetch = fetch,
  phrase = '',
): Promise<{ state: PostState; handle: string | null; hasCode?: boolean; hasPhrase?: boolean }> {
  let response: Response
  try {
    response = await fetcher(`https://publish.x.com/oembed?url=${encodeURIComponent(url)}&omit_script=1&dnt=1`, {
      headers: { accept: 'application/json' },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    })
  } catch {
    return { state: 'unreachable', handle: null }
  }
  // X answers 404 for a post that does not exist or was deleted, and 403 for one that is not public.
  if (response.status === 404 || response.status === 403) {
    await response.body?.cancel()
    return { state: 'missing', handle: null }
  }
  if (!response.ok) {
    await response.body?.cancel()
    return { state: 'unreachable', handle: null }
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return { state: 'unreachable', handle: null }
  }
  const { html, author_url: authorUrl } = (payload ?? {}) as Record<string, unknown>
  if (typeof html !== 'string') return { state: 'unreachable', handle: null }
  const author = typeof authorUrl === 'string' ? /^https:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})$/.exec(authorUrl)?.[1]?.toLowerCase() ?? null : null
  const said = postText(html)
  const hasCode = said.includes(comparable(code))
  const hasPhrase = phrase === '' || said.includes(comparable(phrase))
  // 'nocode' also covers a post without the words the dev requires: either way it does not say what it must.
  return { state: hasCode && hasPhrase ? 'ok' : 'nocode', handle: author, hasCode, hasPhrase }
}

/** Text as it is compared: one case, and every run of white space one space. */
const comparable = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim()

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '\u2014', ndash: '\u2013', hellip: '\u2026' }

/**
 * What a post says, from the markup X's embed endpoint returns for it: the post's own paragraph, with tags
 * taken out and character references read back into characters. X wraps mentions, hashtags and cashtags in
 * links, so "@callzfun" would not be found in the markup as it stands. The text is only ever compared, never
 * shown or stored.
 */
export function postText(html: string): string {
  const paragraph = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(html)?.[1] ?? html
  const text = paragraph
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,8}));/gi, (whole, decimal?: string, hexadecimal?: string, name?: string) => {
      if (name) return ENTITIES[name.toLowerCase()] ?? whole
      const point = decimal ? Number(decimal) : Number.parseInt(hexadecimal ?? '', 16)
      return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole
    })
  return comparable(text)
}

// ─────────────────────────────────────────────────────────────────────────────
// Pictures
// ─────────────────────────────────────────────────────────────────────────────

/** What kind of picture these bytes are, by how they begin. Null for anything that is not one of the four. */
export function pictureType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | null {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value)
  if (bytes.length < 12) return null
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (starts(0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return 'image/gif'
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return null
}

/** Stores a picture for `room` ('' for a room's own picture) and answers with its hash. */
async function storePicture(request: Request, db: D1Database, wallet: string, room: string): Promise<Response> {
  const bytes = await readCapped(request, MAX_PICTURE_BYTES)
  if (!bytes) return failure(413, `The picture is larger than ${MAX_PICTURE_BYTES / 1_000_000} MB.`)
  const mime = pictureType(bytes)
  if (!mime) return failure(400, 'The picture must be a PNG, JPEG, WebP or GIF.')
  const now = Math.floor(Date.now() / 1000)
  const window = room === '' ? 86_400 : 3600
  const allowed = room === '' ? ROOM_PICTURES_PER_DAY : CHAT_PICTURES_PER_HOUR
  const hash = await sha256Hex(bytes)
  const [counted, stored] = await db.batch<Row>([
    db.prepare("SELECT COUNT(*) AS recent, EXISTS (SELECT 1 FROM pictures WHERE hash = ?3 AND room = ?4) AS known FROM pictures WHERE uploader = ?1 AND created_at > ?2 AND (room = '') = (?4 = '')").bind(wallet, now - window, hash, room),
    db
      .prepare(
        `INSERT INTO pictures (hash, room, mime, size, bytes, uploader, created_at)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
WHERE (SELECT COUNT(*) FROM pictures WHERE uploader = ?6 AND created_at > ?8 AND (room = '') = (?2 = '')) < ?9
ON CONFLICT (hash, room) DO NOTHING
RETURNING hash`,
      )
      .bind(hash, room, mime, bytes.byteLength, bytes, wallet, now, now - window, allowed),
  ])
  const before = counted?.results[0]
  // Stored now, or the very same picture was already here.
  if (stored?.results[0]?.hash === hash || before?.known === 1) {
    return json(room === '' ? { hash, url: `${PICTURE_ORIGIN}/api/rooms/image/${hash}` } : { hash }, 201)
  }
  if (Number(before?.recent ?? 0) >= allowed) {
    return failure(429, room === '' ? `You have uploaded ${allowed} room pictures in the last day, which is the limit.` : `You have posted ${allowed} pictures in the last hour, which is the limit.`)
  }
  return failure(503, 'The picture could not be stored. Try again.')
}

async function servePicture(db: D1Database, hash: string, room: string): Promise<Response> {
  const row = await db.prepare('SELECT mime, bytes FROM pictures WHERE hash = ? AND room = ?').bind(hash, room).first<{ mime: string; bytes: ArrayBuffer | number[] }>()
  if (!row) return failure(404, 'There is no such picture.')
  const bytes = row.bytes instanceof ArrayBuffer ? new Uint8Array(row.bytes) : Uint8Array.from(row.bytes)
  return new Response(bytes, {
    headers: {
      'content-type': row.mime,
      // The address is the hash of the bytes: it can never show anything else.
      'cache-control': room === '' ? 'public, max-age=31536000, immutable' : 'private, max-age=86400, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'content-disposition': 'inline',
    },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// The chain
// ─────────────────────────────────────────────────────────────────────────────

interface Call {
  target: string
  data: Hex
}

/** Several reads in one `eth_call`. A read that reverts is null. Throws when the request itself fails. */
async function multicall(rpc: Rpc, calls: readonly Call[]): Promise<Array<Hex | null>> {
  if (calls.length === 0) return []
  const data = encodeFunctionData({
    abi: multicallAbi,
    functionName: 'aggregate3',
    args: [calls.map(({ target, data: callData }) => ({ target: target.toLowerCase() as Address, allowFailure: true, callData }))],
  })
  const raw = await rpc<Hex>('eth_call', [{ to: MULTICALL3, data }, 'latest'])
  const results = decodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', data: raw })
  if (results.length !== calls.length) throw new Error('Multicall3 returned a different number of results')
  return results.map((result) => (result.success && result.returnData !== '0x' ? result.returnData : null))
}

interface ChainRoom {
  creator: string
  name: string
  symbol: string
  image: string
  seatPrice: bigint
  seats: number
  seated: number
  saleDeadline: number
  poolShareBps: number
  launchFeeBps: number
  gateToken: string | null
  gateAmount: bigint
  launched: boolean
  token: string | null
  pair: string | null
  members: Array<{ wallet: string; seat: number }>
}

const orNull = (address: string): string | null => (address.toLowerCase() === ZERO ? null : address.toLowerCase())

/** A room as its contract has it now. Null when `address` is not a room of the factory. Throws when unread. */
async function readRoom(rpc: Rpc, address: string): Promise<ChainRoom | null> {
  const [listed, infoData, membersData] = await multicall(rpc, [
    { target: ROOM_FACTORY, data: encodeFunctionData({ abi: factoryAbi, functionName: 'isRoom', args: [address as Address] }) },
    { target: address, data: encodeFunctionData({ abi: roomAbi, functionName: 'info' }) },
    { target: address, data: encodeFunctionData({ abi: roomAbi, functionName: 'members', args: [0n, BigInt(MAX_SEATS)] }) },
  ])
  // No factory at that address yet, or the factory does not know the room.
  if (!listed || !decodeFunctionResult({ abi: factoryAbi, functionName: 'isRoom', data: listed })) return null
  if (!infoData || !membersData) throw new Error('the room did not answer')
  const info = decodeFunctionResult({ abi: roomAbi, functionName: 'info', data: infoData })
  const [wallets, ids] = decodeFunctionResult({ abi: roomAbi, functionName: 'members', data: membersData })
  return {
    creator: info.creator.toLowerCase(),
    name: info.tokenName,
    symbol: info.tokenSymbol,
    image: info.image,
    seatPrice: info.seatPrice,
    seats: Number(info.seats),
    seated: Number(info.seated),
    saleDeadline: Number(info.saleDeadline),
    poolShareBps: info.poolShareBps,
    launchFeeBps: info.launchFeeBps,
    gateToken: orNull(info.gateToken),
    gateAmount: info.gateAmount,
    launched: info.launched,
    token: orNull(info.token),
    pair: orNull(info.pair),
    members: wallets.map((wallet, index) => ({ wallet: wallet.toLowerCase(), seat: Number(ids[index] ?? 0n) })),
  }
}

/** A token's symbol and decimals, for showing an amount of it. Null for what the token does not answer. */
async function tokenLabel(rpc: Rpc, token: string): Promise<{ symbol: string | null; decimals: number | null }> {
  const [symbolData, decimalsData] = await multicall(rpc, [
    { target: token, data: encodeFunctionData({ abi: tokenAbi, functionName: 'symbol' }) },
    { target: token, data: encodeFunctionData({ abi: tokenAbi, functionName: 'decimals' }) },
  ])
  let symbol: string | null = null
  let decimals: number | null = null
  try {
    if (symbolData) symbol = cleanBody(decodeFunctionResult({ abi: tokenAbi, functionName: 'symbol', data: symbolData })).slice(0, 32) || null
  } catch {
    symbol = null
  }
  try {
    if (decimalsData) decimals = decodeFunctionResult({ abi: tokenAbi, functionName: 'decimals', data: decimalsData })
  } catch {
    decimals = null
  }
  return { symbol, decimals }
}

export interface Standing {
  admitted: boolean
  banned: boolean
  seat: number
}

/** Where each wallet stands in the room, by the room's own contract. Null for one that could not be read. */
async function standings(rpc: Rpc, room: string, wallets: readonly string[]): Promise<Array<Standing | null>> {
  const out: Array<Standing | null> = []
  for (let start = 0; start < wallets.length; start += 100) {
    const results = await multicall(
      rpc,
      wallets.slice(start, start + 100).map((wallet) => ({ target: room, data: encodeFunctionData({ abi: roomAbi, functionName: 'standingOf', args: [wallet as Address] }) })),
    )
    for (const data of results) {
      if (!data) {
        out.push(null)
        continue
      }
      const standing = decodeFunctionResult({ abi: roomAbi, functionName: 'standingOf', data })
      out.push({ admitted: standing.admitted, banned: standing.banned, seat: Number(standing.seat) })
    }
  }
  return out
}

/** What `wallet` holds of `token` now. Throws when it could not be read: an unread balance is not zero. */
async function held(rpc: Rpc, token: string, wallet: string): Promise<bigint> {
  const [data] = await multicall(rpc, [{ target: token, data: encodeFunctionData({ abi: tokenAbi, functionName: 'balanceOf', args: [wallet as Address] }) }])
  if (!data) throw new Error('balanceOf returned no value')
  return decodeFunctionResult({ abi: tokenAbi, functionName: 'balanceOf', data })
}

// ─────────────────────────────────────────────────────────────────────────────
// A room's copy in the database
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The room's row, read from the chain again when its copy is older than `maxAge` seconds. Null when `address`
 * is no room of the factory. When the chain cannot be read, the copy there is serves as it is.
 */
export async function loadRoom(env: RoomsEnv, fetcher: typeof fetch, address: string, maxAge: number): Promise<Row | null> {
  const db = env.DB
  const now = Math.floor(Date.now() / 1000)
  const row = await db.prepare('SELECT * FROM rooms WHERE address = ?').bind(address).first<Row>()
  if (row) {
    const age = now - Number(row.synced_at)
    if (age < (row.launched === 1 ? Math.max(maxAge, LAUNCHED_FRESH_SECONDS) : maxAge)) return row
    // One request reads the chain; the others that arrive meanwhile use the copy.
    const claimed = await db.prepare('UPDATE rooms SET synced_at = ?1 WHERE address = ?2 AND synced_at = ?3 RETURNING address').bind(now, address, row.synced_at).first<Row>()
    if (!claimed) return row
  }

  const rpc = bscRpc(env, fetcher)
  let chain: ChainRoom | null
  try {
    chain = await readRoom(rpc, address)
  } catch (error) {
    console.error(JSON.stringify({ roomReadFailed: address, error: String(error).slice(0, 300) }))
    if (row) return row
    throw error
  }
  if (!chain) return null

  let gateSymbol = typeof row?.gate_symbol === 'string' ? row.gate_symbol : null
  let gateDecimals = typeof row?.gate_decimals === 'number' ? row.gate_decimals : null
  if (!row && chain.gateToken) {
    try {
      ;({ symbol: gateSymbol, decimals: gateDecimals } = await tokenLabel(rpc, chain.gateToken))
    } catch {
      // Shown as a raw amount until a later reading gets the label.
    }
  }

  await db.batch([
    db
      .prepare(
        `INSERT INTO rooms (address, creator, name, symbol, image, gate_token, gate_amount, gate_symbol, gate_decimals, seat_price, seats, seated,
  sale_deadline, pool_share_bps, launch_fee_bps, launched, token, pair, created_at, synced_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?19)
ON CONFLICT (address) DO UPDATE SET seated = excluded.seated, launched = excluded.launched, token = excluded.token, pair = excluded.pair,
  synced_at = excluded.synced_at`,
      )
      .bind(
        address,
        chain.creator,
        cleanBody(chain.name),
        cleanBody(chain.symbol),
        chain.image,
        chain.gateToken,
        chain.gateToken ? chain.gateAmount.toString() : null,
        gateSymbol,
        gateDecimals,
        chain.seatPrice.toString(),
        chain.seats,
        chain.seated,
        chain.saleDeadline,
        chain.poolShareBps,
        chain.launchFeeBps,
        chain.launched ? 1 : 0,
        chain.token,
        chain.pair,
        now,
      ),
    // Every member of this reading, in one statement; then the wallets no reading saw this time are gone.
    db
      .prepare(
        `INSERT INTO room_members (room, wallet, seat, joined_at, sync)
SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'), ?4, ?3 FROM json_each(?2) WHERE true
ON CONFLICT (room, wallet) DO UPDATE SET seat = excluded.seat, sync = excluded.sync`,
      )
      // A room read for the first time may have had its members for a long while: when they joined is not
      // known, and 0 says so. Only a wallet first seen on a later reading joined "now".
      .bind(address, JSON.stringify(chain.members.map(({ wallet, seat }) => [wallet, seat])), now, row ? now : 0),
    db.prepare('DELETE FROM room_members WHERE room = ?1 AND sync != ?2').bind(address, now),
  ])
  return await db.prepare('SELECT * FROM rooms WHERE address = ?').bind(address).first<Row>()
}

/** Reads again the rooms that have not launched and were read longest ago. Called by the cron tick. */
export async function refreshRooms(env: RoomsEnv, most = 5, fetcher: typeof fetch = fetch): Promise<number> {
  const stale = await env.DB.prepare('SELECT address FROM rooms WHERE launched = 0 AND synced_at < ? ORDER BY synced_at LIMIT ?')
    .bind(Math.floor(Date.now() / 1000) - 60, most)
    .all<Row>()
  let read = 0
  for (const { address } of stale.results) {
    try {
      if (await loadRoom(env, fetcher, String(address), 0)) read++
    } catch {
      // Logged where it failed; the next tick tries again.
    }
  }
  return read
}

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)

/** The hash of a room's picture when it is one of this site's own; null for any other address. */
const ownPicture = (image: unknown): string | null => (typeof image === 'string' ? OWN_PICTURE.exec(image)?.[1] ?? null : null)

const toRoom = (row: Row) => ({
  address: row.address,
  creator: row.creator,
  creatorName: text(row.creator_name),
  creatorClan: text(row.creator_clan),
  name: row.name,
  symbol: row.symbol,
  picture: ownPicture(row.image),
  about: row.about,
  wantPost: row.want_post === 1,
  postBrief: row.post_brief,
  // Words the post must contain, checked with X. Empty when the dev requires none.
  postPhrase: typeof row.post_phrase === 'string' ? row.post_phrase : '',
  wantRole: row.want_role === 1,
  roleBrief: row.role_brief,
  gate: text(row.gate_token) ? { token: row.gate_token, amount: row.gate_amount, symbol: text(row.gate_symbol), decimals: row.gate_decimals } : null,
  seatPrice: row.seat_price,
  seats: row.seats,
  seated: row.seated,
  saleDeadline: row.sale_deadline,
  poolShareBps: row.pool_share_bps,
  launchFeeBps: row.launch_fee_bps,
  launched: row.launched === 1,
  token: text(row.token),
  pair: text(row.pair),
  createdAt: row.created_at,
  syncedAt: row.synced_at,
})

/** The name and clan tag a wallet shows, joined to a column holding its address. */
const identity = (column: string, prefix: string) =>
  `LEFT JOIN wallet_names ${prefix}n ON ${prefix}n.wallet = ${column} LEFT JOIN clan_members ${prefix}cm ON ${prefix}cm.wallet = ${column} LEFT JOIN clans ${prefix}c ON ${prefix}c.id = ${prefix}cm.clan_id`

// ─────────────────────────────────────────────────────────────────────────────
// Rooms
// ─────────────────────────────────────────────────────────────────────────────

/** Rooms on one page of the list. */
export const ROOMS_PER_PAGE = 100
/** How far back "hot" looks, in seconds. */
export const HOT_WINDOW_SECONDS = 86_400
const MAX_QUERY_LENGTH = 64

/** A search text as a LIKE pattern that matches it anywhere, with nothing in it read as a wildcard. */
const likeAnywhere = (text: string): string => `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`

/**
 * One page of rooms. How hot a room is: the applications it got in the last 24 hours, plus two for every pass
 * bought in them. Buying a pass counts for more than asking for one.
 */
async function list(db: D1Database, url: URL): Promise<Response> {
  const sort = url.searchParams.get('sort') ?? 'latest'
  if (sort !== 'latest' && sort !== 'hot') return failure(400, "sort must be 'latest' or 'hot'.")
  const requested = Number(url.searchParams.get('page') ?? 1)
  if (!Number.isInteger(requested) || requested < 1 || requested > 10_000) return failure(400, 'page must be a whole number from 1.')
  const query = cleanBody(url.searchParams.get('q') ?? '')
  if (lengthOf(query) > MAX_QUERY_LENGTH) return failure(400, `The search is longer than ${MAX_QUERY_LENGTH} characters.`)
  const rawWallet = url.searchParams.get('wallet')
  if (rawWallet !== null && !ADDRESS.test(rawWallet)) return failure(400, 'wallet must be a 0x address.')
  const wallet = rawWallet === null ? null : rawWallet.toLowerCase()
  const pattern = query === '' ? null : likeAnywhere(query.toLowerCase())
  const launchedOnly = url.searchParams.get('launched')
  if (launchedOnly !== null && launchedOnly !== '1') return failure(400, "launched must be '1' when given.")
  const since = Math.floor(Date.now() / 1000) - HOT_WINDOW_SECONDS

  // ?1 the search pattern or NULL, ?2 the wallet or NULL. Every value is bound: nothing typed is part of the SQL.
  const where = `WHERE (?1 IS NULL OR lower(r.name) LIKE ?1 ESCAPE '\\' OR lower(r.symbol) LIKE ?1 ESCAPE '\\' OR r.address LIKE ?1 ESCAPE '\\'
    OR r.creator LIKE ?1 ESCAPE '\\' OR lower(n.name) LIKE ?1 ESCAPE '\\')
  AND (?2 IS NULL OR r.creator = ?2 OR EXISTS (SELECT 1 FROM room_members w WHERE w.room = r.address AND w.wallet = ?2))${launchedOnly === null ? '' : ' AND r.launched = 1'}`
  const [counted, rows] = await db.batch<Row>([
    db.prepare(`SELECT COUNT(*) AS total FROM rooms r LEFT JOIN wallet_names n ON n.wallet = r.creator ${where}`).bind(pattern, wallet),
    db
      .prepare(
        `SELECT r.*, n.name AS creator_name, c.tag AS creator_clan,
  (SELECT COUNT(*) FROM room_applications a WHERE a.room = r.address AND a.status = 'pending') AS applicants,
  (SELECT COUNT(*) FROM room_applications a WHERE a.room = r.address AND a.created_at > ?3)
    + 2 * (SELECT COUNT(*) FROM room_members m WHERE m.room = r.address AND m.joined_at > ?3) AS hot,
  CASE WHEN ?2 IS NULL THEN NULL WHEN r.creator = ?2 THEN 'dev' ELSE 'member' END AS role
FROM rooms r ${identity('r.creator', '')} ${where}
ORDER BY ${sort === 'hot' ? 'hot DESC, r.created_at DESC' : 'r.created_at DESC'}, r.address LIMIT ?4 OFFSET ?5`,
      )
      .bind(pattern, wallet, since, ROOMS_PER_PAGE, (requested - 1) * ROOMS_PER_PAGE),
  ])
  return json({
    factory: ROOM_FACTORY,
    sort,
    page: requested,
    pageSize: ROOMS_PER_PAGE,
    total: Number(counted?.results[0]?.total ?? 0),
    rooms: (rows?.results ?? []).map((row) => ({ ...toRoom(row), applicants: row.applicants, hot: row.hot, ...(row.role === null ? {} : { role: row.role }) })),
  })
}

async function detail(env: RoomsEnv, fetcher: typeof fetch, address: string, maxAge = ROOM_FRESH_SECONDS): Promise<Response> {
  const room = await loadRoom(env, fetcher, address, maxAge)
  if (!room) return failure(404, 'There is no such room.')
  const db = env.DB
  const [creator, members, applicants] = await db.batch<Row>([
    db.prepare(`SELECT n.name AS creator_name, c.tag AS creator_clan FROM rooms r ${identity('r.creator', '')} WHERE r.address = ?`).bind(address),
    db
      .prepare(
        `SELECT m.wallet, m.seat, m.joined_at, n.name, c.tag AS clan, t.label AS tag,
  (SELECT COALESCE(SUM(p.points), 0) FROM room_points p WHERE p.room = m.room AND p.wallet = m.wallet) AS points,
  EXISTS (SELECT 1 FROM room_mutes u WHERE u.room = m.room AND u.wallet = m.wallet) AS muted
FROM room_members m ${identity('m.wallet', '')} LEFT JOIN room_tags t ON t.room = m.room AND t.wallet = m.wallet
WHERE m.room = ? ORDER BY m.seat`,
      )
      .bind(address),
    db.prepare("SELECT COUNT(*) AS applicants FROM room_applications WHERE room = ? AND status = 'pending'").bind(address),
  ])
  return json({
    factory: ROOM_FACTORY,
    room: { ...toRoom({ ...room, ...(creator?.results[0] ?? {}) }), applicants: applicants?.results[0]?.applicants ?? 0 },
    members: (members?.results ?? []).map((row) => ({
      wallet: row.wallet,
      name: text(row.name),
      clan: text(row.clan),
      seat: row.seat,
      joinedAt: row.joined_at,
      points: row.points,
      tag: text(row.tag),
      muted: row.muted === 1,
    })),
  })
}

/** The dev lists a room or changes what it says and asks for. */
async function settings(request: Request, env: RoomsEnv, fetcher: typeof fetch): Promise<Response> {
  const wallet = await sessionWallet(request, env.DB)
  if (!wallet) return signInFirst()
  const input = await readObject(request, 8192)
  if (input instanceof Response) return input
  if (typeof input.room !== 'string' || !ADDRESS.test(input.room)) return failure(400, 'room must be a 0x address.')
  const address = input.room.toLowerCase()
  // Straight from the chain: the room may have been created seconds ago.
  const room = await loadRoom(env, fetcher, address, 0)
  if (!room) return failure(404, 'That address is not a CallZ room. If you created it a moment ago, try again in a few seconds.')
  if (room.creator !== wallet) return failure(403, 'Only the wallet that created the room can change it.')

  const about = textField(input.about, 'The description', MAX_ABOUT_LENGTH, true)
  const postBrief = textField(input.postBrief, 'What the post should say', MAX_BRIEF_LENGTH, true)
  const roleBrief = textField(input.roleBrief, 'Who you are looking for', MAX_BRIEF_LENGTH, true)
  const postPhrase = textField(input.postPhrase, 'The words the post must contain', MAX_PHRASE_LENGTH, false)
  for (const field of [about, postBrief, roleBrief, postPhrase]) if (typeof field === 'string') return failure(400, field)
  if (typeof input.wantPost !== 'boolean' || typeof input.wantRole !== 'boolean') return failure(400, 'wantPost and wantRole must be true or false.')
  await env.DB.prepare('UPDATE rooms SET about = ?, want_post = ?, post_brief = ?, post_phrase = ?, want_role = ?, role_brief = ? WHERE address = ?')
    .bind(
      (about as { text: string }).text,
      input.wantPost ? 1 : 0,
      (postBrief as { text: string }).text,
      input.wantPost ? (postPhrase as { text: string }).text.replace(/\s+/g, ' ') : '',
      input.wantRole ? 1 : 0,
      (roleBrief as { text: string }).text,
      address,
    )
    .run()
  return detail(env, fetcher, address)
}

// ─────────────────────────────────────────────────────────────────────────────
// Applications
// ─────────────────────────────────────────────────────────────────────────────

const toApplication = (row: Row, standing: Standing | null | undefined) => ({
  wallet: row.wallet,
  name: text(row.name),
  clan: text(row.clan),
  postUrl: text(row.post_url),
  postHandle: text(row.post_handle),
  postState: text(row.post_state),
  role: text(row.role),
  portfolio: text(row.portfolio),
  held: text(row.held),
  holdState: text(row.hold_state),
  checkedAt: row.checked_at,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  standing: standing ?? null,
})

const APPLICATION = `SELECT a.*, n.name, c.tag AS clan FROM room_applications a ${identity('a.wallet', '')}`

/** What each of the room's requirements reads for `wallet` right now. */
async function readRequirements(
  env: RoomsEnv,
  fetcher: typeof fetch,
  room: Row,
  wallet: string,
  postUrl: string | null,
): Promise<{ postState: PostState | null; postHandle: string | null; held: string | null; holdState: 'ok' | 'short' | 'unreadable' | null; hasCode?: boolean; hasPhrase?: boolean }> {
  const address = String(room.address)
  let postState: PostState | null = null
  let postHandle: string | null = null
  let hasCode: boolean | undefined
  let hasPhrase: boolean | undefined
  if (room.want_post === 1 && postUrl) {
    const phrase = typeof room.post_phrase === 'string' ? room.post_phrase : ''
    ;({ state: postState, handle: postHandle, hasCode, hasPhrase } = await checkPost(postUrl, postCode(address, wallet), fetcher, phrase))
  } else if (room.want_post === 1) postState = 'missing'

  let holding: string | null = null
  let holdState: 'ok' | 'short' | 'unreadable' | null = null
  if (typeof room.gate_token === 'string' && room.gate_token !== '') {
    try {
      const balance = await held(bscRpc(env, fetcher), room.gate_token, wallet)
      holding = balance.toString()
      holdState = balance >= BigInt(String(room.gate_amount ?? '0')) ? 'ok' : 'short'
    } catch {
      holdState = 'unreadable'
    }
  }
  return { postState, postHandle, held: holding, holdState, ...(hasCode === undefined ? {} : { hasCode }), ...(hasPhrase === undefined ? {} : { hasPhrase }) }
}

/** True when everything the room asks for is met by what was just read. */
const requirementsMet = (room: Row, read: { postState: PostState | null; holdState: string | null }): boolean =>
  (room.want_post !== 1 || read.postState === 'ok') && (!text(room.gate_token) || read.holdState === 'ok')

async function myApplication(request: Request, env: RoomsEnv, fetcher: typeof fetch, address: string): Promise<Response> {
  const wallet = await sessionWallet(request, env.DB)
  if (!wallet) return signInFirst()
  const room = await loadRoom(env, fetcher, address, ROOM_FRESH_SECONDS)
  if (!room) return failure(404, 'There is no such room.')
  const row = await env.DB.prepare(`${APPLICATION} WHERE a.room = ? AND a.wallet = ?`).bind(address, wallet).first<Row>()
  let standing: Standing | null = null
  try {
    ;[standing = null] = await standings(bscRpc(env, fetcher), address, [wallet])
  } catch {
    standing = null
  }
  const muted = await env.DB.prepare('SELECT 1 AS muted FROM room_mutes WHERE room = ? AND wallet = ?').bind(address, wallet).first<Row>()
  return json({ wallet, code: postCode(address, wallet), dev: room.creator === wallet, muted: muted !== null, standing, application: row ? toApplication(row, standing) : null })
}

async function apply(request: Request, env: RoomsEnv, fetcher: typeof fetch, address: string): Promise<Response> {
  const wallet = await sessionWallet(request, env.DB)
  if (!wallet) return signInFirst()
  const input = await readObject(request, 8192)
  if (input instanceof Response) return input
  const room = await loadRoom(env, fetcher, address, ROOM_FRESH_SECONDS)
  if (!room) return failure(404, 'There is no such room.')
  if (room.launched === 1) return failure(409, 'This room has launched and takes no more applications.')
  // Past the deadline the room's contract lets nobody in any more.
  if (Number(room.sale_deadline) <= Math.floor(Date.now() / 1000)) return failure(409, "This room's deadline has passed: it lets nobody in any more.")
  try {
    const [standing] = await standings(bscRpc(env, fetcher), address, [wallet])
    if (standing?.banned) return failure(403, 'The dev has barred this wallet from the room.')
  } catch {
    // Unread: the application is taken, and the room's contract still refuses a barred wallet when the dev lets it in.
  }

  let postUrl: string | null = null
  if (room.want_post === 1) {
    const parsed = parsePostUrl(input.postUrl)
    if (!parsed) return failure(400, 'Paste the link to your post on X: https://x.com/<you>/status/<number>.')
    postUrl = parsed.url
  }
  const role = textField(input.role, 'The role', MAX_ROLE_LENGTH, false)
  const portfolio = textField(input.portfolio, 'The portfolio', MAX_PORTFOLIO_LENGTH, true)
  if (typeof role === 'string') return failure(400, role)
  if (typeof portfolio === 'string') return failure(400, portfolio)
  if (room.want_role === 1 && role.text === '') return failure(400, 'Say what role you would take in this project.')

  const read = await readRequirements(env, fetcher, room, wallet, postUrl)
  if (read.postState === 'missing') return failure(400, 'X says there is no such post. It may be deleted, or from an account that is not public.')
  if (read.postState === 'nocode') {
    const missing = [
      ...(read.hasCode === false ? [`your code ${postCode(address, wallet)}`] : []),
      ...(read.hasPhrase === false ? [`the words the dev requires: \u201c${String(room.post_phrase)}\u201d`] : []),
    ]
    return failure(400, `The post does not carry ${missing.join(', or ')}. Make a post that does and apply again.`)
  }
  if (read.holdState === 'unreadable') return failure(503, "This wallet's holdings could not be read right now. Try again in a moment.")
  if (read.holdState === 'short') return failure(403, 'This wallet does not hold enough of the token this room requires.')

  const now = Math.floor(Date.now() / 1000)
  try {
    // A declined application stays declined: only the dev reopens it.
    const stored = await env.DB.prepare(
      `INSERT INTO room_applications (room, wallet, post_url, post_handle, post_state, role, portfolio, held, hold_state, checked_at, status, created_at, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pending', ?10, ?10)
ON CONFLICT (room, wallet) DO UPDATE SET post_url = excluded.post_url, post_handle = excluded.post_handle, post_state = excluded.post_state,
  role = excluded.role, portfolio = excluded.portfolio, held = excluded.held, hold_state = excluded.hold_state, checked_at = excluded.checked_at,
  updated_at = excluded.updated_at
WHERE room_applications.status = 'pending'
RETURNING wallet`,
    )
      .bind(address, wallet, postUrl, read.postHandle, read.postState, room.want_role === 1 ? role.text : null, room.want_role === 1 && portfolio.text !== '' ? portfolio.text : null, read.held, read.holdState, now)
      .first<Row>()
    if (!stored) return failure(409, 'The dev declined this application. It can only be reopened by the dev.')
  } catch (error) {
    if (String(error).includes('room_applications.room, room_applications.post_url')) return failure(409, 'That post was already handed in by another wallet.')
    throw error
  }
  return myApplication(request, env, fetcher, address)
}

async function applications(request: Request, env: RoomsEnv, fetcher: typeof fetch, address: string): Promise<Response> {
  const wallet = await sessionWallet(request, env.DB)
  if (!wallet) return signInFirst()
  const room = await loadRoom(env, fetcher, address, ROOM_FRESH_SECONDS)
  if (!room) return failure(404, 'There is no such room.')
  if (room.creator !== wallet) return failure(403, "Only the room's dev sees its applications.")
  const rows = await env.DB.prepare(`${APPLICATION} WHERE a.room = ? ORDER BY a.created_at LIMIT ?`).bind(address, MAX_APPLICATIONS).all<Row>()
  let read: Array<Standing | null> = []
  try {
    read = await standings(bscRpc(env, fetcher), address, rows.results.map((row) => String(row.wallet)))
  } catch {
    read = []
  }
  return json({ applications: rows.results.map((row, index) => toApplication(row, read[index])) })
}

async function review(request: Request, env: RoomsEnv, fetcher: typeof fetch, address: string, applicant: string): Promise<Response> {
  const wallet = await sessionWallet(request, env.DB)
  if (!wallet) return signInFirst()
  const input = await readObject(request, 1024)
  if (input instanceof Response) return input
  const room = await loadRoom(env, fetcher, address, ROOM_FRESH_SECONDS)
  if (!room) return failure(404, 'There is no such room.')
  if (room.creator !== wallet) return failure(403, "Only the room's dev reviews its applications.")
  const db = env.DB
  const existing = await db.prepare('SELECT post_url, status FROM room_applications WHERE room = ? AND wallet = ?').bind(address, applicant).first<Row>()
  if (!existing) return failure(404, 'That wallet has not applied to this room.')
  const now = Math.floor(Date.now() / 1000)

  let ready: boolean | undefined
  /** On a check of a post that is up: whether it carries the code, and the words the dev requires. */
  let said: { hasCode?: boolean; hasPhrase?: boolean } = {}
  if (input.action === 'decline' || input.action === 'reopen') {
    await db.prepare('UPDATE room_applications SET status = ?, updated_at = ? WHERE room = ? AND wallet = ?').bind(input.action === 'decline' ? 'declined' : 'pending', now, address, applicant).run()
  } else if (input.action === 'check') {
    // Everything is read again, now: an applicant is let in on what is true at this moment, not when they applied.
    const read = await readRequirements(env, fetcher, room, applicant, text(existing.post_url))
    await db.prepare('UPDATE room_applications SET post_state = ?, post_handle = COALESCE(?, post_handle), held = ?, hold_state = ?, checked_at = ? WHERE room = ? AND wallet = ?')
      .bind(read.postState, read.postHandle, read.held, read.holdState, now, address, applicant)
      .run()
    ready = requirementsMet(room, read)
    said = { ...(read.hasCode === undefined ? {} : { hasCode: read.hasCode }), ...(read.hasPhrase === undefined ? {} : { hasPhrase: read.hasPhrase }) }
  } else {
    return failure(400, "action must be 'check', 'decline' or 'reopen'.")
  }

  const row = await db.prepare(`${APPLICATION} WHERE a.room = ? AND a.wallet = ?`).bind(address, applicant).first<Row>()
  let standing: Standing | null = null
  try {
    ;[standing = null] = await standings(bscRpc(env, fetcher), address, [applicant])
  } catch {
    standing = null
  }
  return json({ application: row ? toApplication(row, standing) : null, ...(ready === undefined ? {} : { ready }), ...said })
}

// ─────────────────────────────────────────────────────────────────────────────
// The private chat
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads the room from the chain again when its copy is more than a second old. True when it did: the caller
 * then looks at the members once more. A wallet that was just let in or just bought its pass is seen at once
 * this way, without every request reading the chain.
 */
async function seatedNow(env: RoomsEnv, fetcher: typeof fetch, room: Row): Promise<boolean> {
  if (room.launched === 1 || Math.floor(Date.now() / 1000) - Number(room.synced_at) < 2) return false
  await loadRoom(env, fetcher, String(room.address), 1)
  return true
}

/**
 * Whether `wallet` may read and write the room's chat: its dev, or a wallet holding a pass that the dev has
 * not taken out. A `Response` says why not.
 */
async function chatAccess(request: Request, env: RoomsEnv, fetcher: typeof fetch, address: string): Promise<{ wallet: string; room: Row } | Response> {
  const wallet = await sessionWallet(request, env.DB)
  if (!wallet) return signInFirst()
  const room = await loadRoom(env, fetcher, address, CHAT_FRESH_SECONDS)
  if (!room) return failure(404, 'There is no such room.')
  if (room.creator === wallet) return { wallet, room }
  const standing = () =>
    env.DB.prepare(
      'SELECT EXISTS (SELECT 1 FROM room_members WHERE room = ?1 AND wallet = ?2) AS member, EXISTS (SELECT 1 FROM room_mutes WHERE room = ?1 AND wallet = ?2) AS muted',
    )
      .bind(address, wallet)
      .first<Row>()
  let row = await standing()
  // Not a member by the copy: the wallet may have bought its pass a moment ago, so the chain is read before
  // it is turned away.
  if (row?.member !== 1 && (await seatedNow(env, fetcher, room))) row = await standing()
  if (row?.member !== 1) return failure(403, "This chat is for the room's dev and the wallets holding its pass.")
  if (row.muted === 1) return failure(403, 'The dev has taken this wallet out of the chat.')
  return { wallet, room }
}

const MESSAGES = `SELECT m.id, m.author, m.body, m.picture, m.created_at, n.name AS author_name, c.tag AS author_clan FROM room_messages m ${identity('m.author', '')}`

const toMessage = (row: Row) => ({
  id: row.id,
  author: row.author,
  authorName: text(row.author_name),
  authorClan: text(row.author_clan),
  body: row.body,
  picture: text(row.picture),
  createdAt: row.created_at,
})

async function messages(request: Request, env: RoomsEnv, fetcher: typeof fetch, address: string, url: URL): Promise<Response> {
  const access = await chatAccess(request, env, fetcher, address)
  if (access instanceof Response) return access
  const requested = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT)
  const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_LIMIT) : DEFAULT_LIMIT
  const after = url.searchParams.get('after')
  if (after === null) {
    const newest = await env.DB.prepare(`${MESSAGES} WHERE m.room = ? ORDER BY m.id DESC LIMIT ?`).bind(address, limit).all<Row>()
    return json({ messages: newest.results.reverse().map(toMessage) })
  }
  if (!/^\d{1,15}$/.test(after)) return failure(400, 'after must be the id of a message.')
  const later = await env.DB.prepare(`${MESSAGES} WHERE m.room = ? AND m.id > ? ORDER BY m.id LIMIT ?`).bind(address, Number(after), limit).all<Row>()
  return json({ messages: later.results.map(toMessage) })
}

async function say(request: Request, env: RoomsEnv, fetcher: typeof fetch, address: string): Promise<Response> {
  const access = await chatAccess(request, env, fetcher, address)
  if (access instanceof Response) return access
  const { wallet } = access
  const input = await readObject(request, 8192)
  if (input instanceof Response) return input
  if (typeof input.body !== 'string') return failure(400, 'body must be text.')
  const body = cleanBody(input.body)
  const picture = input.picture === undefined || input.picture === null ? null : input.picture
  if (picture !== null && (typeof picture !== 'string' || !HASH.test(picture))) return failure(400, 'picture must be the hash of a picture posted to this room.')
  if (body === '' && picture === null) return failure(400, 'The message is empty.')
  if (lengthOf(body) > MAX_MESSAGE_LENGTH) return failure(400, `The message is longer than ${MAX_MESSAGE_LENGTH} characters.`)

  const db = env.DB
  const now = Math.floor(Date.now() / 1000)
  // One transaction. The insert enforces the limits itself, so two requests racing each other cannot both get
  // past them; the first statement reads why a message was turned away.
  const [status, inserted] = await db.batch<Row>([
    db
      .prepare(
        `SELECT
  (SELECT MAX(created_at) FROM room_messages WHERE author = ?1) AS latest,
  (SELECT COUNT(*) FROM room_messages WHERE author = ?1 AND created_at > ?2) AS in_hour,
  (?3 IS NULL OR EXISTS (SELECT 1 FROM pictures WHERE hash = ?3 AND room = ?4)) AS picture_known`,
      )
      .bind(wallet, now - 3600, picture, address),
    db
      .prepare(
        `INSERT INTO room_messages (room, author, body, picture, created_at)
SELECT ?1, ?2, ?3, ?4, ?5
WHERE NOT EXISTS (SELECT 1 FROM room_messages WHERE author = ?2 AND created_at > ?6)
  AND (SELECT COUNT(*) FROM room_messages WHERE author = ?2 AND created_at > ?7) < ?8
  AND (?4 IS NULL OR EXISTS (SELECT 1 FROM pictures WHERE hash = ?4 AND room = ?1))
RETURNING id`,
      )
      .bind(address, wallet, body, picture, now, now - MIN_GAP_SECONDS, now - 3600, MAX_MESSAGES_PER_HOUR),
  ])
  const id = inserted?.results[0]?.id
  if (typeof id === 'number') return json({ message: { id, author: wallet, body, picture, createdAt: now } }, 201)

  const before = status?.results[0]
  if (before?.picture_known !== 1) return failure(400, 'That picture was not posted to this room.')
  if (typeof before.latest === 'number' && before.latest > now - MIN_GAP_SECONDS) return failure(429, 'You are posting too fast. Wait a second.', { 'retry-after': '1' })
  if (Number(before.in_hour ?? 0) >= MAX_MESSAGES_PER_HOUR) return failure(429, `You have posted ${MAX_MESSAGES_PER_HOUR} messages in the last hour, which is the limit.`)
  return failure(503, 'The message could not be stored. Try again.')
}

// ─────────────────────────────────────────────────────────────────────────────
// What the dev gives: points, tags, and the door of the chat
// ─────────────────────────────────────────────────────────────────────────────

/** The dev's request about one member: the room, the member's wallet and the request's own fields. */
async function devAction(request: Request, env: RoomsEnv, fetcher: typeof fetch, address: string): Promise<{ input: Record<string, unknown>; member: string } | Response> {
  const wallet = await sessionWallet(request, env.DB)
  if (!wallet) return signInFirst()
  const input = await readObject(request, 2048)
  if (input instanceof Response) return input
  const room = await loadRoom(env, fetcher, address, ROOM_FRESH_SECONDS)
  if (!room) return failure(404, 'There is no such room.')
  if (room.creator !== wallet) return failure(403, "Only the room's dev can do that.")
  if (typeof input.wallet !== 'string' || !ADDRESS.test(input.wallet)) return failure(400, 'wallet must be a 0x address.')
  const member = input.wallet.toLowerCase()
  const holdsPass = () => env.DB.prepare('SELECT 1 AS seated FROM room_members WHERE room = ? AND wallet = ?').bind(address, member).first<Row>()
  let seated = await holdsPass()
  if (!seated && (await seatedNow(env, fetcher, room))) seated = await holdsPass()
  if (!seated) return failure(404, 'That wallet does not hold a pass of this room.')
  return { input, member }
}

async function givePoints(request: Request, env: RoomsEnv, fetcher: typeof fetch, address: string): Promise<Response> {
  const action = await devAction(request, env, fetcher, address)
  if (action instanceof Response) return action
  const { input, member } = action
  const points = input.points
  if (typeof points !== 'number' || !Number.isInteger(points) || points < 1 || points > MAX_POINTS) return failure(400, `points must be a whole number from 1 to ${MAX_POINTS}.`)
  const note = textField(input.note, 'The note', MAX_NOTE_LENGTH, false)
  if (typeof note === 'string') return failure(400, note)
  const now = Math.floor(Date.now() / 1000)
  const [before, stored] = await env.DB.batch<Row>([
    env.DB.prepare('SELECT COALESCE(SUM(points), 0) AS total FROM room_points WHERE room = ? AND wallet = ?').bind(address, member),
    env.DB.prepare(
      `INSERT INTO room_points (room, wallet, points, note, created_at)
SELECT ?1, ?2, ?3, ?4, ?5 WHERE (SELECT COALESCE(SUM(points), 0) FROM room_points WHERE room = ?1 AND wallet = ?2) + ?3 <= ?6
RETURNING id`,
    ).bind(address, member, points, note.text, now, MAX_POINTS),
  ])
  const had = Number(before?.results[0]?.total ?? 0)
  if (typeof stored?.results[0]?.id !== 'number') {
    return failure(409, `A member can have ${MAX_POINTS} points from one room. This one has ${had}, so ${MAX_POINTS - had} more at most.`)
  }
  return json({ wallet: member, points: had + points }, 201)
}

async function giveTag(request: Request, env: RoomsEnv, fetcher: typeof fetch, address: string): Promise<Response> {
  const action = await devAction(request, env, fetcher, address)
  if (action instanceof Response) return action
  const { input, member } = action
  if (input.label === null) {
    await env.DB.prepare('DELETE FROM room_tags WHERE room = ? AND wallet = ?').bind(address, member).run()
    return json({ wallet: member, tag: null })
  }
  const label = textField(input.label, 'The tag', MAX_TAG_LENGTH, false)
  if (typeof label === 'string') return failure(400, label)
  if (label.text === '') return failure(400, 'Say what the member does in the project, in a word or two.')
  await env.DB.prepare('INSERT INTO room_tags (room, wallet, label, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (room, wallet) DO UPDATE SET label = excluded.label')
    .bind(address, member, label.text, Math.floor(Date.now() / 1000))
    .run()
  return json({ wallet: member, tag: label.text }, 201)
}

async function mute(request: Request, env: RoomsEnv, fetcher: typeof fetch, address: string): Promise<Response> {
  const action = await devAction(request, env, fetcher, address)
  if (action instanceof Response) return action
  const { input, member } = action
  if (typeof input.muted !== 'boolean') return failure(400, 'muted must be true or false.')
  if (input.muted) {
    await env.DB.prepare('INSERT INTO room_mutes (room, wallet, created_at) VALUES (?, ?, ?) ON CONFLICT (room, wallet) DO NOTHING').bind(address, member, Math.floor(Date.now() / 1000)).run()
  } else {
    await env.DB.prepare('DELETE FROM room_mutes WHERE room = ? AND wallet = ?').bind(address, member).run()
  }
  return json({ wallet: member, muted: input.muted })
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

/** Routes `/api/rooms/...`. `fetcher` is how the chain and X are reached. */
export async function handleRooms(request: Request, env: RoomsEnv, fetcher: typeof fetch = fetch): Promise<Response> {
  const reading = request.method === 'GET' || request.method === 'HEAD'
  const posting = request.method === 'POST'
  if (!reading && !posting) return failure(405, 'Method not allowed.', { allow: 'GET, HEAD, POST' })

  const url = new URL(request.url)
  const [, api, rooms, first, second, third, extra] = url.pathname.split('/')
  if (api !== 'api' || rooms !== 'rooms' || extra !== undefined) return failure(404, 'Not found.')

  try {
    if (first === undefined || first === '') return reading ? await list(env.DB, url) : await settings(request, env, fetcher)
    if (first === 'images' && second === undefined && posting) {
      const wallet = await sessionWallet(request, env.DB)
      return wallet ? await storePicture(request, env.DB, wallet, '') : signInFirst()
    }
    if (first === 'image' && second !== undefined && third === undefined && reading) {
      return HASH.test(second) ? await servePicture(env.DB, second, '') : failure(400, 'A picture is named by its 64-character hash.')
    }
    if (!ADDRESS.test(first)) return failure(404, 'Not found.')
    const address = first.toLowerCase()

    if (second === undefined) return reading ? await detail(env, fetcher, address) : failure(405, 'Method not allowed.', { allow: 'GET, HEAD' })
    if (second === 'sync' && third === undefined && posting) return await detail(env, fetcher, address, 1)
    if (second === 'application' && third === undefined) return reading ? await myApplication(request, env, fetcher, address) : await apply(request, env, fetcher, address)
    if (second === 'applications' && third === undefined && reading) return await applications(request, env, fetcher, address)
    if (second === 'applications' && third !== undefined && posting) {
      return ADDRESS.test(third) ? await review(request, env, fetcher, address, third.toLowerCase()) : failure(400, 'The applicant must be a 0x address.')
    }
    if (second === 'messages' && third === undefined) return reading ? await messages(request, env, fetcher, address, url) : await say(request, env, fetcher, address)
    if (second === 'pictures' && third === undefined && posting) {
      const access = await chatAccess(request, env, fetcher, address)
      return access instanceof Response ? access : await storePicture(request, env.DB, access.wallet, address)
    }
    if (second === 'pictures' && third !== undefined && reading) {
      if (!HASH.test(third)) return failure(400, 'A picture is named by its 64-character hash.')
      const access = await chatAccess(request, env, fetcher, address)
      return access instanceof Response ? access : await servePicture(env.DB, third, address)
    }
    if (third === undefined && posting) {
      if (second === 'points') return await givePoints(request, env, fetcher, address)
      if (second === 'tags') return await giveTag(request, env, fetcher, address)
      if (second === 'mutes') return await mute(request, env, fetcher, address)
    }
    return failure(404, 'Not found.')
  } catch (error) {
    console.error(JSON.stringify({ roomsFailed: String(error).slice(0, 500) }))
    return failure(500, 'Rooms are unavailable right now. Try again in a moment.')
  }
}
