/**
 * `/api/leaderboard/...` and `/api/profile/...`: who has earned what. Everything here is read-only and public.
 *
 *   GET /api/leaderboard/social      wallets by the points room devs have given them, most first.
 *   GET /api/leaderboard/calls       wallets by their approved callouts, most first, with their best call and
 *                                    how many of the tokens they called they still hold.
 *   GET /api/profile/<wallet>        one wallet: name, clan, points room by room, project tags, rooms, calls.
 *
 * Points come from `room_points`: a room's dev gives them to members of that room, 100 at most per member per
 * room, so a wallet's total says how many projects it worked on and how well. Calls come from `callouts`: only
 * approved ones count. A call's gain is the market cap it closed at over the market cap at the call, and is
 * only known once the caller's position has closed.
 */
import { ADDRESS, failure, json, type Row } from './session.js'

export interface SocialEnv {
  DB: D1Database
}

const BOARD_SIZE = 100
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)

async function socialBoard(db: D1Database): Promise<Response> {
  const rows = await db
    .prepare(
      `SELECT p.wallet, SUM(p.points) AS points, COUNT(DISTINCT p.room) AS rooms, n.name, c.tag AS clan
FROM room_points p LEFT JOIN wallet_names n ON n.wallet = p.wallet LEFT JOIN clan_members cm ON cm.wallet = p.wallet LEFT JOIN clans c ON c.id = cm.clan_id
GROUP BY p.wallet ORDER BY points DESC, rooms DESC, p.wallet LIMIT ?`,
    )
    .bind(BOARD_SIZE)
    .all<Row>()
  return json({ board: rows.results.map((row, index) => ({ rank: index + 1, wallet: row.wallet, name: text(row.name), clan: text(row.clan), points: row.points, rooms: row.rooms })) })
}

async function callsBoard(db: D1Database): Promise<Response> {
  const rows = await db
    .prepare(
      `SELECT k.author AS wallet, COUNT(*) AS calls, COUNT(DISTINCT k.token) AS tokens,
  MAX(CASE WHEN k.position = 'closed' AND k.call_mcap > 0 AND k.closed_mcap IS NOT NULL THEN CAST(k.closed_mcap AS REAL) / k.call_mcap END) AS best,
  COUNT(DISTINCT CASE WHEN k.position = 'open' THEN k.token END) AS holding,
  n.name, c.tag AS clan
FROM callouts k LEFT JOIN wallet_names n ON n.wallet = k.author LEFT JOIN clan_members cm ON cm.wallet = k.author LEFT JOIN clans c ON c.id = cm.clan_id
WHERE k.chain = 'bsc' AND k.status = 'approved'
GROUP BY k.author ORDER BY calls DESC, best DESC, k.author LIMIT ?`,
    )
    .bind(BOARD_SIZE)
    .all<Row>()
  return json({
    board: rows.results.map((row, index) => ({
      rank: index + 1,
      wallet: row.wallet,
      name: text(row.name),
      clan: text(row.clan),
      calls: row.calls,
      tokens: row.tokens,
      holding: row.holding,
      // Market cap at close over market cap at the call, for the best closed call. Null while none has closed.
      best: typeof row.best === 'number' ? row.best : null,
    })),
  })
}

async function profile(db: D1Database, wallet: string): Promise<Response> {
  const [identity, points, tags, rooms, calls] = await db.batch<Row>([
    db
      .prepare(
        `SELECT (SELECT name FROM wallet_names WHERE wallet = ?1) AS name,
  (SELECT c.tag FROM clan_members m JOIN clans c ON c.id = m.clan_id WHERE m.wallet = ?1) AS clan,
  (SELECT c.name FROM clan_members m JOIN clans c ON c.id = m.clan_id WHERE m.wallet = ?1) AS clan_name`,
      )
      .bind(wallet),
    db
      .prepare(
        `SELECT p.room, r.name, r.symbol, SUM(p.points) AS points FROM room_points p JOIN rooms r ON r.address = p.room
WHERE p.wallet = ? GROUP BY p.room ORDER BY points DESC`,
      )
      .bind(wallet),
    db.prepare('SELECT t.room, t.label, r.name, r.symbol FROM room_tags t JOIN rooms r ON r.address = t.room WHERE t.wallet = ? ORDER BY t.created_at DESC').bind(wallet),
    db
      .prepare(
        `SELECT r.address, r.name, r.symbol, r.launched, 1 AS dev FROM rooms r WHERE r.creator = ?1
UNION ALL
SELECT r.address, r.name, r.symbol, r.launched, 0 AS dev FROM room_members m JOIN rooms r ON r.address = m.room WHERE m.wallet = ?1 AND r.creator != ?1
ORDER BY dev DESC, name, address`,
      )
      .bind(wallet),
    db.prepare("SELECT COUNT(*) AS calls, COUNT(DISTINCT token) AS tokens FROM callouts WHERE chain = 'bsc' AND status = 'approved' AND author = ?").bind(wallet),
  ])
  const who = identity?.results[0]
  const awards = points?.results ?? []
  return json({
    wallet,
    name: text(who?.name),
    clan: text(who?.clan) ? { tag: who!.clan, name: who!.clan_name } : null,
    points: awards.reduce((sum, row) => sum + Number(row.points ?? 0), 0),
    byRoom: awards.map((row) => ({ room: row.room, name: row.name, symbol: row.symbol, points: row.points })),
    tags: (tags?.results ?? []).map((row) => ({ room: row.room, name: row.name, symbol: row.symbol, label: row.label })),
    rooms: (rooms?.results ?? []).map((row) => ({ room: row.address, name: row.name, symbol: row.symbol, launched: row.launched === 1, dev: row.dev === 1 })),
    calls: Number(calls?.results[0]?.calls ?? 0),
    tokensCalled: Number(calls?.results[0]?.tokens ?? 0),
  })
}

/** Routes `/api/leaderboard/<board>` and `/api/profile/<wallet>`. */
export async function handleSocial(request: Request, env: SocialEnv): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return failure(405, 'Method not allowed.', { allow: 'GET, HEAD' })
  const [, api, section, target, extra] = new URL(request.url).pathname.split('/')
  if (api !== 'api' || target === undefined || extra !== undefined) return failure(404, 'Not found.')
  try {
    if (section === 'leaderboard' && target === 'social') return await socialBoard(env.DB)
    if (section === 'leaderboard' && target === 'calls') return await callsBoard(env.DB)
    if (section === 'profile') return ADDRESS.test(target) ? await profile(env.DB, target.toLowerCase()) : failure(400, 'The wallet must be a 0x address.')
    return failure(404, 'Not found.')
  } catch (error) {
    console.error(JSON.stringify({ socialFailed: String(error).slice(0, 500) }))
    return failure(500, 'This is unavailable right now. Try again in a moment.')
  }
}
