/**
 * `/api/session`: signing in with a wallet, once, for the parts of the site that are private.
 *
 *   POST   /api/session  { wallet, issuedAt, signature }   → { token, wallet, expiresAt }
 *   GET    /api/session                                    → { wallet, expiresAt }, or 401 without a live session
 *   DELETE /api/session                                    signs out: the token stops working
 *
 * The wallet signs one plain text (EIP-191 `personal_sign`) saying it is signing in to this site at this time.
 * The Worker answers with a random token and keeps only the token's SHA-256, so the database never holds
 * anything that signs a request in. The page sends the token as `Authorization: Bearer <token>`; it is never a
 * cookie, so no other site can make a browser send it.
 *
 * A session proves who is asking and nothing more. It cannot move funds or approve anything: every on-chain
 * action is still a transaction the wallet confirms itself.
 */
import { verifyMessage, type Address, type Hex } from 'viem'
import { canonicalSignature, issuedAtInWindow, readCapped } from './chat.js'

export interface SessionEnv {
  DB: D1Database
}

/** How long a session lasts. */
export const SESSION_SECONDS = 7 * 86_400
/** Live sessions one wallet can have: its devices. The oldest is dropped past that. */
const MAX_SESSIONS = 10
const MAX_REQUEST_BYTES = 1024

export const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const TOKEN = /^[0-9a-f]{64}$/

export type Row = Record<string, string | number | null>

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
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

export const failure = (status: number, message: string, headers?: Record<string, string>) => json({ error: message }, status, headers)

/**
 * A request's JSON object. A `Response` instead when the request is not JSON, is larger than `maxBytes`, or
 * does not hold an object.
 */
export async function readObject(request: Request, maxBytes: number): Promise<Record<string, unknown> | Response> {
  const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (type !== 'application/json') return failure(400, 'Send the request as application/json.')
  const bytes = await readCapped(request, maxBytes)
  if (!bytes) return failure(413, `The request is larger than ${Math.round(maxBytes / 1024)} KB.`)
  let input: unknown
  try {
    input = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes))
  } catch {
    return failure(400, 'The request body is not valid JSON.')
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return failure(400, 'Send a JSON object.')
  return input as Record<string, unknown>
}

/**
 * The exact text a wallet signs to sign in.
 * Keep in sync with `sessionSigningText` in apps/web/src/session.ts: one character of difference and no signature verifies.
 */
export function sessionSigningText({ wallet, issuedAt }: { wallet: string; issuedAt: number }): string {
  return `CallZ sign-in\n\nWallet: ${wallet.toLowerCase()}\nSite: callz.fun\nTime: ${issuedAt}\n\nSigning this proves the wallet is yours. It sends no transaction and costs nothing.`
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

/** SHA-256 of `bytes`, as lowercase hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
}

const tokenHash = (token: string): Promise<string> => sha256Hex(new TextEncoder().encode(token))

/** The session token a request carries, in the one form a token has. Null for anything else. */
function bearer(request: Request): string | null {
  const header = request.headers.get('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  return TOKEN.test(token) ? token : null
}

/** The wallet a request is signed in as, lowercase. Null without a live session. */
export async function sessionWallet(request: Request, db: D1Database, now: number = Math.floor(Date.now() / 1000)): Promise<string | null> {
  const token = bearer(request)
  if (!token) return null
  const row = await db.prepare('SELECT wallet FROM sessions WHERE token_hash = ? AND expires_at > ?').bind(await tokenHash(token), now).first<Row>()
  return typeof row?.wallet === 'string' ? row.wallet : null
}

/** What a private route answers a request that is not signed in. */
export const signInFirst = (): Response => failure(401, 'Sign in with your wallet first.')

async function open(request: Request, db: D1Database): Promise<Response> {
  const input = await readObject(request, MAX_REQUEST_BYTES)
  if (input instanceof Response) return input
  const { wallet, issuedAt, signature } = input
  if (typeof wallet !== 'string' || !ADDRESS.test(wallet)) return failure(400, 'wallet must be a 0x address.')
  if (typeof issuedAt !== 'number' || !Number.isSafeInteger(issuedAt) || issuedAt < 0) return failure(400, 'issuedAt must be a unix time in whole seconds.')
  const canonical = canonicalSignature(signature)
  if (!canonical) return failure(400, 'signature must be a 65-byte signature from a plain wallet. Smart contract wallets are not supported.')
  const now = Math.floor(Date.now() / 1000)
  if (!issuedAtInWindow(issuedAt, now)) {
    return failure(400, 'The sign-in time is more than 5 minutes from the server clock. Check the clock on your device and try again.')
  }
  const address = wallet.toLowerCase()
  let signed = false
  try {
    signed = await verifyMessage({ address: address as Address, message: sessionSigningText({ wallet: address, issuedAt }), signature: canonical as Hex })
  } catch {
    signed = false
  }
  if (!signed) return failure(403, 'The signature does not match this wallet.')

  const random = new Uint8Array(32)
  crypto.getRandomValues(random)
  const token = hex(random)
  const expiresAt = now + SESSION_SECONDS
  try {
    await db.batch([
      // Sessions that ran out, and this wallet's oldest ones past what it may keep.
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
      db
        .prepare(
          'DELETE FROM sessions WHERE wallet = ?1 AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE wallet = ?1 ORDER BY created_at DESC LIMIT ?2)',
        )
        .bind(address, MAX_SESSIONS - 1),
      db.prepare('INSERT INTO sessions (token_hash, wallet, created_at, expires_at, signature) VALUES (?, ?, ?, ?, ?)').bind(await tokenHash(token), address, now, expiresAt, canonical),
    ])
  } catch (error) {
    if (String(error).includes('sessions.signature')) return failure(409, 'This sign-in was already used. Sign a new one.')
    throw error
  }
  return json({ token, wallet: address, expiresAt }, 201)
}

/** Routes `/api/session`. */
export async function handleSession(request: Request, env: SessionEnv): Promise<Response> {
  if (new URL(request.url).pathname !== '/api/session') return failure(404, 'Not found.')
  try {
    if (request.method === 'POST') return await open(request, env.DB)
    const now = Math.floor(Date.now() / 1000)
    if (request.method === 'GET' || request.method === 'HEAD') {
      const token = bearer(request)
      const row = token ? await env.DB.prepare('SELECT wallet, expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?').bind(await tokenHash(token), now).first<Row>() : null
      return row ? json({ wallet: row.wallet, expiresAt: row.expires_at }) : signInFirst()
    }
    if (request.method === 'DELETE') {
      const token = bearer(request)
      if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await tokenHash(token)).run()
      return json({ signedOut: true })
    }
    return failure(405, 'Method not allowed.', { allow: 'GET, HEAD, POST, DELETE' })
  } catch (error) {
    console.error(JSON.stringify({ sessionFailed: String(error).slice(0, 500) }))
    return failure(500, 'Signing in is unavailable right now. Try again in a moment.')
  }
}
