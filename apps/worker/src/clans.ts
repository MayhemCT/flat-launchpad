/**
 * `/api/clans/...`: clans. A wallet is in one clan at most, and its clan's tag is shown in brackets before its
 * name wherever it writes. Any member can invite a wallet; the invited wallet decides whether to join.
 *
 * Anyone:
 *   GET  /api/clans                       every clan, largest first, with its members and their points.
 *   GET  /api/clans/<TAG>                 one clan and its members.
 *
 * Signed in (`Authorization: Bearer <token>`, see apps/worker/src/session.ts):
 *   GET  /api/clans/mine                  the caller's clan, the invites waiting for them, and the invites
 *                                         their clan has out.
 *   POST /api/clans                       { name, tag } found a clan. The founder is its first member.
 *   POST /api/clans/<TAG>/invites         { wallet } invite a wallet. Any member of the clan can.
 *   POST /api/clans/<TAG>/join            take up an invite.
 *   POST /api/clans/<TAG>/decline         turn an invite down.
 *   POST /api/clans/leave                 leave. The clan stays while it has a member; with none it is gone.
 *
 * The clan's leader (its founder, or whoever the place passed to when the founder left):
 *   POST /api/clans/<TAG>/kick            { wallet } remove a member. The tag is gone from that wallet's name
 *                                         everywhere at once: a tag is read from who is in the clan. The wallet
 *                                         can be invited again.
 *
 * Every value reaches the database as a bound parameter. A tag is 2 to 5 capital letters and digits and a name
 * is letters, digits and single spaces, so neither can carry anything but itself onto a page.
 */
import { ADDRESS, failure, json, readObject, sessionWallet, signInFirst, type Row } from './session.js'

export interface ClansEnv {
  DB: D1Database
}

export const MIN_TAG_LENGTH = 2
export const MAX_TAG_LENGTH = 5
export const MIN_CLAN_NAME_LENGTH = 3
export const MAX_CLAN_NAME_LENGTH = 24
/** Members one clan can have. */
export const MAX_CLAN_MEMBERS = 100
/** Invites one clan can have out at a time. */
const MAX_OPEN_INVITES = 50

const TAG = /^[A-Z0-9]{2,5}$/
const CLAN_NAME = /^[A-Za-z0-9]+(?: [A-Za-z0-9]+)*$/
/** Tags that would pass for the site or its staff, and the two words this API's own routes use. */
const RESERVED_TAGS: ReadonlySet<string> = new Set(['CALLZ', 'CALLS', 'ADMIN', 'MOD', 'MODS', 'DEV', 'DEVS', 'TEAM', 'STAFF', 'FLAP', 'BNB', 'CZ', 'MINE', 'LEAVE'])

/** A clan tag in the one form it is stored in, or what is wrong with it. */
export function clanTag(raw: unknown): { tag: string } | string {
  if (typeof raw !== 'string') return 'The tag must be text.'
  const tag = raw.trim().toUpperCase()
  if (!TAG.test(tag)) return `A tag is ${MIN_TAG_LENGTH} to ${MAX_TAG_LENGTH} letters and digits.`
  if (RESERVED_TAGS.has(tag)) return 'That tag is reserved. Choose another.'
  return { tag }
}

/** A clan name as it is stored, or what is wrong with it. */
export function clanName(raw: unknown): { name: string } | string {
  if (typeof raw !== 'string') return 'The name must be text.'
  const name = raw.trim().replace(/ {2,}/g, ' ')
  if (name.length < MIN_CLAN_NAME_LENGTH || name.length > MAX_CLAN_NAME_LENGTH) return `A clan name is ${MIN_CLAN_NAME_LENGTH} to ${MAX_CLAN_NAME_LENGTH} characters.`
  if (!CLAN_NAME.test(name)) return 'A clan name is letters, digits and single spaces.'
  return { name }
}

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)

const CLANS = `SELECT c.id, c.tag, c.name, c.founder, c.created_at,
  (SELECT COUNT(*) FROM clan_members m WHERE m.clan_id = c.id) AS members,
  (SELECT COALESCE(SUM(p.points), 0) FROM room_points p JOIN clan_members m ON m.wallet = p.wallet WHERE m.clan_id = c.id) AS points
FROM clans c`

const toClan = (row: Row) => ({ tag: row.tag, name: row.name, founder: row.founder, createdAt: row.created_at, members: row.members, points: row.points })

async function list(db: D1Database): Promise<Response> {
  const rows = await db.prepare(`${CLANS} ORDER BY members DESC, points DESC, c.created_at LIMIT 200`).all<Row>()
  return json({ clans: rows.results.map(toClan) })
}

const membersOf = (db: D1Database, clanId: number | string) =>
  db
    .prepare(
      `SELECT m.wallet, m.joined_at, n.name, (SELECT COALESCE(SUM(p.points), 0) FROM room_points p WHERE p.wallet = m.wallet) AS points
FROM clan_members m LEFT JOIN wallet_names n ON n.wallet = m.wallet WHERE m.clan_id = ? ORDER BY m.joined_at, m.wallet`,
    )
    .bind(clanId)

const toMember = (row: Row) => ({ wallet: row.wallet, name: text(row.name), joinedAt: row.joined_at, points: row.points })

async function one(db: D1Database, tag: string): Promise<Response> {
  const clan = await db.prepare(`${CLANS} WHERE c.tag = ?`).bind(tag).first<Row>()
  if (!clan) return failure(404, 'There is no such clan.')
  const members = await membersOf(db, Number(clan.id)).all<Row>()
  return json({ clan: toClan(clan), members: members.results.map(toMember) })
}

async function mine(db: D1Database, wallet: string): Promise<Response> {
  const membership = await db.prepare('SELECT clan_id FROM clan_members WHERE wallet = ?').bind(wallet).first<Row>()
  const invites = await db
    .prepare(
      `SELECT c.tag, c.name, i.invited_by, i.created_at, n.name AS invited_by_name
FROM clan_invites i JOIN clans c ON c.id = i.clan_id LEFT JOIN wallet_names n ON n.wallet = i.invited_by WHERE i.wallet = ? ORDER BY i.created_at DESC`,
    )
    .bind(wallet)
    .all<Row>()
  const waiting = invites.results.map((row) => ({ tag: row.tag, name: row.name, invitedBy: row.invited_by, invitedByName: text(row.invited_by_name), createdAt: row.created_at }))
  if (!membership) return json({ wallet, clan: null, members: [], invites: waiting, sent: [] })

  const clanId = Number(membership.clan_id)
  const [clan, members, sent] = await db.batch<Row>([
    db.prepare(`${CLANS} WHERE c.id = ?`).bind(clanId),
    membersOf(db, clanId),
    db.prepare('SELECT i.wallet, i.invited_by, i.created_at, n.name FROM clan_invites i LEFT JOIN wallet_names n ON n.wallet = i.wallet WHERE i.clan_id = ? ORDER BY i.created_at DESC').bind(clanId),
  ])
  const row = clan?.results[0]
  return json({
    wallet,
    clan: row ? toClan(row) : null,
    members: (members?.results ?? []).map(toMember),
    invites: waiting,
    sent: (sent?.results ?? []).map((invite) => ({ wallet: invite.wallet, name: text(invite.name), invitedBy: invite.invited_by, createdAt: invite.created_at })),
  })
}

async function found(request: Request, db: D1Database, wallet: string): Promise<Response> {
  const input = await readObject(request, 1024)
  if (input instanceof Response) return input
  const tag = clanTag(input.tag)
  if (typeof tag === 'string') return failure(400, tag)
  const name = clanName(input.name)
  if (typeof name === 'string') return failure(400, name)
  const now = Math.floor(Date.now() / 1000)
  try {
    // One transaction: the clan only where the founder is in none, then the founder as its first member.
    const [created] = await db.batch<Row>([
      db
        .prepare(
          `INSERT INTO clans (tag, name, name_key, founder, created_at)
SELECT ?1, ?2, ?3, ?4, ?5 WHERE NOT EXISTS (SELECT 1 FROM clan_members WHERE wallet = ?4) RETURNING id`,
        )
        .bind(tag.tag, name.name, name.name.toLowerCase(), wallet, now),
      db.prepare('INSERT INTO clan_members (wallet, clan_id, invited_by, joined_at) SELECT ?1, id, NULL, ?2 FROM clans WHERE tag = ?3 AND founder = ?1 AND created_at = ?2').bind(wallet, now, tag.tag),
      // Invites to other clans are spent once the wallet is in one.
      db.prepare('DELETE FROM clan_invites WHERE wallet = ?1 AND EXISTS (SELECT 1 FROM clan_members WHERE wallet = ?1)').bind(wallet),
    ])
    if (typeof created?.results[0]?.id !== 'number') return failure(409, 'You are in a clan already. Leave it before founding another.')
  } catch (error) {
    const message = String(error)
    if (message.includes('clans.tag')) return failure(409, 'That tag is taken. Choose another.')
    if (message.includes('clans.name_key')) return failure(409, 'That name is taken. Choose another.')
    if (message.includes('clan_members.wallet')) return failure(409, 'You are in a clan already. Leave it before founding another.')
    throw error
  }
  return mine(db, wallet)
}

async function invite(request: Request, db: D1Database, wallet: string, tag: string): Promise<Response> {
  const input = await readObject(request, 1024)
  if (input instanceof Response) return input
  if (typeof input.wallet !== 'string' || !ADDRESS.test(input.wallet)) return failure(400, 'wallet must be a 0x address.')
  const invited = input.wallet.toLowerCase()
  if (invited === wallet) return failure(400, 'You are in this clan already.')
  const clan = await db
    .prepare('SELECT c.id FROM clans c JOIN clan_members m ON m.clan_id = c.id AND m.wallet = ? WHERE c.tag = ?')
    .bind(wallet, tag)
    .first<Row>()
  if (!clan) return failure(403, 'Only a member of the clan can invite to it.')
  const clanId = Number(clan.id)
  const now = Math.floor(Date.now() / 1000)
  const [status, stored] = await db.batch<Row>([
    db
      .prepare(
        `SELECT
  EXISTS (SELECT 1 FROM clan_members WHERE wallet = ?1 AND clan_id = ?2) AS member,
  EXISTS (SELECT 1 FROM clan_invites WHERE wallet = ?1 AND clan_id = ?2) AS invited,
  (SELECT COUNT(*) FROM clan_invites WHERE clan_id = ?2) AS waiting,
  (SELECT COUNT(*) FROM clan_members WHERE clan_id = ?2) AS members`,
      )
      .bind(invited, clanId),
    db
      .prepare(
        `INSERT INTO clan_invites (clan_id, wallet, invited_by, created_at)
SELECT ?1, ?2, ?3, ?4
WHERE NOT EXISTS (SELECT 1 FROM clan_members WHERE wallet = ?2 AND clan_id = ?1)
  AND (SELECT COUNT(*) FROM clan_invites WHERE clan_id = ?1) < ?5
  AND (SELECT COUNT(*) FROM clan_members WHERE clan_id = ?1) < ?6
ON CONFLICT (clan_id, wallet) DO NOTHING RETURNING wallet`,
      )
      .bind(clanId, invited, wallet, now, MAX_OPEN_INVITES, MAX_CLAN_MEMBERS),
  ])
  if (stored?.results[0]?.wallet === invited) return json({ invited }, 201)
  const before = status?.results[0]
  if (before?.member === 1) return failure(409, 'That wallet is in this clan already.')
  if (before?.invited === 1) return failure(409, 'That wallet already has an invite to this clan.')
  if (Number(before?.members ?? 0) >= MAX_CLAN_MEMBERS) return failure(409, `A clan has ${MAX_CLAN_MEMBERS} members at most.`)
  if (Number(before?.waiting ?? 0) >= MAX_OPEN_INVITES) return failure(409, `This clan has ${MAX_OPEN_INVITES} invites waiting, which is the limit.`)
  return failure(503, 'The invite could not be stored. Try again.')
}

async function join(db: D1Database, wallet: string, tag: string): Promise<Response> {
  const now = Math.floor(Date.now() / 1000)
  // One transaction: a member only where the invite exists, the wallet is in no clan and the clan has room.
  const [status, joined] = await db.batch<Row>([
    db
      .prepare(
        `SELECT
  (SELECT id FROM clans WHERE tag = ?2) AS clan_id,
  EXISTS (SELECT 1 FROM clan_invites i JOIN clans c ON c.id = i.clan_id WHERE i.wallet = ?1 AND c.tag = ?2) AS invited,
  EXISTS (SELECT 1 FROM clan_members WHERE wallet = ?1) AS in_clan,
  (SELECT COUNT(*) FROM clan_members m JOIN clans c ON c.id = m.clan_id WHERE c.tag = ?2) AS members`,
      )
      .bind(wallet, tag),
    db
      .prepare(
        `INSERT INTO clan_members (wallet, clan_id, invited_by, joined_at)
SELECT i.wallet, i.clan_id, i.invited_by, ?3 FROM clan_invites i JOIN clans c ON c.id = i.clan_id
WHERE i.wallet = ?1 AND c.tag = ?2
  AND NOT EXISTS (SELECT 1 FROM clan_members WHERE wallet = ?1)
  AND (SELECT COUNT(*) FROM clan_members m WHERE m.clan_id = i.clan_id) < ?4
RETURNING clan_id`,
      )
      .bind(wallet, tag, now, MAX_CLAN_MEMBERS),
    db.prepare('DELETE FROM clan_invites WHERE wallet = ?1 AND EXISTS (SELECT 1 FROM clan_members WHERE wallet = ?1)').bind(wallet),
  ])
  if (typeof joined?.results[0]?.clan_id === 'number') return mine(db, wallet)
  const before = status?.results[0]
  if (before?.clan_id === null || before?.clan_id === undefined) return failure(404, 'There is no such clan.')
  if (before.in_clan === 1) return failure(409, 'You are in a clan already. Leave it before joining another.')
  if (before.invited !== 1) return failure(403, 'You have no invite to this clan. A member has to invite you.')
  if (Number(before.members ?? 0) >= MAX_CLAN_MEMBERS) return failure(409, 'This clan is full.')
  return failure(503, 'Joining did not go through. Try again.')
}

async function decline(db: D1Database, wallet: string, tag: string): Promise<Response> {
  await db.prepare('DELETE FROM clan_invites WHERE wallet = ? AND clan_id = (SELECT id FROM clans WHERE tag = ?)').bind(wallet, tag).run()
  return mine(db, wallet)
}

async function leave(db: D1Database, wallet: string): Promise<Response> {
  const membership = await db.prepare('SELECT clan_id FROM clan_members WHERE wallet = ?').bind(wallet).first<Row>()
  if (!membership) return failure(409, 'You are in no clan.')
  const clanId = Number(membership.clan_id)
  await db.batch([
    db.prepare('DELETE FROM clan_members WHERE wallet = ? AND clan_id = ?').bind(wallet, clanId),
    // The founder's place passes to whoever has been in the clan longest.
    db
      .prepare('UPDATE clans SET founder = (SELECT wallet FROM clan_members WHERE clan_id = ?1 ORDER BY joined_at, wallet LIMIT 1) WHERE id = ?1 AND founder = ?2 AND EXISTS (SELECT 1 FROM clan_members WHERE clan_id = ?1)')
      .bind(clanId, wallet),
    // A clan nobody is in is gone, with the invites it had out.
    db.prepare('DELETE FROM clan_invites WHERE clan_id = ?1 AND NOT EXISTS (SELECT 1 FROM clan_members WHERE clan_id = ?1)').bind(clanId),
    db.prepare('DELETE FROM clans WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM clan_members WHERE clan_id = ?1)').bind(clanId),
  ])
  return mine(db, wallet)
}

/** The leader removes a member. A leader does not remove themself: they leave, and the place passes on. */
async function kick(request: Request, db: D1Database, wallet: string, tag: string): Promise<Response> {
  const input = await readObject(request, 1024)
  if (input instanceof Response) return input
  if (typeof input.wallet !== 'string' || !ADDRESS.test(input.wallet)) return failure(400, 'wallet must be a 0x address.')
  const removed = input.wallet.toLowerCase()
  const clan = await db
    .prepare('SELECT c.id, c.founder, EXISTS (SELECT 1 FROM clan_members m WHERE m.clan_id = c.id AND m.wallet = ?1) AS member FROM clans c WHERE c.tag = ?2')
    .bind(removed, tag)
    .first<Row>()
  if (!clan) return failure(404, 'There is no such clan.')
  if (clan.founder !== wallet) return failure(403, "Only the clan's leader can remove a member.")
  if (removed === wallet) return failure(400, 'You lead this clan and cannot remove yourself. Leave it instead, and it passes to the member who has been in longest.')
  if (clan.member !== 1) return failure(404, 'That wallet is not a member of this clan.')
  const clanId = Number(clan.id)
  // One transaction, and only while the caller still leads the clan and is not the one removed.
  const [gone] = await db.batch<Row>([
    db
      .prepare('DELETE FROM clan_members WHERE wallet = ?1 AND clan_id = ?2 AND wallet != ?3 AND EXISTS (SELECT 1 FROM clans WHERE id = ?2 AND founder = ?3) RETURNING wallet')
      .bind(removed, clanId, wallet),
    // An invite to this clan in that wallet's hands goes with it; a new one is the leader's or a member's to give.
    db
      .prepare('DELETE FROM clan_invites WHERE wallet = ?1 AND clan_id = ?2 AND NOT EXISTS (SELECT 1 FROM clan_members WHERE wallet = ?1 AND clan_id = ?2)')
      .bind(removed, clanId),
  ])
  if (gone?.results[0]?.wallet !== removed) return failure(404, 'That wallet is not a member of this clan.')
  return mine(db, wallet)
}

/** Routes `/api/clans/...`. */
export async function handleClans(request: Request, env: ClansEnv): Promise<Response> {
  const reading = request.method === 'GET' || request.method === 'HEAD'
  const posting = request.method === 'POST'
  if (!reading && !posting) return failure(405, 'Method not allowed.', { allow: 'GET, HEAD, POST' })
  const [, api, clans, first, second, extra] = new URL(request.url).pathname.split('/')
  if (api !== 'api' || clans !== 'clans' || extra !== undefined) return failure(404, 'Not found.')
  const db = env.DB

  try {
    if (first === undefined || first === '') {
      if (reading) return await list(db)
      const wallet = await sessionWallet(request, db)
      return wallet ? await found(request, db, wallet) : signInFirst()
    }
    if (first === 'mine' && second === undefined && reading) {
      const wallet = await sessionWallet(request, db)
      return wallet ? await mine(db, wallet) : signInFirst()
    }
    if (first === 'leave' && second === undefined && posting) {
      const wallet = await sessionWallet(request, db)
      return wallet ? await leave(db, wallet) : signInFirst()
    }
    const tag = first.toUpperCase()
    if (!TAG.test(tag)) return failure(404, 'There is no such clan.')
    if (second === undefined) return reading ? await one(db, tag) : failure(405, 'Method not allowed.', { allow: 'GET, HEAD' })
    if (!posting || (second !== 'invites' && second !== 'join' && second !== 'decline' && second !== 'kick')) return failure(404, 'Not found.')
    const wallet = await sessionWallet(request, db)
    if (!wallet) return signInFirst()
    if (second === 'invites') return await invite(request, db, wallet, tag)
    if (second === 'kick') return await kick(request, db, wallet, tag)
    return second === 'join' ? await join(db, wallet, tag) : await decline(db, wallet, tag)
  } catch (error) {
    console.error(JSON.stringify({ clansFailed: String(error).slice(0, 500) }))
    return failure(500, 'Clans are unavailable right now. Try again in a moment.')
  }
}
