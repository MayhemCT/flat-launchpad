/**
 * `/api/callouts/bsc/...`: links to social posts that call a token out, and their review.
 *
 *   GET  /api/callouts/bsc/<token>?limit=<n>                         a token's callouts, newest first, each with its
 *                                                                    author's display name (null for a wallet without one).
 *   POST /api/callouts/bsc/<token>  { author, url, note, issuedAt, signature }
 *                                                                    stores one callout, signed by its author.
 *   GET  /api/callouts/bsc/review                                    the review queue, with the reviewer and vault addresses.
 *   POST /api/callouts/bsc/review   { id, decision: 'approve', epoch, deadline, signature }
 *                                   { id, decision: 'reject', issuedAt, signature }
 *                                                                    the reviewer wallet's decision on one callout.
 *   GET  /api/callouts/bsc/card/<id>                                 the picture pump.fun or fomo.family shares for that callout.
 *   GET  /api/callouts/bsc/author/<address>                          the tokens that wallet has a counted-or-countable callout on.
 *
 * A callout is for a holder. When one is posted, the author's balance of the token and the token's market cap
 * are read (apps/worker/src/market.ts) and stored with it; the market cap goes into the attestation, and the
 * cron keeps reading the balance to say whether the author still holds: see `refreshPositions`.
 *
 * Nobody logs in. A callout is accepted when its author's wallet signed its exact text (EIP-191
 * `personal_sign`). An approval is accepted when it is the reviewer wallet's EIP-712 signature over the very
 * attestation the rewards vault checks. The Worker cannot make an attestation: it holds no key that can.
 *
 * The vault takes an attestation from anyone who brings it, so the Worker brings it itself, and the author
 * never has to confirm a transaction: see `relaySubmission`. That is what the one key the Worker may hold is
 * for (`RELAYER_PRIVATE_KEY`, a Worker secret). It pays gas and nothing else: it cannot approve a callout,
 * move anyone's rewards or change what an attestation says. It is never logged and never part of a response.
 * Without it, authors record their own approved callouts from the page, as before.
 *
 * A link is never stored as it was typed. It is taken apart by fixed rules for the three sites that are
 * accepted and rebuilt in one canonical spelling, so the address the page links to is always one this file
 * wrote out itself. Every value reaches the database as a bound parameter of a prepared statement.
 */
import { CHAINS } from '@flat/protocol'
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  nonceManager,
  parseAbi,
  toBytes,
  verifyMessage,
  verifyTypedData,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { bsc } from 'viem/chains'
import { canonicalSignature, cleanBody, containsLink, issuedAtInWindow } from './chat.js'
import { readCapped as readResponseCapped } from './ipfs.js'
import { balanceOf, balancesOf, bscRpc, marketCapUsd, positionClosed } from './market.js'

/** The part of the Worker's environment callouts use. */
export interface CalloutEnv {
  DB: D1Database
  /** The reviewer wallet. A public address, not a secret. */
  CALLOUT_ATTESTER?: string
  /** The rewards vault the attestations are for. A public address. */
  CALLZ_VAULT?: string
  /** Optional private BNB Chain endpoint. Public ones are used when unset. */
  BSC_RPC_URL?: string
  /**
   * A Worker secret: the key of a wallet that only pays gas, used to bring approved callouts to the vault.
   * Never logged, never returned. Unset: authors record their own.
   */
  RELAYER_PRIVATE_KEY?: string
}

export const CALLOUT_CHAIN = 'bsc'
/** BNB Chain mainnet: the chain id in the attestation's EIP-712 domain. */
export const CALLOUT_CHAIN_ID = 56
/** Longest link, in characters, as it is pasted. */
export const MAX_LINK_LENGTH = 300
/** Longest note, in characters (Unicode code points) after cleaning. */
export const MAX_NOTE_LENGTH = 140
/** A round is one UTC day. */
export const EPOCH_SECONDS = 86_400
/** In the last minutes of a round, an approval may already be for the next one. */
export const NEXT_EPOCH_LEAD_SECONDS = 300

export const KIND_X = 0
export const KIND_PUMP = 1
export const KIND_FOMO = 2
export type CalloutKind = typeof KIND_X | typeof KIND_PUMP | typeof KIND_FOMO

const DEFAULT_LIMIT = 30
const MAX_LIMIT = 100
const REVIEW_LIMIT = 200
const MAX_REQUEST_BYTES = 4096
const HOUR_SECONDS = 3600
/** Callouts one author may post under one token in one UTC day. */
const MAX_PER_TOKEN_PER_DAY = 3
/** Callouts one author may post in an hour, across every token. */
const MAX_PER_HOUR = 10
/** Open positions whose balance one cron run re-reads, in one Multicall3 request. */
const POSITIONS_PER_RUN = 40
/** Tokens one cron run asks DexScreener about, to put a market cap on positions that closed. */
const CLOSURE_TOKENS_PER_RUN = 10
/** Approved callouts one cron run brings to the vault. */
const RELAYS_PER_RUN = 5
/** The cron leaves an approval alone this long, in seconds: the request that stored it is bringing it to the vault itself. */
const RELAY_GRACE_SECONDS = 60
/** Tokens the author endpoint lists at most. */
const AUTHOR_TOKENS = 50
const CARD_MAX_BYTES = 2_097_152
const CARD_TIMEOUT_MS = 8000
/** Raster formats only: an SVG can carry script. */
const CARD_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const CARD_USER_AGENT = 'Mozilla/5.0 (compatible; link-preview)'
const ROW_ID = /^[1-9][0-9]{0,14}$/
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const ZERO_HASH: Hex = `0x${'00'.repeat(32)}`

// ── Links ────────────────────────────────────────────────────────────────

export type ParsedCalloutLink =
  | { ok: true; kind: CalloutKind; url: string; profile: string }
  | { ok: false; error: string }

const refused = (error: string): ParsedCalloutLink => ({ ok: false, error })

const NOT_ACCEPTED = 'Only https links to a post on x.com, a callout on pump.fun or a trade on fomo.family are accepted.'
const PUMP_OTHER_CONTRACT = 'This pump.fun callout is for a different contract, so it cannot earn rewards here.'
const FOMO_OTHER_CONTRACT = 'This fomo.family callout is for a different contract, so it cannot earn rewards here.'
const FOMO_SHARE_LINK = 'Share the link of your trade on fomo.family: it carries your name and the trade.'

const X_HOSTS = new Set(['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'])
const PUMP_HOSTS = new Set(['pump.fun', 'www.pump.fun'])
const FOMO_HOSTS = new Set(['fomo.family', 'www.fomo.family'])

/** Scheme, host, path, query. The fragment is dropped. A host with a port or a "user@" part matches no accepted host. */
const LINK = /^https:\/\/([^/?#]+)(\/[^?#]*)?(?:\?([^#]*))?(?:#.*)?$/i
/** Anything after the post's id ("/photo/1") is ignored. */
const X_PATH = /^\/([A-Za-z0-9_]{1,15})\/status\/([0-9]{1,25})(?:\/.*)?$/
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
const PUMP_PATH = new RegExp(`^/callouts/(0x[0-9a-fA-F]{40})/(${UUID})$`)
const FOMO_PATH = /^\/tokens\/bnb\/(0x[0-9a-fA-F]{40})$/
const FOMO_TRADE = new RegExp(`^${UUID}$`)
const FOMO_NAME = /^[A-Za-z0-9_.-]{1,40}$/

/** The value of `name` in a query string, as written. Null when it is absent or given more than once. */
function queryValue(query: string, name: string): string | null {
  let found: string | null = null
  for (const part of query.split('&')) {
    const at = part.indexOf('=')
    if ((at === -1 ? part : part.slice(0, at)) !== name) continue
    if (found !== null) return null
    found = at === -1 ? '' : part.slice(at + 1)
  }
  return found
}

/**
 * Takes a pasted link apart and rebuilds it in its one canonical spelling, or says why it is not accepted.
 * `token` is the address the callout is posted under: a pump.fun or fomo.family link names a contract, and it
 * must be that one. Nothing here follows the link or decodes it: a link either has exactly the accepted shape
 * in plain ASCII, or it is refused.
 * Keep in sync with `parseCalloutLink` in apps/web/src/callouts.tsx.
 */
export function parseCalloutLink(raw: string, token: string): ParsedCalloutLink {
  if (typeof raw !== 'string') return refused(NOT_ACCEPTED)
  const text = raw.trim()
  if (text.length === 0) return refused('Paste the link to your callout.')
  if (text.length > MAX_LINK_LENGTH) return refused(`The link is longer than ${MAX_LINK_LENGTH} characters.`)
  // Visible ASCII only: no spaces, no control characters, no letters from other scripts made to look like these.
  if (!/^[\x21-\x7E]+$/.test(text) || text.includes('\\')) return refused(NOT_ACCEPTED)
  const match = LINK.exec(text)
  if (!match) return refused(NOT_ACCEPTED)
  const host = match[1]!.toLowerCase()
  const path = match[2] ?? '/'
  const query = match[3] ?? ''

  if (X_HOSTS.has(host)) {
    const post = X_PATH.exec(path)
    if (!post) return refused('Link to the post itself: https://x.com/<name>/status/<number>.')
    const user = post[1]!.toLowerCase()
    return { ok: true, kind: KIND_X, url: `https://x.com/${user}/status/${post[2]!}`, profile: `x:${user}` }
  }

  if (PUMP_HOSTS.has(host)) {
    const callout = PUMP_PATH.exec(path)
    if (!callout) return refused('Link to the callout itself: https://pump.fun/callouts/<contract>/<id>.')
    const contract = callout[1]!.toLowerCase()
    if (contract !== token.toLowerCase()) return refused(PUMP_OTHER_CONTRACT)
    return { ok: true, kind: KIND_PUMP, url: `https://pump.fun/callouts/${contract}/${callout[2]!.toLowerCase()}`, profile: '' }
  }

  if (FOMO_HOSTS.has(host)) {
    const page = FOMO_PATH.exec(path)
    if (!page) return refused(FOMO_SHARE_LINK)
    const contract = page[1]!.toLowerCase()
    if (contract !== token.toLowerCase()) return refused(FOMO_OTHER_CONTRACT)
    const name = queryValue(query, 'r')
    const trade = queryValue(query, 'tradeId')
    if (name === null || trade === null || !FOMO_NAME.test(name) || !FOMO_TRADE.test(trade)) return refused(FOMO_SHARE_LINK)
    // The trade is what makes the callout one of a kind, the name is whose it is. Every other parameter is dropped.
    return {
      ok: true,
      kind: KIND_FOMO,
      url: `https://fomo.family/tokens/bnb/${contract}?r=${name}&tradeId=${trade.toLowerCase()}`,
      profile: `fomo:${name.toLowerCase()}`,
    }
  }

  return refused(NOT_ACCEPTED)
}

/**
 * A LIKE pattern that matches every canonical link to the same post as `url`. X serves a post under any name
 * put in its address, and a fomo.family trade under any referrer, so the same post has more than one canonical
 * link: this is how the second one is still turned away. `url` is canonical, so the pattern is built only from
 * digits, hex and fixed text, and carries no wildcard of the visitor's.
 */
export function samePostPattern(kind: number, url: string): string {
  if (kind === KIND_X) return `https://x.com/%${url.slice(url.lastIndexOf('/status/'))}`
  if (kind === KIND_FOMO) return `https://fomo.family/tokens/bnb/%${url.slice(url.lastIndexOf('&tradeId='))}`
  return url
}

/** keccak256 of the canonical link's UTF-8 bytes: what the vault knows a link by. */
export const linkHashOf = (url: string): Hex => keccak256(toBytes(url))

/** keccak256 of the profile's UTF-8 bytes, or 32 zero bytes for a link that names no profile. */
export const profileHashOf = (profile: string): Hex => (profile === '' ? ZERO_HASH : keccak256(toBytes(profile)))

// ── What the author signs ────────────────────────────────────────────────

export interface CalloutSigningFields {
  /** The token's address. */
  token: string
  /** The canonical link: see `parseCalloutLink`. */
  url: string
  /** The cleaned note; empty when there is none. */
  note: string
  /** Unix seconds. */
  issuedAt: number
}

/**
 * The exact text an author's wallet signs for one callout.
 * Keep in sync with `calloutSigningText` in apps/web/src/callouts.tsx: one character of difference and no signature verifies.
 */
export function calloutSigningText({ token, url, note, issuedAt }: CalloutSigningFields): string {
  return `CallZ callout\n\nToken: ${token.toLowerCase()}\nNetwork: ${CALLOUT_CHAIN}\nLink: ${url}\nTime: ${issuedAt}\n\n${note}`
}

/**
 * The exact text the reviewer wallet signs to reject one callout.
 * Keep in sync with `reviewRejectText` in apps/web/src/callouts.tsx.
 */
export function reviewRejectText(id: number, issuedAt: number): string {
  return `CallZ review\n\nReject callout ${id}\nTime: ${issuedAt}`
}

export interface CalloutPost {
  /** Lowercase address. */
  author: string
  kind: CalloutKind
  /** Canonical link. */
  url: string
  profile: string
  /** Cleaned note. */
  note: string
  issuedAt: number
  /** Canonical signature. */
  signature: Hex
}

export type ParsedCalloutPost = { ok: true; post: CalloutPost } | { ok: false; error: string }

const invalid = (error: string): ParsedCalloutPost => ({ ok: false, error })

/** Checks the shape of a POST body and returns its fields in the form they are verified and stored in. */
export function parseCalloutPost(input: unknown, token: string): ParsedCalloutPost {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalid('Send a JSON object with author, url, note, issuedAt and signature.')
  }
  const { author, url, note, issuedAt, signature } = input as Record<string, unknown>
  if (typeof author !== 'string' || !ADDRESS.test(author)) return invalid('author must be a 0x address.')
  if (typeof url !== 'string') return invalid('url must be text.')
  const link = parseCalloutLink(url, token)
  if (!link.ok) return invalid(link.error)
  if (note !== undefined && note !== null && typeof note !== 'string') return invalid('note must be text.')
  const cleaned = cleanBody(note ?? '')
  if ([...cleaned].length > MAX_NOTE_LENGTH) return invalid(`The note is longer than ${MAX_NOTE_LENGTH} characters.`)
  if (containsLink(cleaned)) return invalid('Links are not allowed in the note. The callout link goes in its own box.')
  if (typeof issuedAt !== 'number' || !Number.isSafeInteger(issuedAt) || issuedAt < 0) {
    return invalid('issuedAt must be a unix time in whole seconds.')
  }
  const canonical = canonicalSignature(signature)
  if (!canonical) {
    return invalid('signature must be a 65-byte signature from a plain wallet. Smart contract wallets are not supported.')
  }
  return {
    ok: true,
    post: { author: author.toLowerCase(), kind: link.kind, url: link.url, profile: link.profile, note: cleaned, issuedAt, signature: canonical },
  }
}

/** True when `signature` is `signer`'s wallet signature over `text`. */
async function signedBy(signer: string, text: string, signature: Hex): Promise<boolean> {
  try {
    return await verifyMessage({ address: signer.toLowerCase() as Address, message: text, signature })
  } catch {
    // Bytes that are not a signature at all recover no address.
    return false
  }
}

/** True when `signature` is `author`'s wallet signature over this callout's signing text. */
export function verifyCalloutSignature(callout: CalloutSigningFields & { author: string; signature: Hex }): Promise<boolean> {
  return signedBy(callout.author, calloutSigningText(callout), callout.signature)
}

// ── What the reviewer signs ──────────────────────────────────────────────

/** The EIP-712 struct the rewards vault checks. Keep in sync with the vault contract and apps/web/src/rewards.ts. */
export const SUBMISSION_TYPES = {
  Submission: [
    { name: 'holder', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'epoch', type: 'uint256' },
    { name: 'kind', type: 'uint8' },
    { name: 'linkHash', type: 'bytes32' },
    { name: 'profileHash', type: 'bytes32' },
    { name: 'mcap', type: 'uint256' },
    { name: 'held', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

/** Addresses are written in lowercase throughout: a mixed-case one must carry a valid checksum, a lowercase one is always taken. */
export const submissionDomain = (vault: string) =>
  ({ name: 'CallZ Vault', version: '1', chainId: CALLOUT_CHAIN_ID, verifyingContract: vault.toLowerCase() as Address }) as const

export interface Submission {
  holder: string
  token: string
  epoch: number
  kind: number
  linkHash: Hex
  profileHash: Hex
  /** The token's market cap when the callout was posted, in whole US dollars. */
  mcap: number
  /** What the author's wallet held of the token when the callout was posted, in base units, as a decimal string. */
  held: string
  /** The callout's id. */
  nonce: number
  deadline: number
}

/** True when `signature` is `attester`'s EIP-712 signature over `submission`, for the vault at `vault`. */
export async function verifyAttestation(attester: string, vault: string, submission: Submission, signature: Hex): Promise<boolean> {
  try {
    return await verifyTypedData({
      address: attester.toLowerCase() as Address,
      domain: submissionDomain(vault),
      types: SUBMISSION_TYPES,
      primaryType: 'Submission',
      message: {
        holder: submission.holder.toLowerCase() as Address,
        token: submission.token.toLowerCase() as Address,
        epoch: BigInt(submission.epoch),
        kind: submission.kind,
        linkHash: submission.linkHash,
        profileHash: submission.profileHash,
        mcap: BigInt(submission.mcap),
        held: BigInt(submission.held),
        nonce: BigInt(submission.nonce),
        deadline: BigInt(submission.deadline),
      },
      signature,
    })
  } catch {
    return false
  }
}

/** The round `now` (unix seconds) falls in. */
export const currentEpoch = (now: number): number => Math.floor(now / EPOCH_SECONDS)

/**
 * Why an approval for `epoch` that is valid until `deadline` is not accepted at `now`, or null when it is.
 * An approval is for the round in progress (or the next one, in the last minutes of a round), and stops being
 * valid no later than the end of its round.
 */
export function approvalWindowError(epoch: number, deadline: number, now: number): string | null {
  const current = currentEpoch(now)
  const next = epoch === current + 1 && now >= (current + 1) * EPOCH_SECONDS - NEXT_EPOCH_LEAD_SECONDS
  if (epoch !== current && !next) return `epoch must be the current round, ${current}.`
  if (deadline > (epoch + 1) * EPOCH_SECONDS) return 'deadline must be no later than the end of the round.'
  if (deadline <= now) return 'deadline has already passed.'
  return null
}

// ── HTTP ─────────────────────────────────────────────────────────────────

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

const COLUMNS =
  'id, token, author, kind, url, link_hash, profile, note, status, created_at, reviewed_at, epoch, deadline, attestation, call_mcap, call_balance, held_balance, position, closed_at, closed_mcap, record_tx'

/**
 * A listed callout `c` with its author's display name beside it (apps/worker/src/names.ts): the name the
 * wallet has now, and null for a wallet without one. Read with the callouts, so the page asks once.
 */
const LISTED = `SELECT ${COLUMNS.split(', ').map((column) => `c.${column}`).join(', ')}, n.name AS author_name FROM callouts c LEFT JOIN wallet_names n ON n.wallet = c.author`

const toListed = (row: Row) => ({ ...toCallout(row), authorName: typeof row.author_name === 'string' ? row.author_name : null })

function toCallout(row: Row) {
  const approved = row.status === 'approved'
  return {
    id: row.id,
    author: row.author,
    kind: row.kind,
    url: row.url,
    note: row.note,
    status: row.status,
    createdAt: row.created_at,
    linkHash: row.link_hash,
    profileHash: profileHashOf(String(row.profile ?? '')),
    epoch: approved ? row.epoch : null,
    deadline: approved ? row.deadline : null,
    attestation: approved ? row.attestation : null,
    /** When the reviewer decided (unix seconds), and the transaction that took the approval to the vault, if the Worker sent one. */
    reviewedAt: approved ? (row.reviewed_at ?? null) : null,
    recordTx: approved ? (row.record_tx ?? null) : null,
    callMcap: row.call_mcap ?? null,
    callBalance: row.call_balance ?? null,
    heldBalance: row.held_balance ?? null,
    position: row.position === 'closed' ? 'closed' : 'open',
    closedAt: row.closed_at ?? null,
    closedMcap: row.closed_mcap ?? null,
  }
}

/** Reads a request body up to `maxBytes`. Null when it is larger: nothing oversized is buffered. */
async function readCapped(request: Request, maxBytes: number): Promise<Uint8Array | null> {
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

/** The JSON a POST carries, or the response that turns it away. */
async function readJson(request: Request): Promise<{ input: unknown } | { response: Response }> {
  const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (type !== 'application/json') return { response: failure(400, 'Send the request as application/json.') }
  const bytes = await readCapped(request, MAX_REQUEST_BYTES)
  if (!bytes) return { response: failure(413, 'The request is larger than 4 KB.') }
  try {
    return { input: JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) }
  } catch {
    return { response: failure(400, 'The request body is not valid JSON.') }
  }
}

async function list(env: CalloutEnv, token: string, url: URL): Promise<Response> {
  const db = env.DB
  const requested = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT)
  const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_LIMIT) : DEFAULT_LIMIT
  const rows = await db
    .prepare(`${LISTED} WHERE c.chain = ? AND c.token = ? AND c.status IN ('pending', 'approved') ORDER BY c.id DESC LIMIT ?`)
    .bind(CALLOUT_CHAIN, token, limit)
    .all<Row>()
  return json({ autoRecord: autoRecordOn(env), callouts: rows.results.map(toListed) })
}

async function post(request: Request, env: CalloutEnv, token: string): Promise<Response> {
  const db = env.DB
  const body = await readJson(request)
  if ('response' in body) return body.response

  const parsed = parseCalloutPost(body.input, token)
  if (!parsed.ok) return failure(400, parsed.error)
  const { author, kind, url, profile, note, issuedAt, signature } = parsed.post
  const now = Math.floor(Date.now() / 1000)
  if (!issuedAtInWindow(issuedAt, now)) {
    return failure(400, 'The callout time is more than 5 minutes from the server clock. Check the clock on your device and try again.')
  }
  if (!(await verifyCalloutSignature({ token, url, note, issuedAt, author, signature }))) {
    return failure(403, 'The signature does not match this wallet and callout.')
  }

  // What the callout is weighed by, read now and stored with it. Neither is ever assumed: a balance or a
  // market cap that could not be read turns the callout away instead.
  const [callBalance, callMcap] = await Promise.all([
    balanceOf(bscRpc(env), token, author).catch((error: unknown) => {
      console.error(JSON.stringify({ calloutBalanceFailed: String(error).slice(0, 300) }))
      return null
    }),
    marketCapUsd(token, fetch, bscRpc(env)),
  ])
  if (callBalance === null) return failure(503, 'This wallet’s holdings could not be read right now. Try again in a moment.')
  if (callBalance === 0n) return failure(403, 'Callouts are for holders: this wallet holds none of this token.')
  if (callMcap === null) return failure(503, 'The token’s market cap could not be read right now. Try again in a moment.')
  const held = callBalance.toString()

  const linkHash = linkHashOf(url)
  const samePost = samePostPattern(kind, url)
  const dayStart = currentEpoch(now) * EPOCH_SECONDS

  // One transaction. The insert enforces the limits itself, so two requests racing each other cannot both get
  // past them; the first statement reads why a callout was turned away.
  const [status, inserted] = await db.batch<Row>([
    db
      .prepare(
        `SELECT
  EXISTS (SELECT 1 FROM callouts WHERE signature = ?1) AS replayed,
  EXISTS (SELECT 1 FROM callouts WHERE link_hash = ?2 OR (kind = ?3 AND url LIKE ?4)) AS duplicate,
  (SELECT COUNT(*) FROM callouts WHERE author = ?5 AND chain = ?6 AND token = ?7 AND created_at >= ?8) AS in_day,
  (SELECT COUNT(*) FROM callouts WHERE author = ?5 AND created_at > ?9) AS in_hour,
  (SELECT MIN(created_at) FROM callouts WHERE author = ?5 AND created_at > ?9) AS oldest_in_hour`,
      )
      .bind(signature, linkHash, kind, samePost, author, CALLOUT_CHAIN, token, dayStart, now - HOUR_SECONDS),
    db
      .prepare(
        `INSERT INTO callouts (chain, token, author, kind, url, link_hash, profile, note, signature, created_at, call_mcap, call_balance, held_balance, checked_at)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?16, ?17, ?17, ?10
WHERE (SELECT COUNT(*) FROM callouts WHERE author = ?3 AND chain = ?1 AND token = ?2 AND created_at >= ?11) < ?12
  AND (SELECT COUNT(*) FROM callouts WHERE author = ?3 AND created_at > ?13) < ?14
  AND NOT EXISTS (SELECT 1 FROM callouts WHERE kind = ?4 AND url LIKE ?15)
ON CONFLICT DO NOTHING
RETURNING id`,
      )
      .bind(
        CALLOUT_CHAIN, token, author, kind, url, linkHash, profile, note, signature, now,
        dayStart, MAX_PER_TOKEN_PER_DAY, now - HOUR_SECONDS, MAX_PER_HOUR, samePost, callMcap, held,
      ),
  ])

  const id = inserted?.results[0]?.id
  if (typeof id === 'number') {
    return json(
      {
        callout: {
          id, author, kind, url, note, status: 'pending', createdAt: now, linkHash, profileHash: profileHashOf(profile),
          epoch: null, deadline: null, attestation: null, reviewedAt: null, recordTx: null,
          callMcap, callBalance: held, heldBalance: held, position: 'open', closedAt: null, closedMcap: null,
        },
      },
      201,
    )
  }

  const before = status?.results[0]
  if (before?.replayed === 1) return failure(409, 'This callout was already posted.')
  if (before?.duplicate === 1) return failure(409, 'This link was already posted. Each link can be posted once.')
  if (Number(before?.in_day ?? 0) >= MAX_PER_TOKEN_PER_DAY) {
    return failure(429, `You have posted ${MAX_PER_TOKEN_PER_DAY} callouts for this token today, which is the limit. Try again after 00:00 UTC.`, {
      'retry-after': String(Math.max(1, dayStart + EPOCH_SECONDS - now)),
    })
  }
  if (Number(before?.in_hour ?? 0) >= MAX_PER_HOUR) {
    const oldest = typeof before?.oldest_in_hour === 'number' ? before.oldest_in_hour : now
    return failure(429, `You have posted ${MAX_PER_HOUR} callouts in the last hour, which is the limit. Try again later.`, {
      'retry-after': String(Math.max(1, oldest + HOUR_SECONDS - now)),
    })
  }
  return failure(503, 'The callout could not be stored. Try again.')
}

async function reviewQueue(env: CalloutEnv, attester: string, vault: string): Promise<Response> {
  const rows = await env.DB
    .prepare(`${LISTED} WHERE c.chain = ? AND c.status IN ('pending', 'approved') ORDER BY c.id DESC LIMIT ?`)
    .bind(CALLOUT_CHAIN, REVIEW_LIMIT)
    .all<Row>()
  return json({ attester, vault, autoRecord: autoRecordOn(env), callouts: rows.results.map((row) => ({ ...toListed(row), token: row.token })) })
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

async function review(request: Request, env: CalloutEnv, attester: string, vault: string, fetcher: typeof fetch): Promise<Response> {
  const db = env.DB
  const body = await readJson(request)
  if ('response' in body) return body.response
  const input = body.input
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return failure(400, 'Send a JSON object with id, decision and signature.')
  }
  const { id, decision, epoch, deadline, issuedAt, signature } = input as Record<string, unknown>
  if (!isCount(id) || id === 0) return failure(400, 'id must be the id of a callout.')
  if (decision !== 'approve' && decision !== 'reject') return failure(400, "decision must be 'approve' or 'reject'.")
  const canonical = canonicalSignature(signature)
  if (!canonical) return failure(400, 'signature must be a 65-byte signature from the reviewer wallet.')
  const now = Math.floor(Date.now() / 1000)

  if (decision === 'reject') {
    if (!isCount(issuedAt)) return failure(400, 'issuedAt must be a unix time in whole seconds.')
    if (!issuedAtInWindow(issuedAt, now)) {
      return failure(400, 'The review time is more than 5 minutes from the server clock. Check the clock on your device and try again.')
    }
    if (!(await signedBy(attester, reviewRejectText(id, issuedAt), canonical))) {
      return failure(403, 'The signature is not the reviewer wallet’s signature for this decision.')
    }
    const rejected = await db
      .prepare(`UPDATE callouts SET status = 'rejected', reviewed_at = ?, reviewer = ? WHERE id = ? AND chain = ? RETURNING id`)
      .bind(now, attester, id, CALLOUT_CHAIN)
      .all<Row>()
    if (rejected.results.length === 0) return failure(404, 'There is no callout with this id.')
    return json({ callout: { id, status: 'rejected' } })
  }

  if (!isCount(epoch) || !isCount(deadline)) return failure(400, 'epoch and deadline must be whole numbers.')
  const outside = approvalWindowError(epoch, deadline, now)
  if (outside) return failure(400, outside)

  const row = await db.prepare(`SELECT ${COLUMNS} FROM callouts WHERE id = ? AND chain = ?`).bind(id, CALLOUT_CHAIN).first<Row>()
  if (!row) return failure(404, 'There is no callout with this id.')
  if (row.status === 'rejected') return failure(409, 'This callout was rejected and cannot be approved.')
  // The attestation carries the market cap at the call. A callout that has none cannot be attested.
  const mcap = row.call_mcap
  if (!isCount(mcap) || mcap === 0) {
    return failure(409, 'This callout was posted before market caps were recorded. Ask the author to post it again.')
  }

  // It also carries what the wallet held at the call: the vault never counts more than that.
  const held = typeof row.call_balance === 'string' && /^[1-9]\d{0,77}$/.test(row.call_balance) ? row.call_balance : null
  if (held === null) {
    return failure(409, 'This callout has no recorded holdings. Ask the author to post it again.')
  }

  const submission: Submission = {
    holder: String(row.author),
    token: String(row.token),
    epoch,
    kind: Number(row.kind),
    linkHash: String(row.link_hash) as Hex,
    profileHash: profileHashOf(String(row.profile ?? '')),
    mcap,
    held,
    nonce: id,
    deadline,
  }
  if (!(await verifyAttestation(attester, vault, submission, canonical))) {
    return failure(403, 'The signature is not the reviewer wallet’s attestation for this callout, round and deadline.')
  }

  // Approving again overwrites: that is how an approval whose round has passed is renewed. A new attestation
  // has not been to the vault yet, whatever became of the last one.
  const approved = await db
    .prepare(
      `UPDATE callouts SET status = 'approved', reviewed_at = ?, reviewer = ?, epoch = ?, deadline = ?, attestation = ?, record_tx = NULL
WHERE id = ? AND chain = ? AND status IN ('pending', 'approved')
RETURNING ${COLUMNS}`,
    )
    .bind(now, attester, epoch, deadline, canonical, id, CALLOUT_CHAIN)
    .first<Row>()
  if (!approved) return failure(409, 'This callout was rejected and cannot be approved.')

  // The approval stands from here on. Bringing it to the vault is tried once now, for the round in progress;
  // if that fails the cron tries again, and the author can still record it from the page.
  const relayer = relayerOf(env)
  let recordError: string | undefined
  if (relayer && epoch === currentEpoch(now)) {
    try {
      const hash = await relaySubmission(relayer, env, submission, String(approved.url), canonical, fetcher)
      await db.prepare(`UPDATE callouts SET record_tx = ? WHERE id = ? AND attestation = ? AND record_tx IS NULL`).bind(hash, id, canonical).run()
      approved.record_tx = hash
    } catch (error) {
      recordError = relayFailure(error, relayer)
    }
  }
  return json({ callout: { ...toCallout(approved), token: approved.token, ...(recordError === undefined ? {} : { recordError }) } })
}

// ── The share card ───────────────────────────────────────────────────────

/**
 * Where the picture a site shares for a callout is kept: pump.fun's card of the callout, fomo.family's card
 * of the trade. Null for a post on X, which has none, and for a stored link that does not come back from
 * `parseCalloutLink` exactly as it is. The address is built from that canonical link alone, so its host is
 * always one of the two written here and its path holds nothing but an address and an id in hex.
 */
export function shareCardUrl(kind: number, url: string, token: string): string | null {
  const link = parseCalloutLink(url, token)
  if (!link.ok || link.url !== url || link.kind !== kind) return null
  if (link.kind === KIND_PUMP) return `${link.url}/opengraph-image`
  if (link.kind === KIND_FOMO) return `https://image-renderer.fomo.cloud/og/thesis/${link.url.slice(link.url.lastIndexOf('&tradeId=') + '&tradeId='.length)}/card.png`
  return null
}

const badGateway = () => new Response(null, { status: 502, headers: { 'cache-control': 'no-store' } })

/**
 * `GET /api/callouts/bsc/card/<id>`: that callout's share card, from this site's own origin, so the page's
 * content policy stays `img-src 'self'` and no visitor's browser talks to pump.fun or fomo.family. Nothing in
 * the request chooses what is fetched: the id names a stored callout, and the address comes from its link.
 * Only a PNG, JPEG or WebP of at most 2 MB is passed on.
 */
async function shareCard(request: Request, env: CalloutEnv, id: string, ctx: Pick<ExecutionContext, 'waitUntil'> | undefined, fetcher: typeof fetch): Promise<Response> {
  if (!ROW_ID.test(id)) return failure(404, 'Not found.')
  const row = await env.DB
    .prepare(`SELECT kind, url, token FROM callouts WHERE id = ? AND chain = ? AND status IN ('pending', 'approved')`)
    .bind(Number(id), CALLOUT_CHAIN)
    .first<Row>()
  const upstream = row ? shareCardUrl(Number(row.kind), String(row.url), String(row.token)) : null
  if (upstream === null) return failure(404, 'Not found.')

  // The Workers cache, where there is one: outside the Workers runtime every request goes upstream.
  const cache = (globalThis as { caches?: CacheStorage }).caches?.default ?? null
  const cacheKey = new Request(`${new URL(request.url).origin}/api/callouts/${CALLOUT_CHAIN}/card/${id}`)
  const cached = await cache?.match(cacheKey)
  if (cached) return cached

  let answer: Response
  try {
    answer = await fetcher(upstream, {
      headers: { 'user-agent': CARD_USER_AGENT, accept: 'image/png, image/jpeg, image/webp' },
      // A redirect would be an address this file did not write.
      redirect: 'manual',
      signal: AbortSignal.timeout(CARD_TIMEOUT_MS),
    })
  } catch {
    return badGateway()
  }
  const type = (answer.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (answer.status !== 200 || !CARD_TYPES.has(type)) {
    await answer.body?.cancel()
    return badGateway()
  }
  const bytes = await readResponseCapped(answer, CARD_MAX_BYTES).catch(() => null)
  if (!bytes || bytes.byteLength === 0) return badGateway()

  const response = new Response(bytes, {
    headers: {
      'content-type': type,
      'content-length': String(bytes.byteLength),
      'cache-control': 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cross-origin-resource-policy': 'same-origin',
    },
  })
  if (cache) ctx?.waitUntil(cache.put(cacheKey, response.clone()))
  return response
}

// ── An author's tokens ────────────────────────────────────────────────────

/**
 * `GET /api/callouts/bsc/author/<address>`: the tokens that wallet has an approved callout on from this round
 * or the last, the token of its newest callout first. These are the tokens it may have rewards waiting on.
 */
async function authorTokens(db: D1Database, author: string, now: number): Promise<Response> {
  const rows = await db
    .prepare(
      `SELECT token FROM callouts WHERE chain = ? AND author = ? AND status = 'approved' AND epoch >= ?
GROUP BY token ORDER BY MAX(id) DESC LIMIT ?`,
    )
    .bind(CALLOUT_CHAIN, author, currentEpoch(now) - 1, AUTHOR_TOKENS)
    .all<Row>()
  return json({ tokens: rows.results.map((row) => row.token) })
}

// ── Bringing approvals to the vault ───────────────────────────────────────

/** The two functions of the vault the Worker calls, and the reasons the vault gives for refusing a submission. */
const vaultAbi = parseAbi([
  'struct Submission { address holder; address token; uint256 epoch; uint8 kind; bytes32 linkHash; bytes32 profileHash; uint256 mcap; uint256 held; uint256 nonce; uint256 deadline; }',
  'function submitAttested(Submission s, string link, bytes signature)',
  'function usedLink(bytes32 linkHash) view returns (bool)',
  'error WrongEpoch()',
  'error Expired()',
  'error InvalidKind()',
  'error ZeroMarketCap()',
  'error LinkTooLong()',
  'error LinkMismatch()',
  'error LinkUsed()',
  'error BadSignature()',
  'error TooManyLinks()',
  'error BelowMinHold()',
])

/** Why the vault refuses a submission, in words for the reviewer. */
const REFUSALS: Record<string, string> = {
  WrongEpoch: 'The approval is for a round that is not the running one.',
  Expired: 'The approval has passed its deadline.',
  LinkUsed: 'This link has already been counted.',
  LinkMismatch: 'The link is not the one that was approved.',
  BadSignature: 'The vault does not take this wallet\u2019s approvals: its reviewer is another wallet.',
  TooManyLinks: 'This holder has already counted the most callouts one holder can in a round.',
  BelowMinHold: 'This wallet holds less than the minimum of the token, so the callout cannot be counted yet.',
  ZeroMarketCap: 'The callout has no market cap recorded.',
}

interface Relayer {
  /** The gas wallet's key. It goes to the signer and nowhere else. */
  key: Hex
  vault: Address
}

/** The gas wallet and the vault it sends to, when both are configured. */
function relayerOf(env: CalloutEnv): Relayer | null {
  const key = env.RELAYER_PRIVATE_KEY?.trim()
  const vault = env.CALLZ_VAULT
  return key && vault && PRIVATE_KEY.test(key) && ADDRESS.test(vault) ? { key: key as Hex, vault: vault.toLowerCase() as Address } : null
}

/** True when the Worker brings approved callouts to the vault itself, so authors need not. */
export const autoRecordOn = (env: CalloutEnv): boolean => relayerOf(env) !== null

const chainTransport = (env: CalloutEnv, fetcher: typeof fetch) =>
  http(env.BSC_RPC_URL ?? CHAINS.bsc.rpcUrls[0], { fetchFn: (input, init) => fetcher(input, init), timeout: 10_000, retryCount: 1 })

/**
 * Sends `submitAttested` to the vault from the gas wallet and returns the transaction's hash. The vault takes
 * a submission from anyone and credits the holder named in it, so who pays the gas changes nothing about who
 * is rewarded. The call is simulated first: one the vault would refuse is never sent, and costs nothing.
 * Gas is the estimate, half as much again, and a fixed margin; what is not used is not paid for.
 */
async function relaySubmission(relayer: Relayer, env: CalloutEnv, submission: Submission, link: string, attestation: Hex, fetcher: typeof fetch): Promise<Hex> {
  // The nonce manager counts what this isolate has sent, so two sends in one run do not reuse a nonce.
  const account = privateKeyToAccount(relayer.key, { nonceManager })
  const transport = chainTransport(env, fetcher)
  const call = {
    account,
    address: relayer.vault,
    abi: vaultAbi,
    functionName: 'submitAttested',
    args: [
      {
        holder: submission.holder.toLowerCase() as Address,
        token: submission.token.toLowerCase() as Address,
        epoch: BigInt(submission.epoch),
        kind: submission.kind,
        linkHash: submission.linkHash,
        profileHash: submission.profileHash,
        mcap: BigInt(submission.mcap),
        held: BigInt(submission.held),
        nonce: BigInt(submission.nonce),
        deadline: BigInt(submission.deadline),
      },
      link,
      attestation,
    ],
  } as const
  const reader = createPublicClient({ chain: bsc, transport })
  await reader.simulateContract(call)
  const estimate = await reader.estimateContractGas(call)
  return createWalletClient({ account, chain: bsc, transport }).writeContract({ ...call, gas: (estimate * 3n) / 2n + 60_000n })
}

/**
 * Why a relay failed, as one short sentence, and a line in the log. The sentence is one of the fixed ones
 * here, never the error's own text; the log line has the key cut out of it should it ever appear there.
 */
function relayFailure(error: unknown, relayer: Relayer): string {
  const reverted = error instanceof BaseError ? error.walk((cause) => cause instanceof ContractFunctionRevertedError) : null
  const name = reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName : undefined
  const logged = String(error instanceof BaseError ? error.shortMessage : error).split(relayer.key).join('[key]').split(relayer.key.slice(2)).join('[key]')
  console.error(JSON.stringify({ calloutRelayFailed: name ?? logged.slice(0, 300) }))
  if (name) return REFUSALS[name] ?? 'The vault refused the callout.'
  return 'The transaction could not be sent. It is tried again automatically.'
}

export interface RelayResult {
  /** Callouts sent to the vault this run. */
  sent: number
  /** Callouts the vault had already counted, sent by someone else. */
  already: number
  /** Callouts that could not be sent: they are tried again on a later run. */
  failed: number
}

/**
 * Brings approved callouts of the running round to the vault: the ones the approval itself could not, and the
 * ones approved while no gas wallet was configured. A link the vault has already counted is marked as such.
 * A few are taken at random each run, so one the vault keeps refusing cannot hold up the others.
 */
export async function relayApproved(env: CalloutEnv, fetcher: typeof fetch = fetch): Promise<RelayResult> {
  const result: RelayResult = { sent: 0, already: 0, failed: 0 }
  const relayer = relayerOf(env)
  if (!relayer) return result
  const db = env.DB
  const now = Math.floor(Date.now() / 1000)
  const waiting = await db
    .prepare(
      `SELECT ${COLUMNS} FROM callouts
WHERE chain = ? AND status = 'approved' AND epoch = ? AND record_tx IS NULL AND attestation IS NOT NULL AND deadline > ? AND reviewed_at <= ?
ORDER BY RANDOM() LIMIT ?`,
    )
    .bind(CALLOUT_CHAIN, currentEpoch(now), now, now - RELAY_GRACE_SECONDS, RELAYS_PER_RUN)
    .all<Row>()
  if (waiting.results.length === 0) return result

  const reader = createPublicClient({ chain: bsc, transport: chainTransport(env, fetcher) })
  for (const row of waiting.results) {
    const mark = (value: string) =>
      db.prepare(`UPDATE callouts SET record_tx = ? WHERE id = ? AND attestation = ? AND record_tx IS NULL`).bind(value, row.id, row.attestation).run()
    try {
      const linkHash = String(row.link_hash) as Hex
      if (await reader.readContract({ address: relayer.vault, abi: vaultAbi, functionName: 'usedLink', args: [linkHash] })) {
        await mark('recorded')
        result.already++
        continue
      }
      const submission: Submission = {
        holder: String(row.author),
        token: String(row.token),
        epoch: Number(row.epoch),
        kind: Number(row.kind),
        linkHash,
        profileHash: profileHashOf(String(row.profile ?? '')),
        mcap: Number(row.call_mcap),
        held: String(row.call_balance),
        nonce: Number(row.id),
        deadline: Number(row.deadline),
      }
      await mark(await relaySubmission(relayer, env, submission, String(row.url), String(row.attestation) as Hex, fetcher))
      result.sent++
    } catch (error) {
      relayFailure(error, relayer)
      result.failed++
    }
  }
  return result
}

// ── Positions ────────────────────────────────────────────────────────────

export interface PositionsResult {
  /** Open positions whose balance was read this run. */
  checked: number
  /** Positions whose balance the token did not answer for. */
  unread: number
  /** Positions found closed and stored as such. */
  closed: number
  /** Positions found closed whose market cap could not be read: left open, and read again on a later run. */
  waiting: number
}

/**
 * Re-reads what the authors of open callouts hold, the one checked longest ago first, in one request to the
 * chain. A position whose balance has fallen below a tenth of the balance at the call is closed, with the
 * token's market cap at that moment; a closed position stays closed. Where that market cap cannot be read
 * the position is left open and comes round again, rather than being closed with a figure nobody read.
 */
export async function refreshPositions(env: CalloutEnv, fetcher: typeof fetch = fetch): Promise<PositionsResult> {
  const db = env.DB
  const open = await db
    .prepare(
      `SELECT id, token, author, call_balance FROM callouts
WHERE position = 'open' AND status != 'rejected' AND chain = ? AND call_balance IS NOT NULL
ORDER BY checked_at, id LIMIT ?`,
    )
    .bind(CALLOUT_CHAIN, POSITIONS_PER_RUN)
    .all<Row>()
  const rows = open.results
  const result: PositionsResult = { checked: 0, unread: 0, closed: 0, waiting: 0 }
  if (rows.length === 0) return result

  const balances = await balancesOf(bscRpc(env, fetcher), rows.map((row) => ({ token: String(row.token), holder: String(row.author) })))
  const now = Math.floor(Date.now() / 1000)

  const readings = rows.map((row, index) => {
    const held = balances[index] ?? null
    const atCall = typeof row.call_balance === 'string' && /^[0-9]{1,78}$/.test(row.call_balance) ? BigInt(row.call_balance) : null
    return { id: row.id, token: String(row.token), held, closing: held !== null && atCall !== null && positionClosed(atCall, held) }
  })

  // One market cap per token with a closure.
  const closingTokens = [...new Set(readings.filter((reading) => reading.closing).map((reading) => reading.token))].slice(0, CLOSURE_TOKENS_PER_RUN)
  const caps = new Map(await Promise.all(closingTokens.map(async (token) => [token, await marketCapUsd(token, fetcher, bscRpc(env, fetcher))] as const)))

  const statements = readings.map(({ id, token, held, closing }) => {
    if (held === null) {
      // Moved to the back of the queue all the same, so a token that never answers cannot hold up the rest.
      result.unread++
      return db.prepare(`UPDATE callouts SET checked_at = ? WHERE id = ? AND position = 'open'`).bind(now, id)
    }
    result.checked++
    const closedMcap = closing ? (caps.get(token) ?? null) : null
    if (closing && closedMcap !== null) {
      result.closed++
      return db
        .prepare(
          `UPDATE callouts SET held_balance = ?, checked_at = ?, position = 'closed', closed_at = ?, closed_mcap = ? WHERE id = ? AND position = 'open'`,
        )
        .bind(held.toString(), now, now, closedMcap, id)
    }
    if (closing) result.waiting++
    return db.prepare(`UPDATE callouts SET held_balance = ?, checked_at = ? WHERE id = ? AND position = 'open'`).bind(held.toString(), now, id)
  })
  await db.batch(statements)
  return result
}

/**
 * Routes `/api/callouts/bsc/...`. `ctx` lets a share card be put in the cache after it has been answered;
 * `fetcher` is how the chain and the two card hosts are reached.
 */
export async function handleCallouts(
  request: Request,
  env: CalloutEnv,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const reading = request.method === 'GET' || request.method === 'HEAD'
  if (!reading && request.method !== 'POST') return failure(405, 'Method not allowed.', { allow: 'GET, HEAD, POST' })

  const url = new URL(request.url)
  const [, api, callouts, chain, target, extra, more] = url.pathname.split('/')
  // Only a card and an author take one more part after their name.
  const nested = target === 'card' || target === 'author'
  if (api !== 'api' || callouts !== 'callouts' || chain === undefined || target === undefined || more !== undefined || (extra === undefined) === nested) {
    return failure(404, 'Not found.')
  }
  if (chain !== CALLOUT_CHAIN) return failure(404, 'Unknown network. Callouts are on bsc only.')

  try {
    if (nested) {
      if (!reading) return failure(405, 'Method not allowed.', { allow: 'GET, HEAD' })
      if (target === 'card') return await shareCard(request, env, extra!, ctx, fetcher)
      if (!ADDRESS.test(extra!)) return failure(400, 'The author must be a 0x address.')
      return await authorTokens(env.DB, extra!.toLowerCase(), Math.floor(Date.now() / 1000))
    }
    if (target === 'review') {
      const attester = env.CALLOUT_ATTESTER
      const vault = env.CALLZ_VAULT
      if (!attester || !vault || !ADDRESS.test(attester) || !ADDRESS.test(vault)) {
        return failure(503, 'Callout review is not configured yet.')
      }
      return reading
        ? await reviewQueue(env, attester.toLowerCase(), vault.toLowerCase())
        : await review(request, env, attester.toLowerCase(), vault.toLowerCase(), fetcher)
    }
    if (!ADDRESS.test(target)) return failure(400, 'The token must be a 0x address.')
    const token = target.toLowerCase()
    return reading ? await list(env, token, url) : await post(request, env, token)
  } catch (error) {
    console.error(JSON.stringify({ calloutsFailed: String(error).slice(0, 500) }))
    return failure(500, 'Callouts are unavailable right now. Try again in a moment.')
  }
}
