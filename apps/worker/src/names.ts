/**
 * `/api/names/<wallet>`: the display name a wallet gave itself, shown beside its address wherever the wallet
 * appears as an author (chat, callouts, the wallet menu).
 *
 *   GET   the wallet's name: { wallet, name, updatedAt }. `name` is null for a wallet that has none.
 *   POST  { name, issuedAt, signature } sets the name; with `name: null` it removes it.
 *
 * Nobody logs in. A change is accepted when the wallet signed its exact text (EIP-191 `personal_sign`) within
 * the last few minutes, later than the wallet's last change, and that signature has not been used before. The
 * signature is recovered as a plain ECDSA signature and compared with the wallet, the way chat does it: no
 * contract code is looked at, so a wallet that carries EIP-7702 delegated code signs like any other.
 *
 * A name is 3 to 20 ASCII letters, digits and underscores, and starts with a letter. That alphabet is the
 * whole defence: a name cannot hold a link, markup, a space, an invisible character or a letter from another
 * script made to look like these. Names that look like a wallet address, or that could pass for staff or a
 * partner, are refused. Two names that differ only in case are the same name, and one wallet holds it.
 *
 * Every value reaches the database as a bound parameter of a prepared statement, never as part of the SQL
 * text. The page calls this from its own origin only, so no CORS header is ever sent, and nothing here is
 * cached: a name can change.
 */
import { verifyMessage, type Address, type Hex } from 'viem'
import { ISSUED_AT_WINDOW, canonicalSignature, issuedAtInWindow, readCapped } from './chat.js'

/** The part of the Worker's environment display names use. */
export interface NamesEnv {
  DB: D1Database
}

/** The site a name is for, as the signed text states it. */
export const NAME_SITE = 'callz.fun'
/** BNB Chain mainnet: the chain id the signed text states. */
export const NAME_CHAIN_ID = 56
export const MIN_NAME_LENGTH = 3
export const MAX_NAME_LENGTH = 20
/**
 * A wallet may change its name once in this many seconds. It is longer than `ISSUED_AT_WINDOW`, and has to
 * be: by the time a wallet may change its name again, every request it signed before the last change is too
 * old to be accepted.
 */
export const NAME_CHANGE_SECONDS = 600

const MAX_REQUEST_BYTES = 1024
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const NAME_ALPHABET = /^[A-Za-z0-9_]*$/
const STARTS_WITH_LETTER = /^[A-Za-z]/
/** "0x" and hex digits, at any length, and the same written with a letter O. */
const LOOKS_LIKE_ADDRESS = /^[0oO][xX][0-9a-fA-F]+$/

/**
 * Names nobody can take, because they could pass for the site's staff, a partner, or nobody at all. Matched
 * in lowercase with underscores taken out, so "Admin", "ADMIN_" and "a_d_m_i_n" are all refused.
 * Keep in sync with `RESERVED_NAMES` in apps/web/src/names.ts.
 */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  'callz', 'admin', 'admins', 'administrator', 'mod', 'mods', 'moderator', 'moderators', 'support', 'helpdesk', 'official', 'team', 'staff',
  'system', 'security', 'verified', 'owner', 'founder', 'dev', 'devs', 'developer', 'deployer', 'reviewer', 'treasury', 'vault', 'bot',
  'flap', 'flapsh', 'pancakeswap', 'pancake', 'binance', 'bnbchain', 'bnb', 'cz', 'pumpfun', 'fomofamily', 'dexscreener', 'metamask', 'trustwallet',
  'null', 'undefined', 'nan', 'none', 'nobody', 'unknown', 'anonymous', 'anon', 'everyone',
])
/** A name that starts with the site's own name is the site's, whatever follows. */
const RESERVED_PREFIX = 'callz'

/** True when nobody can take `name`: see `RESERVED_NAMES`. */
export function isReservedName(name: string): boolean {
  const plain = name.toLowerCase().replaceAll('_', '')
  return RESERVED_NAMES.has(plain) || plain.startsWith(RESERVED_PREFIX)
}

/** What uniqueness is decided by: the name in lowercase. */
export const nameKeyOf = (name: string): string => name.toLowerCase()

/**
 * Why `raw` cannot be a display name, or null when it can. The name is taken exactly as typed: nothing is
 * trimmed or cleaned for the visitor, because the wallet signs these very characters.
 * Keep in sync with `displayNameError` in apps/web/src/names.ts: the page says the same before it asks for a signature.
 */
export function displayNameError(raw: unknown): string | null {
  if (typeof raw !== 'string') return 'name must be text, or null to remove the name.'
  if (LOOKS_LIKE_ADDRESS.test(raw)) return 'A name cannot look like a wallet address.'
  if (!NAME_ALPHABET.test(raw)) return 'A name can only have letters, digits and underscores (A-Z, a-z, 0-9, _).'
  if (raw.length < MIN_NAME_LENGTH) return `A name is at least ${MIN_NAME_LENGTH} characters.`
  if (raw.length > MAX_NAME_LENGTH) return `A name is at most ${MAX_NAME_LENGTH} characters.`
  if (!STARTS_WITH_LETTER.test(raw)) return 'A name starts with a letter.'
  if (isReservedName(raw)) return 'That name is reserved. Choose another.'
  return null
}

export interface NameSigningFields {
  /** The wallet the name is for. */
  wallet: string
  /** The name to set, or null to remove the one the wallet has. */
  name: string | null
  /** Unix seconds. */
  issuedAt: number
}

/**
 * The exact text a wallet signs to set or remove its name: the site, what is being done, the name, the
 * wallet, the chain id and the time. Removing a name has a text of its own, so neither is ever the other.
 * Keep in sync with `nameSigningText` in apps/web/src/names.ts: one character of difference and no signature verifies.
 */
export function nameSigningText({ wallet, name, issuedAt }: NameSigningFields): string {
  const action = name === null ? 'Action: Remove display name' : `Action: Set display name\nName: ${name}`
  return `CallZ display name\n\nSite: ${NAME_SITE}\n${action}\nWallet: ${wallet.toLowerCase()}\nChain ID: ${NAME_CHAIN_ID}\nTime: ${issuedAt}`
}

export interface NameChange {
  /** The name to set, exactly as typed; null to remove the wallet's name. */
  name: string | null
  issuedAt: number
  /** Canonical signature. */
  signature: Hex
}

export type ParsedNameChange = { ok: true; change: NameChange } | { ok: false; error: string }

const invalid = (error: string): ParsedNameChange => ({ ok: false, error })

const FIELDS = new Set(['name', 'issuedAt', 'signature'])

/** Checks the shape of a POST body and returns its fields in the form they are verified and stored in. */
export function parseNameChange(input: unknown): ParsedNameChange {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalid('Send a JSON object with name, issuedAt and signature.')
  }
  const fields = input as Record<string, unknown>
  // Exactly these three: a request that carries anything else is not one this API knows.
  if (Object.keys(fields).some((field) => !FIELDS.has(field)) || !Object.hasOwn(fields, 'name')) {
    return invalid('Send a JSON object with name, issuedAt and signature, and nothing else.')
  }
  const { name, issuedAt, signature } = fields
  if (name !== null) {
    const error = displayNameError(name)
    if (error !== null) return invalid(error)
  }
  if (typeof issuedAt !== 'number' || !Number.isSafeInteger(issuedAt) || issuedAt < 0) {
    return invalid('issuedAt must be a unix time in whole seconds.')
  }
  const canonical = canonicalSignature(signature)
  if (!canonical) {
    return invalid('signature must be a 65-byte signature from a plain wallet. Smart contract wallets are not supported.')
  }
  return { ok: true, change: { name: name as string | null, issuedAt, signature: canonical } }
}

/** True when `signature` is `wallet`'s signature over the text for this change. */
export async function verifyNameSignature(change: NameSigningFields & { signature: Hex }): Promise<boolean> {
  try {
    // The plain ECDSA check, as in chat: the signer is recovered from the signature and compared with the
    // wallet. Nothing is read from the chain, so code the wallet delegates to (EIP-7702) plays no part.
    return await verifyMessage({
      address: change.wallet.toLowerCase() as Address,
      message: nameSigningText(change),
      signature: change.signature,
    })
  } catch {
    // Bytes that are not a signature at all recover no address.
    return false
  }
}

/** What the database already holds that bears on a change. */
export interface NameStatus {
  /** This very signature made the wallet's (or any wallet's) last change. */
  replayed: boolean
  /** Another wallet holds the name, in any capitals. */
  taken: boolean
  /** When the wallet last set or removed its name, by the server's clock. Null for a wallet that never has. */
  updatedAt: number | null
  /** The wallet has a name now. */
  hasName: boolean
}

export interface NameRefusal {
  status: number
  error: string
  /** Seconds until the same request could succeed. */
  retryAfter?: number
}

/**
 * Why a correctly signed change is turned away, or null when it is not. The statement that stores a change
 * enforces every one of these itself; this puts the reason into words.
 */
export function nameChangeRefusal(status: NameStatus, change: Pick<NameChange, 'name' | 'issuedAt'>, now: number): NameRefusal | null {
  if (status.replayed) return { status: 409, error: 'This request was already used. Sign a new one.' }
  if (status.updatedAt !== null) {
    const wait = status.updatedAt + NAME_CHANGE_SECONDS - now
    if (wait > 0) {
      const minutes = Math.ceil(wait / 60)
      return {
        status: 429,
        error: `A display name can be changed once every ${NAME_CHANGE_SECONDS / 60} minutes. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`,
        retryAfter: wait,
      }
    }
    // Signed before the wallet's last change, or at that very second: an old request, whoever sends it.
    if (change.issuedAt <= status.updatedAt) {
      return { status: 409, error: 'This request was signed before your last name change. Sign a new one.' }
    }
  }
  if (change.name === null) return status.hasName ? null : { status: 409, error: 'This wallet has no display name to remove.' }
  if (status.taken) return { status: 409, error: 'That name is taken by another wallet. Choose another.' }
  return null
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // A name can change at any moment: no cache, anywhere, keeps one.
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  })
}

const failure = (status: number, message: string, headers?: Record<string, string>) => json({ error: message }, status, headers)

type Row = Record<string, string | number | null>

async function read(db: D1Database, wallet: string): Promise<Response> {
  const row = await db.prepare('SELECT name, updated_at FROM wallet_names WHERE wallet = ?').bind(wallet).first<Row>()
  return json({
    wallet,
    name: typeof row?.name === 'string' ? row.name : null,
    updatedAt: typeof row?.updated_at === 'number' ? row.updated_at : null,
  })
}

async function change(request: Request, db: D1Database, wallet: string): Promise<Response> {
  const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (type !== 'application/json') return failure(400, 'Send the request as application/json.')
  const bytes = await readCapped(request, MAX_REQUEST_BYTES)
  if (!bytes) return failure(413, 'The request is larger than 1 KB.')
  let input: unknown
  try {
    input = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes))
  } catch {
    return failure(400, 'The request body is not valid JSON.')
  }

  const parsed = parseNameChange(input)
  if (!parsed.ok) return failure(400, parsed.error)
  const { name, issuedAt, signature } = parsed.change
  const now = Math.floor(Date.now() / 1000)
  if (!issuedAtInWindow(issuedAt, now)) {
    return failure(400, `The request time is more than ${ISSUED_AT_WINDOW / 60} minutes from the server clock. Check the clock on your device and try again.`)
  }
  if (!(await verifyNameSignature({ wallet, name, issuedAt, signature }))) {
    return failure(403, 'The signature does not match this wallet and name.')
  }
  const key = name === null ? null : nameKeyOf(name)

  // One transaction. The second statement stores the change only where every rule holds, so two requests
  // racing each other cannot both get past them; the first reads why a change was turned away.
  let results: D1Result<Row>[]
  try {
    results = await db.batch<Row>([
      db
        .prepare(
          `SELECT
  EXISTS (SELECT 1 FROM wallet_names WHERE signature = ?1) AS replayed,
  EXISTS (SELECT 1 FROM wallet_names WHERE name_key = ?2 AND wallet != ?3) AS taken,
  (SELECT updated_at FROM wallet_names WHERE wallet = ?3) AS updated_at,
  EXISTS (SELECT 1 FROM wallet_names WHERE wallet = ?3 AND name IS NOT NULL) AS has_name`,
        )
        .bind(signature, key, wallet),
      db
        .prepare(
          `INSERT INTO wallet_names (wallet, name, name_key, updated_at, signature)
SELECT ?1, ?2, ?3, ?4, ?5
WHERE NOT EXISTS (SELECT 1 FROM wallet_names WHERE signature = ?5)
  AND NOT EXISTS (SELECT 1 FROM wallet_names WHERE name_key = ?3 AND wallet != ?1)
  AND NOT EXISTS (SELECT 1 FROM wallet_names WHERE wallet = ?1 AND (updated_at > ?6 OR updated_at >= ?7))
  AND (?2 IS NOT NULL OR EXISTS (SELECT 1 FROM wallet_names WHERE wallet = ?1 AND name IS NOT NULL))
ON CONFLICT (wallet) DO UPDATE SET name = excluded.name, name_key = excluded.name_key, updated_at = excluded.updated_at, signature = excluded.signature
RETURNING updated_at`,
        )
        .bind(wallet, name, key, now, signature, now - NAME_CHANGE_SECONDS, issuedAt),
    ])
  } catch (error) {
    // The table's own UNIQUE constraints are the last word, should a change ever get past the conditions above.
    const text = String(error)
    if (text.includes('wallet_names.name_key')) return failure(409, 'That name is taken by another wallet. Choose another.')
    if (text.includes('wallet_names.signature')) return failure(409, 'This request was already used. Sign a new one.')
    throw error
  }

  const [status, stored] = results
  if (typeof stored?.results[0]?.updated_at === 'number') return json({ wallet, name, updatedAt: now })

  const before = status?.results[0]
  const refusal = nameChangeRefusal(
    {
      replayed: before?.replayed === 1,
      taken: before?.taken === 1,
      updatedAt: typeof before?.updated_at === 'number' ? before.updated_at : null,
      hasName: before?.has_name === 1,
    },
    { name, issuedAt },
    now,
  )
  if (!refusal) return failure(503, 'The name could not be stored. Try again.')
  return failure(refusal.status, refusal.error, refusal.retryAfter === undefined ? undefined : { 'retry-after': String(refusal.retryAfter) })
}

/** Routes `/api/names/<wallet>`. */
export async function handleNames(request: Request, env: NamesEnv): Promise<Response> {
  const reading = request.method === 'GET' || request.method === 'HEAD'
  if (!reading && request.method !== 'POST') return failure(405, 'Method not allowed.', { allow: 'GET, HEAD, POST' })

  const [, api, names, rawWallet, extra] = new URL(request.url).pathname.split('/')
  if (api !== 'api' || names !== 'names' || rawWallet === undefined || rawWallet === '' || extra !== undefined) return failure(404, 'Not found.')
  if (!ADDRESS.test(rawWallet)) return failure(400, 'The wallet must be a 0x address.')
  const wallet = rawWallet.toLowerCase()

  try {
    return reading ? await read(env.DB, wallet) : await change(request, env.DB, wallet)
  } catch (error) {
    console.error(JSON.stringify({ namesFailed: String(error).slice(0, 500) }))
    return failure(500, 'Display names are unavailable right now. Try again in a moment.')
  }
}
