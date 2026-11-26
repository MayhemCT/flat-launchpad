/**
 * `/api/callouts/bsc/...`: links to social posts that call a token out, and their review.
 *
 *   GET  /api/callouts/bsc/<token>?limit=<n>                         a token's callouts, newest first.
 *   POST /api/callouts/bsc/<token>  { author, url, note, issuedAt, signature }
 *                                                                    stores one callout, signed by its author.
 *   GET  /api/callouts/bsc/review                                    the review queue, with the reviewer and vault addresses.
 *   POST /api/callouts/bsc/review   { id, decision: 'approve', epoch, deadline, signature }
 *                                   { id, decision: 'reject', issuedAt, signature }
 *                                                                    the reviewer wallet's decision on one callout.
 *
 * Nobody logs in, and this Worker holds no key. A callout is accepted when its author's wallet signed its exact
 * text (EIP-191 `personal_sign`). An approval is accepted when it is the reviewer wallet's EIP-712 signature
 * over the very attestation the rewards vault checks: this Worker only stores it, the author's own wallet
 * takes it to the vault.
 *
 * A link is never stored as it was typed. It is taken apart by fixed rules for the three sites that are
 * accepted and rebuilt in one canonical spelling, so the address the page links to is always one this file
 * wrote out itself. Every value reaches the database as a bound parameter of a prepared statement.
 */
import { keccak256, toBytes, verifyMessage, verifyTypedData, type Address, type Hex } from 'viem'
import { canonicalSignature, cleanBody, containsLink, issuedAtInWindow } from './chat.js'

/** The part of the Worker's environment callouts use. */
export interface CalloutEnv {
  DB: D1Database
  /** The reviewer wallet. A public address, not a secret. */
  CALLOUT_ATTESTER?: string
  /** The rewards vault the attestations are for. A public address. */
  CALLZ_VAULT?: string
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

const COLUMNS = 'id, token, author, kind, url, link_hash, profile, note, status, created_at, epoch, deadline, attestation'

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

async function list(db: D1Database, token: string, url: URL): Promise<Response> {
  const requested = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT)
  const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_LIMIT) : DEFAULT_LIMIT
  const rows = await db
    .prepare(`SELECT ${COLUMNS} FROM callouts WHERE chain = ? AND token = ? AND status IN ('pending', 'approved') ORDER BY id DESC LIMIT ?`)
    .bind(CALLOUT_CHAIN, token, limit)
    .all<Row>()
  return json({ callouts: rows.results.map(toCallout) })
}

async function post(request: Request, db: D1Database, token: string): Promise<Response> {
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
        `INSERT INTO callouts (chain, token, author, kind, url, link_hash, profile, note, signature, created_at)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
WHERE (SELECT COUNT(*) FROM callouts WHERE author = ?3 AND chain = ?1 AND token = ?2 AND created_at >= ?11) < ?12
  AND (SELECT COUNT(*) FROM callouts WHERE author = ?3 AND created_at > ?13) < ?14
  AND NOT EXISTS (SELECT 1 FROM callouts WHERE kind = ?4 AND url LIKE ?15)
ON CONFLICT DO NOTHING
RETURNING id`,
      )
      .bind(
        CALLOUT_CHAIN, token, author, kind, url, linkHash, profile, note, signature, now,
        dayStart, MAX_PER_TOKEN_PER_DAY, now - HOUR_SECONDS, MAX_PER_HOUR, samePost,
      ),
  ])

  const id = inserted?.results[0]?.id
  if (typeof id === 'number') {
    return json(
      {
        callout: {
          id, author, kind, url, note, status: 'pending', createdAt: now, linkHash, profileHash: profileHashOf(profile),
          epoch: null, deadline: null, attestation: null,
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

async function reviewQueue(db: D1Database, attester: string, vault: string): Promise<Response> {
  const rows = await db
    .prepare(`SELECT ${COLUMNS} FROM callouts WHERE chain = ? AND status IN ('pending', 'approved') ORDER BY id DESC LIMIT ?`)
    .bind(CALLOUT_CHAIN, REVIEW_LIMIT)
    .all<Row>()
  return json({ attester, vault, callouts: rows.results.map((row) => ({ ...toCallout(row), token: row.token })) })
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

async function review(request: Request, db: D1Database, attester: string, vault: string): Promise<Response> {
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

  const submission: Submission = {
    holder: String(row.author),
    token: String(row.token),
    epoch,
    kind: Number(row.kind),
    linkHash: String(row.link_hash) as Hex,
    profileHash: profileHashOf(String(row.profile ?? '')),
    nonce: id,
    deadline,
  }
  if (!(await verifyAttestation(attester, vault, submission, canonical))) {
    return failure(403, 'The signature is not the reviewer wallet’s attestation for this callout, round and deadline.')
  }

  // Approving again overwrites: that is how an approval whose round has passed is renewed.
  const approved = await db
    .prepare(
      `UPDATE callouts SET status = 'approved', reviewed_at = ?, reviewer = ?, epoch = ?, deadline = ?, attestation = ?
WHERE id = ? AND chain = ? AND status IN ('pending', 'approved')
RETURNING ${COLUMNS}`,
    )
    .bind(now, attester, epoch, deadline, canonical, id, CALLOUT_CHAIN)
    .first<Row>()
  if (!approved) return failure(409, 'This callout was rejected and cannot be approved.')
  return json({ callout: { ...toCallout(approved), token: approved.token } })
}

/** Routes `/api/callouts/bsc/<token>` and `/api/callouts/bsc/review`. */
export async function handleCallouts(request: Request, env: CalloutEnv): Promise<Response> {
  const reading = request.method === 'GET' || request.method === 'HEAD'
  if (!reading && request.method !== 'POST') return failure(405, 'Method not allowed.', { allow: 'GET, HEAD, POST' })

  const url = new URL(request.url)
  const [, api, callouts, chain, target, extra] = url.pathname.split('/')
  if (api !== 'api' || callouts !== 'callouts' || chain === undefined || target === undefined || extra !== undefined) {
    return failure(404, 'Not found.')
  }
  if (chain !== CALLOUT_CHAIN) return failure(404, 'Unknown network. Callouts are on bsc only.')

  try {
    if (target === 'review') {
      const attester = env.CALLOUT_ATTESTER
      const vault = env.CALLZ_VAULT
      if (!attester || !vault || !ADDRESS.test(attester) || !ADDRESS.test(vault)) {
        return failure(503, 'Callout review is not configured yet.')
      }
      return reading
        ? await reviewQueue(env.DB, attester.toLowerCase(), vault.toLowerCase())
        : await review(request, env.DB, attester.toLowerCase(), vault.toLowerCase())
    }
    if (!ADDRESS.test(target)) return failure(400, 'The token must be a 0x address.')
    const token = target.toLowerCase()
    return reading ? await list(env.DB, token, url) : await post(request, env.DB, token)
  } catch (error) {
    console.error(JSON.stringify({ calloutsFailed: String(error).slice(0, 500) }))
    return failure(500, 'Callouts are unavailable right now. Try again in a moment.')
  }
}
