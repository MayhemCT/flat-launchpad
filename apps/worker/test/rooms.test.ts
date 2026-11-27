import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { decodeFunctionData, encodeFunctionResult, parseAbi, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleChat } from '../src/chat.js'
import { clanName, clanTag, handleClans } from '../src/clans.js'
import { ROOM_FACTORY, checkPost, cleanText, handleRooms, parsePostUrl, pictureType, postCode } from '../src/rooms.js'
import { handleSession, sessionSigningText } from '../src/session.js'
import { handleSocial } from '../src/social.js'

const NOW = 1_800_000_000
const ORIGIN = 'https://callz.test'
const ROOM = '0x00000000000000000000000000000000000a11ce'
const GATE = '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82'
const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url).href)

const newAccount = () => privateKeyToAccount(generatePrivateKey())
type Account = ReturnType<typeof newAccount>

/** D1 as the Worker uses it, over a real SQLite database in memory with every migration applied. */
function database() {
  const sqlite = new DatabaseSync(':memory:')
  for (const file of readdirSync(MIGRATIONS).sort()) sqlite.exec(readFileSync(join(MIGRATIONS, file), 'utf8'))
  const rows = (sql: string, values: unknown[]) => sqlite.prepare(sql).all(...(values as never[])).map((row) => ({ ...row }))
  const statement = (sql: string, values: unknown[] = []) => ({
    sql,
    values,
    bind: (...next: unknown[]) => statement(sql, next),
    all: async () => ({ results: rows(sql, values) }),
    first: async () => rows(sql, values)[0] ?? null,
    run: async () => ({ results: rows(sql, values) }),
  })
  const db = {
    prepare: (sql: string) => statement(sql),
    // One transaction, as D1 runs a batch.
    batch: async (batch: Array<{ sql: string; values: unknown[] }>) => {
      sqlite.exec('BEGIN')
      try {
        const results = batch.map(({ sql, values }) => ({ results: rows(sql, values) }))
        sqlite.exec('COMMIT')
        return results
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  } as unknown as D1Database
  return { db, sqlite }
}

const multicallAbi = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
])
const chainAbi = parseAbi([
  'struct CallZRoomInfo { address creator; string tokenName; string tokenSymbol; string image; uint256 seatPrice; uint256 seats; uint256 seated; uint256 minted; uint256 raised; uint256 saleDeadline; uint16 poolShareBps; uint16 launchFeeBps; address gateToken; uint256 gateAmount; uint256 tokensPerSeat; bool launched; address token; address pair; }',
  'struct CallZRoomStanding { bool admitted; bool banned; uint256 seat; bool claimed; uint256 owed; bool meetsGate; }',
  'function isRoom(address room) view returns (bool)',
  'function info() view returns (CallZRoomInfo)',
  'function members(uint256 offset, uint256 limit) view returns (address[] wallets, uint256[] tokenIds)',
  'function standingOf(address wallet) view returns (CallZRoomStanding)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
])

const ZERO: Address = '0x0000000000000000000000000000000000000000'

/**
 * The chain and X as the Worker sees them, for the tests: one room contract whose state the test sets, token
 * balances, and the posts X knows. Requests the Worker makes are decoded and answered as the real ones would be.
 */
function world(creator: string, gate: boolean) {
  const state = {
    members: [] as Array<{ wallet: string; seat: number }>,
    admitted: new Set<string>(),
    banned: new Set<string>(),
    balances: new Map<string, bigint>(),
    launched: false,
    posts: new Map<string, { author: string; text: string }>(),
    xDown: false,
    rpcDown: false,
    rpcCalls: 0,
  }
  const answer = (target: string, data: Hex): Hex | null => {
    const call = decodeFunctionData({ abi: chainAbi, data })
    const at = target.toLowerCase()
    if (at === ROOM_FACTORY && call.functionName === 'isRoom') {
      return encodeFunctionResult({ abi: chainAbi, functionName: 'isRoom', result: (call.args[0] as string).toLowerCase() === ROOM })
    }
    if (at === ROOM && call.functionName === 'info') {
      return encodeFunctionResult({
        abi: chainAbi,
        functionName: 'info',
        result: {
          creator: creator as Address,
          tokenName: 'Night Shift',
          tokenSymbol: 'NIGHT',
          image: `https://callz.fun/api/rooms/image/${'ab'.repeat(32)}`,
          seatPrice: 250_000_000_000_000_000n,
          seats: 4n,
          seated: BigInt(state.members.length),
          minted: BigInt(state.members.length),
          raised: 250_000_000_000_000_000n * BigInt(state.members.length),
          saleDeadline: BigInt(NOW + 86_400),
          poolShareBps: 5000,
          launchFeeBps: 1000,
          gateToken: gate ? (GATE as Address) : ZERO,
          gateAmount: gate ? 1000n * 10n ** 18n : 0n,
          tokensPerSeat: 125_000_000n * 10n ** 18n,
          launched: state.launched,
          token: ZERO,
          pair: ZERO,
        },
      })
    }
    if (at === ROOM && call.functionName === 'members') {
      return encodeFunctionResult({ abi: chainAbi, functionName: 'members', result: [state.members.map((member) => member.wallet as Address), state.members.map((member) => BigInt(member.seat))] })
    }
    if (at === ROOM && call.functionName === 'standingOf') {
      const wallet = (call.args[0] as string).toLowerCase()
      const seat = state.members.find((member) => member.wallet === wallet)?.seat ?? 0
      return encodeFunctionResult({
        abi: chainAbi,
        functionName: 'standingOf',
        result: { admitted: state.admitted.has(wallet), banned: state.banned.has(wallet), seat: BigInt(seat), claimed: false, owed: 0n, meetsGate: true },
      })
    }
    if (at === GATE && call.functionName === 'symbol') return encodeFunctionResult({ abi: chainAbi, functionName: 'symbol', result: 'Cake' })
    if (at === GATE && call.functionName === 'decimals') return encodeFunctionResult({ abi: chainAbi, functionName: 'decimals', result: 18 })
    if (at === GATE && call.functionName === 'balanceOf') {
      return encodeFunctionResult({ abi: chainAbi, functionName: 'balanceOf', result: state.balances.get((call.args[0] as string).toLowerCase()) ?? 0n })
    }
    return null
  }
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('https://publish.x.com/oembed')) {
      if (state.xDown) throw new Error('X is down')
      const post = state.posts.get(new URL(url).searchParams.get('url') ?? '')
      if (!post) return new Response('<html>Nothing to see here</html>', { status: 404 })
      return Response.json({ author_url: `https://x.com/${post.author}`, html: `<blockquote><p>${post.text}</p>&mdash; ${post.author}</blockquote>` })
    }
    if (state.rpcDown) throw new Error('RPC is down')
    state.rpcCalls++
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: [{ to: string; data: Hex }] }
    expect(body.method).toBe('eth_call')
    const { args } = decodeFunctionData({ abi: multicallAbi, data: body.params[0].data })
    const result = encodeFunctionResult({
      abi: multicallAbi,
      functionName: 'aggregate3',
      result: args[0].map(({ target, callData }) => {
        const data = answer(target, callData)
        return { success: data !== null, returnData: data ?? '0x' }
      }),
    })
    return Response.json({ jsonrpc: '2.0', id: body.id, result })
  }) as typeof fetch
  return { state, fetcher }
}

function setup({ gate = false }: { gate?: boolean } = {}) {
  const { db, sqlite } = database()
  const dev = newAccount()
  const { state, fetcher } = world(dev.address.toLowerCase(), gate)
  const env = { DB: db, BSC_RPC_URL: 'https://rpc.test' }
  const tokens = new Map<string, string>()

  /** Signs `account` in, once, and returns its session token. */
  const signIn = async (account: Account): Promise<string> => {
    const known = tokens.get(account.address)
    if (known) return known
    const issuedAt = Math.floor(Date.now() / 1000)
    const signature = await account.signMessage({ message: sessionSigningText({ wallet: account.address, issuedAt }) })
    const response = await handleSession(
      new Request(`${ORIGIN}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: account.address, issuedAt, signature }) }),
      env,
    )
    expect(response.status).toBe(201)
    const { token } = (await response.json()) as { token: string }
    tokens.set(account.address, token)
    // Two sign-ins in one second would carry the same text and so the same signature.
    vi.setSystemTime(Date.now() + 1000)
    return token
  }

  /** One request to the API as `account` (or signed out), answered with its status and JSON. */
  const call = async (path: string, account: Account | null, body?: unknown): Promise<{ status: number; body: any }> => {
    const headers: Record<string, string> = {}
    if (account) headers.authorization = `Bearer ${await signIn(account)}`
    let payload: BodyInit | undefined
    if (body instanceof Uint8Array) {
      payload = body
      headers['content-type'] = 'image/png'
    } else if (body !== undefined) {
      payload = JSON.stringify(body)
      headers['content-type'] = 'application/json'
    }
    const request = new Request(`${ORIGIN}${path}`, { method: body === undefined ? 'GET' : 'POST', headers, ...(payload === undefined ? {} : { body: payload }) })
    const response = path.startsWith('/api/rooms')
      ? await handleRooms(request, env, fetcher)
      : path.startsWith('/api/clans')
        ? await handleClans(request, env)
        : path.startsWith('/api/chat')
          ? await handleChat(request, env, fetcher)
          : await handleSocial(request, env)
    const type = response.headers.get('content-type') ?? ''
    return { status: response.status, body: type.startsWith('application/json') ? await response.json() : new Uint8Array(await response.arrayBuffer()) }
  }

  /** What happens on chain when a wallet buys its pass. */
  const seat = (account: Account) => {
    const wallet = account.address.toLowerCase()
    state.admitted.delete(wallet)
    state.members.push({ wallet, seat: state.members.length + 1 })
  }
  const later = (seconds: number) => vi.setSystemTime(Date.now() + seconds * 1000)
  return { db, sqlite, env, dev, state, fetcher, call, seat, later, signIn }
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 1, 2, 3, 4])
const post = (handle: string, id: string) => `https://x.com/${handle}/status/${id}`

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW * 1000)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the small parts', () => {
  it('reads a link to a post on X in every spelling, and nothing else', () => {
    expect(parsePostUrl('https://twitter.com/Jack/status/20?s=20')).toEqual({ url: 'https://x.com/Jack/status/20', handle: 'jack' })
    expect(parsePostUrl(' https://mobile.x.com/a_b/status/1234567890/photo/1 ')).toEqual({ url: 'https://x.com/a_b/status/1234567890', handle: 'a_b' })
    for (const bad of ['http://x.com/a/status/1', 'https://x.com.evil.io/a/status/1', 'https://x.com/a/likes', 'https://x.com/a/status/abc', 'javascript:alert(1)', 5, null]) {
      expect(parsePostUrl(bad)).toBeNull()
    }
  })

  it('gives every wallet its own post code for every room', () => {
    const a = postCode(ROOM, '0x00000000000000000000000000000000000000a1')
    expect(a).toMatch(/^CZ-[0-9A-F]{6}$/)
    expect(postCode(ROOM.toUpperCase().replace('0X', '0x'), '0x00000000000000000000000000000000000000A1')).toBe(a)
    expect(postCode(ROOM, '0x00000000000000000000000000000000000000a2')).not.toBe(a)
    expect(postCode('0x00000000000000000000000000000000000000ff', '0x00000000000000000000000000000000000000a1')).not.toBe(a)
  })

  it('never calls a post it could not read fine', async () => {
    const down = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(await checkPost(post('a', '1'), 'CZ-AAAAAA', down)).toEqual({ state: 'unreachable', handle: null })
    const html = (async () => new Response('<html>rate limited</html>', { status: 200 })) as unknown as typeof fetch
    expect((await checkPost(post('a', '1'), 'CZ-AAAAAA', html)).state).toBe('unreachable')
    const busy = (async () => new Response('', { status: 429 })) as unknown as typeof fetch
    expect((await checkPost(post('a', '1'), 'CZ-AAAAAA', busy)).state).toBe('unreachable')
    const gone = (async () => new Response('', { status: 404 })) as unknown as typeof fetch
    expect((await checkPost(post('a', '1'), 'CZ-AAAAAA', gone)).state).toBe('missing')
  })

  it('knows a picture by how its bytes begin', () => {
    expect(pictureType(PNG)).toBe('image/png')
    expect(pictureType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('image/jpeg')
    expect(pictureType(new TextEncoder().encode('GIF89a..........'))).toBe('image/gif')
    expect(pictureType(new TextEncoder().encode('RIFF....WEBPVP8 '))).toBe('image/webp')
    expect(pictureType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull()
    expect(pictureType(new TextEncoder().encode('<!doctype html><script>alert(1)</script>'))).toBeNull()
    expect(pictureType(new Uint8Array([0x89, 0x50]))).toBeNull()
  })

  it('keeps line breaks in long text and nothing invisible', () => {
    expect(cleanText('  one\r\ntwo\n\n\n\nthree​\u0007 ')).toBe('one\ntwo\n\nthree')
  })

  it('holds clan names and tags to their shape', () => {
    expect(clanTag(' wolf ')).toEqual({ tag: 'WOLF' })
    for (const bad of ['a', 'toolong', 'a b', 'a-b', '<b>', 'admin', 'callz', 7]) expect(typeof clanTag(bad)).toBe('string')
    expect(clanName('  Night   Wolves ')).toEqual({ name: 'Night Wolves' })
    for (const bad of ['ab', 'x'.repeat(25), 'Wolves!', '<script>', 'a_b', null]) expect(typeof clanName(bad)).toBe('string')
  })
})

describe('signing in', () => {
  it('gives a session for a wallet signature and for nothing else', async () => {
    const { env } = setup()
    const account = newAccount()
    const issuedAt = NOW
    const send = (body: unknown, headers: Record<string, string> = {}) =>
      handleSession(new Request(`${ORIGIN}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }), env)
    const signature = await account.signMessage({ message: sessionSigningText({ wallet: account.address, issuedAt }) })

    // Another wallet's name on this signature, and a signature over another time.
    expect((await send({ wallet: newAccount().address, issuedAt, signature })).status).toBe(403)
    expect((await send({ wallet: account.address, issuedAt: issuedAt + 1, signature })).status).toBe(403)
    expect((await send({ wallet: account.address, issuedAt: issuedAt - 3600, signature })).status).toBe(400)

    const opened = await send({ wallet: account.address, issuedAt, signature })
    expect(opened.status).toBe(201)
    const { token, wallet } = (await opened.json()) as { token: string; wallet: string }
    expect(wallet).toBe(account.address.toLowerCase())
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    // The same signature opens no second session.
    expect((await send({ wallet: account.address, issuedAt, signature })).status).toBe(409)

    const who = (bearer: string) => handleSession(new Request(`${ORIGIN}/api/session`, { headers: { authorization: `Bearer ${bearer}` } }), env)
    expect(await (await who(token)).json()).toMatchObject({ wallet: account.address.toLowerCase() })
    expect((await who('f'.repeat(64))).status).toBe(401)
    // The token itself is nowhere in the database.
    expect(JSON.stringify(await env.DB.prepare('SELECT * FROM sessions').all())).not.toContain(token)

    // It runs out after a week, and signing out ends it at once.
    vi.setSystemTime((NOW + 7 * 86_400 + 1) * 1000)
    expect((await who(token)).status).toBe(401)
    vi.setSystemTime(NOW * 1000 + 5000)
    await handleSession(new Request(`${ORIGIN}/api/session`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }), env)
    expect((await who(token)).status).toBe(401)
  })
})

describe('a room', () => {
  it('is listed by its dev alone, from what its contract says', async () => {
    const { call, dev, state } = setup()
    const stranger = newAccount()
    const settings = { room: ROOM, about: 'We ship at night.\n\n\n\nBring coffee.', wantPost: true, postBrief: 'Say why you want in.', wantRole: true, roleBrief: 'Designers first.' }

    expect((await call('/api/rooms', null, settings)).status).toBe(401)
    expect((await call('/api/rooms', stranger, settings)).status).toBe(403)
    expect((await call('/api/rooms', dev, { ...settings, room: '0x00000000000000000000000000000000000000ff' })).status).toBe(404)
    expect((await call('/api/rooms', dev, { ...settings, wantPost: 'yes' })).status).toBe(400)
    expect((await call('/api/rooms', dev, { ...settings, about: 'x'.repeat(601) })).status).toBe(400)

    const listed = await call('/api/rooms', dev, settings)
    expect(listed.status).toBe(200)
    expect(listed.body.room).toMatchObject({
      address: ROOM,
      creator: dev.address.toLowerCase(),
      name: 'Night Shift',
      symbol: 'NIGHT',
      picture: 'ab'.repeat(32),
      about: 'We ship at night.\n\nBring coffee.',
      wantPost: true,
      wantRole: true,
      gate: null,
      seatPrice: '250000000000000000',
      seats: 4,
      seated: 0,
      launched: false,
    })
    const all = await call('/api/rooms', null)
    expect(all.body.rooms).toHaveLength(1)
    expect(all.body.rooms[0]).toMatchObject({ address: ROOM, applicants: 0 })

    // A pass bought on chain shows up once the copy is old enough to be read again.
    const member = newAccount()
    state.members.push({ wallet: member.address.toLowerCase(), seat: 1 })
    vi.setSystemTime(Date.now() + 16_000)
    const seen = await call(`/api/rooms/${ROOM}`, null)
    expect(seen.body.room.seated).toBe(1)
    expect(seen.body.members).toEqual([expect.objectContaining({ wallet: member.address.toLowerCase(), seat: 1, points: 0, tag: null, muted: false })])
  })

  it('serves its copy when the chain cannot be read, and never invents a room', async () => {
    const { call, dev, state, later } = setup()
    state.rpcDown = true
    expect((await call(`/api/rooms/${ROOM}`, null)).status).toBe(500)
    state.rpcDown = false
    await call('/api/rooms', dev, { room: ROOM, about: '', wantPost: false, postBrief: '', wantRole: false, roleBrief: '' })
    state.rpcDown = true
    later(120)
    expect((await call(`/api/rooms/${ROOM}`, null)).body.room.name).toBe('Night Shift')
    expect((await call('/api/rooms/0x00000000000000000000000000000000000000ff', null)).status).toBe(500)
  })
})

describe('applying', () => {
  const open = async (options: { gate?: boolean; wantPost?: boolean; wantRole?: boolean } = {}) => {
    const context = setup(options.gate === undefined ? {} : { gate: options.gate })
    await context.call('/api/rooms', context.dev, { room: ROOM, about: '', wantPost: options.wantPost ?? false, postBrief: '', wantRole: options.wantRole ?? false, roleBrief: '' })
    return context
  }

  it('takes a post only when X has it and it carries the applicant own code', async () => {
    const { call, state } = await open({ wantPost: true })
    const applicant = newAccount()
    const code = postCode(ROOM, applicant.address)
    expect((await call(`/api/rooms/${ROOM}/application`, null, {})).status).toBe(401)
    expect((await call(`/api/rooms/${ROOM}/application`, applicant)).body).toMatchObject({ code, application: null, dev: false })

    expect((await call(`/api/rooms/${ROOM}/application`, applicant, {})).status).toBe(400)
    expect((await call(`/api/rooms/${ROOM}/application`, applicant, { postUrl: 'https://example.com/a/status/1' })).status).toBe(400)
    // X does not know the post.
    expect((await call(`/api/rooms/${ROOM}/application`, applicant, { postUrl: post('nightowl', '1') })).body.error).toContain('no such post')
    // The post is somebody else's: it carries another wallet's code.
    state.posts.set(post('nightowl', '1'), { author: 'nightowl', text: `joining ${postCode(ROOM, newAccount().address)}` })
    expect((await call(`/api/rooms/${ROOM}/application`, applicant, { postUrl: post('nightowl', '1') })).body.error).toContain(code)

    state.posts.set(post('nightowl', '2'), { author: 'NightOwl', text: `Let me in, ${code.toLowerCase()} @callzfun` })
    const applied = await call(`/api/rooms/${ROOM}/application`, applicant, { postUrl: 'https://twitter.com/nightowl/status/2?s=46' })
    expect(applied.status).toBe(200)
    expect(applied.body.application).toMatchObject({ postUrl: post('nightowl', '2'), postHandle: 'nightowl', postState: 'ok', status: 'pending', role: null })

    // Nobody else can hand in that post.
    const copycat = newAccount()
    state.posts.set(post('nightowl', '2'), { author: 'nightowl', text: `${code} ${postCode(ROOM, copycat.address)}` })
    expect((await call(`/api/rooms/${ROOM}/application`, copycat, { postUrl: post('nightowl', '2') })).status).toBe(409)
  })

  it('lets an application in unchecked when X cannot be asked, and says so', async () => {
    const { call, state, dev } = await open({ wantPost: true })
    const applicant = newAccount()
    state.xDown = true
    const applied = await call(`/api/rooms/${ROOM}/application`, applicant, { postUrl: post('nightowl', '3') })
    expect(applied.body.application.postState).toBe('unreachable')
    const checked = await call(`/api/rooms/${ROOM}/applications/${applicant.address}`, dev, { action: 'check' })
    expect(checked.body).toMatchObject({ ready: false, application: { postState: 'unreachable' } })
  })

  it('reads the wallet for the token the room requires, when applying and again at the check', async () => {
    const { call, state, dev } = await open({ gate: true })
    const applicant = newAccount()
    const wallet = applicant.address.toLowerCase()
    expect((await call(`/api/rooms/${ROOM}`, null)).body.room.gate).toEqual({ token: GATE, amount: (1000n * 10n ** 18n).toString(), symbol: 'Cake', decimals: 18 })

    state.balances.set(wallet, 999n * 10n ** 18n)
    expect((await call(`/api/rooms/${ROOM}/application`, applicant, {})).status).toBe(403)
    state.rpcDown = true
    expect((await call(`/api/rooms/${ROOM}/application`, applicant, {})).status).toBe(503)
    state.rpcDown = false

    state.balances.set(wallet, 1000n * 10n ** 18n)
    const applied = await call(`/api/rooms/${ROOM}/application`, applicant, {})
    expect(applied.body.application).toMatchObject({ holdState: 'ok', held: (1000n * 10n ** 18n).toString() })

    // Met when they applied is not met now: the tokens left the wallet.
    expect((await call(`/api/rooms/${ROOM}/applications/${wallet}`, dev, { action: 'check' })).body.ready).toBe(true)
    state.balances.set(wallet, 1n)
    const checked = await call(`/api/rooms/${ROOM}/applications/${wallet}`, dev, { action: 'check' })
    expect(checked.body).toMatchObject({ ready: false, application: { holdState: 'short', held: '1' } })
    // And a balance that cannot be read is not a balance that is enough.
    state.balances.set(wallet, 5000n * 10n ** 18n)
    state.rpcDown = true
    expect((await call(`/api/rooms/${ROOM}/applications/${wallet}`, dev, { action: 'check' })).body).toMatchObject({ ready: false, application: { holdState: 'unreadable' } })
  })

  it('shows the dev every applicant with what they handed in and where they stand on chain', async () => {
    const { call, state, dev, seat } = await open({ wantPost: true, wantRole: true })
    const [designer, coder] = [newAccount(), newAccount()]
    for (const [index, applicant] of [designer, coder].entries()) {
      state.posts.set(post(`user${index}`, '9'), { author: `user${index}`, text: postCode(ROOM, applicant.address) })
    }
    expect((await call(`/api/rooms/${ROOM}/application`, designer, { postUrl: post('user0', '9') })).body.error).toContain('role')
    await call(`/api/rooms/${ROOM}/application`, designer, { postUrl: post('user0', '9'), role: 'Designer', portfolio: 'https://dribbble.com/me\n\n\n\n<script>alert(1)</script>' })
    await call(`/api/rooms/${ROOM}/application`, coder, { postUrl: post('user1', '9'), role: 'Solidity', portfolio: '' })

    expect((await call(`/api/rooms/${ROOM}/applications`, null)).status).toBe(401)
    expect((await call(`/api/rooms/${ROOM}/applications`, designer)).status).toBe(403)
    state.admitted.add(coder.address.toLowerCase())
    const seen = await call(`/api/rooms/${ROOM}/applications`, dev)
    expect(seen.body.applications).toEqual([
      expect.objectContaining({ wallet: designer.address.toLowerCase(), role: 'Designer', portfolio: 'https://dribbble.com/me\n\n<script>alert(1)</script>', postState: 'ok', standing: { admitted: false, banned: false, seat: 0 } }),
      expect.objectContaining({ wallet: coder.address.toLowerCase(), role: 'Solidity', portfolio: null, standing: { admitted: true, banned: false, seat: 0 } }),
    ])
    expect((await call(`/api/rooms/${ROOM}`, null)).body.room.applicants).toBe(2)

    // The post comes down before the dev lets the wallet in: not ready any more.
    state.posts.delete(post('user0', '9'))
    expect((await call(`/api/rooms/${ROOM}/applications/${designer.address}`, designer, { action: 'check' })).status).toBe(403)
    expect((await call(`/api/rooms/${ROOM}/applications/${designer.address}`, dev, { action: 'check' })).body).toMatchObject({ ready: false, application: { postState: 'missing' } })
    expect((await call(`/api/rooms/${ROOM}/applications/${coder.address}`, dev, { action: 'check' })).body.ready).toBe(true)

    // Declined stays declined until the dev reopens it.
    expect((await call(`/api/rooms/${ROOM}/applications/${designer.address}`, dev, { action: 'decline' })).body.application.status).toBe('declined')
    state.posts.set(post('user0', '9'), { author: 'user0', text: postCode(ROOM, designer.address) })
    expect((await call(`/api/rooms/${ROOM}/application`, designer, { postUrl: post('user0', '9'), role: 'Designer' })).status).toBe(409)
    expect((await call(`/api/rooms/${ROOM}/applications/${designer.address}`, dev, { action: 'reopen' })).body.application.status).toBe('pending')
    expect((await call(`/api/rooms/${ROOM}/applications/${designer.address}`, dev, { action: 'adopt' })).status).toBe(400)
    expect((await call(`/api/rooms/${ROOM}/applications/${newAccount().address}`, dev, { action: 'check' })).status).toBe(404)

    seat(coder)
    expect((await call(`/api/rooms/${ROOM}/application`, coder)).body.standing).toEqual({ admitted: false, banned: false, seat: 1 })
  })
})

describe('the private chat', () => {
  const room = async () => {
    const context = setup()
    await context.call('/api/rooms', context.dev, { room: ROOM, about: '', wantPost: false, postBrief: '', wantRole: false, roleBrief: '' })
    return context
  }

  it('is read and written only by the dev and the wallets holding a pass', async () => {
    const { call, dev, seat, later } = await room()
    const [member, outsider] = [newAccount(), newAccount()]
    seat(member)
    later(31)

    expect((await call(`/api/rooms/${ROOM}/messages`, null)).status).toBe(401)
    expect((await call(`/api/rooms/${ROOM}/messages`, outsider)).status).toBe(403)
    expect((await call(`/api/rooms/${ROOM}/messages`, outsider, { body: 'let me in' })).status).toBe(403)

    expect((await call(`/api/rooms/${ROOM}/messages`, dev, { body: 'Welcome. Docs: https://docs.example.com/start' })).status).toBe(201)
    later(2)
    const said = await call(`/api/rooms/${ROOM}/messages`, member, { body: '  gm​ <img src=x onerror=alert(1)>  ' })
    expect(said.body.message).toMatchObject({ author: member.address.toLowerCase(), body: 'gm <img src=x onerror=alert(1)>', picture: null })
    // Too fast, empty, too long.
    expect((await call(`/api/rooms/${ROOM}/messages`, member, { body: 'again' })).status).toBe(429)
    later(2)
    expect((await call(`/api/rooms/${ROOM}/messages`, member, { body: ' ​ ' })).status).toBe(400)
    expect((await call(`/api/rooms/${ROOM}/messages`, member, { body: 'x'.repeat(1001) })).status).toBe(400)

    const read = await call(`/api/rooms/${ROOM}/messages`, member)
    expect(read.body.messages.map((message: { body: string }) => message.body)).toEqual(['Welcome. Docs: https://docs.example.com/start', 'gm <img src=x onerror=alert(1)>'])
    const after = await call(`/api/rooms/${ROOM}/messages?after=${read.body.messages[0].id}`, dev)
    expect(after.body.messages).toHaveLength(1)
    expect((await call(`/api/rooms/${ROOM}/messages?after=1;DROP TABLE room_messages`, dev)).status).toBe(400)
  })

  it('closes to a member the moment the chain no longer shows their pass', async () => {
    const { call, state, seat, later } = await room()
    const member = newAccount()
    seat(member)
    later(31)
    expect((await call(`/api/rooms/${ROOM}/messages`, member)).status).toBe(200)

    // Removed on chain by the dev: the pass is burned and the wallet barred.
    state.members = []
    state.banned.add(member.address.toLowerCase())
    later(31)
    expect((await call(`/api/rooms/${ROOM}/messages`, member)).status).toBe(403)
    expect((await call(`/api/rooms/${ROOM}`, null)).body.members).toEqual([])
  })

  it('keeps pictures to the room they were posted in', async () => {
    const { call, dev, seat, later } = await room()
    const [member, outsider] = [newAccount(), newAccount()]
    seat(member)
    later(31)

    expect((await call(`/api/rooms/${ROOM}/pictures`, outsider, PNG)).status).toBe(403)
    expect((await call(`/api/rooms/${ROOM}/pictures`, member, new TextEncoder().encode('<svg><script>alert(1)</script></svg>'))).status).toBe(400)
    const stored = await call(`/api/rooms/${ROOM}/pictures`, member, PNG)
    expect(stored.status).toBe(201)
    const { hash } = stored.body as { hash: string }
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    // The same picture again is the same picture.
    expect((await call(`/api/rooms/${ROOM}/pictures`, member, PNG)).body.hash).toBe(hash)

    expect((await call(`/api/rooms/${ROOM}/messages`, member, { body: '', picture: 'f'.repeat(64) })).status).toBe(400)
    expect((await call(`/api/rooms/${ROOM}/messages`, member, { body: '', picture: '../etc/passwd' })).status).toBe(400)
    expect((await call(`/api/rooms/${ROOM}/messages`, member, { body: '', picture: hash })).body.message.picture).toBe(hash)

    expect((await call(`/api/rooms/${ROOM}/pictures/${hash}`, dev)).body).toEqual(PNG)
    expect((await call(`/api/rooms/${ROOM}/pictures/${hash}`, outsider)).status).toBe(403)
    expect((await call(`/api/rooms/${ROOM}/pictures/${hash}`, null)).status).toBe(401)
    // It is not a room picture: the public address does not serve it.
    expect((await call(`/api/rooms/image/${hash}`, null)).status).toBe(404)

    // A room's own picture is public, and limited per wallet per day.
    const cover = await call('/api/rooms/images', dev, PNG)
    expect(cover.body).toEqual({ hash, url: `https://callz.fun/api/rooms/image/${hash}` })
    expect((await call(`/api/rooms/image/${hash}`, null)).body).toEqual(PNG)
    expect((await call('/api/rooms/images', null, PNG)).status).toBe(401)
    for (let index = 0; index < 9; index++) expect((await call('/api/rooms/images', dev, Uint8Array.from([...PNG, index]))).status).toBe(201)
    expect((await call('/api/rooms/images', dev, Uint8Array.from([...PNG, 99]))).status).toBe(429)
  })

  it('lets the dev take a member out of the chat and back in', async () => {
    const { call, dev, seat, later } = await room()
    const member = newAccount()
    seat(member)
    later(31)
    expect((await call(`/api/rooms/${ROOM}/mutes`, member, { wallet: dev.address, muted: true })).status).toBe(403)
    expect((await call(`/api/rooms/${ROOM}/mutes`, dev, { wallet: newAccount().address, muted: true })).status).toBe(404)
    expect((await call(`/api/rooms/${ROOM}/mutes`, dev, { wallet: member.address, muted: true })).body).toEqual({ wallet: member.address.toLowerCase(), muted: true })
    expect((await call(`/api/rooms/${ROOM}/messages`, member)).status).toBe(403)
    expect((await call(`/api/rooms/${ROOM}/application`, member)).body.muted).toBe(true)
    await call(`/api/rooms/${ROOM}/mutes`, dev, { wallet: member.address, muted: false })
    expect((await call(`/api/rooms/${ROOM}/messages`, member)).status).toBe(200)
  })
})

describe('points, tags, clans and the boards', () => {
  it('lets a dev give a member of their room at most 100 points, and a tag', async () => {
    const { call, dev, seat, later } = setup()
    await call('/api/rooms', dev, { room: ROOM, about: '', wantPost: false, postBrief: '', wantRole: false, roleBrief: '' })
    const [member, other] = [newAccount(), newAccount()]
    seat(member)
    later(31)
    const wallet = member.address.toLowerCase()

    expect((await call(`/api/rooms/${ROOM}/points`, member, { wallet, points: 50, note: '' })).status).toBe(403)
    expect((await call(`/api/rooms/${ROOM}/points`, dev, { wallet: other.address, points: 5, note: '' })).status).toBe(404)
    for (const points of [0, 101, 1.5, '5', -3]) expect((await call(`/api/rooms/${ROOM}/points`, dev, { wallet, points, note: '' })).status).toBe(400)
    expect((await call(`/api/rooms/${ROOM}/points`, dev, { wallet, points: 60, note: 'Shipped the site' })).body).toEqual({ wallet, points: 60 })
    expect((await call(`/api/rooms/${ROOM}/points`, dev, { wallet, points: 41, note: '' })).body.error).toContain('40 more')
    expect((await call(`/api/rooms/${ROOM}/points`, dev, { wallet, points: 40, note: '' })).body.points).toBe(100)
    expect((await call(`/api/rooms/${ROOM}/points`, dev, { wallet, points: 1, note: '' })).status).toBe(409)

    expect((await call(`/api/rooms/${ROOM}/tags`, dev, { wallet, label: '  Lead   designer ' })).body.tag).toBe('Lead   designer')
    expect((await call(`/api/rooms/${ROOM}/tags`, dev, { wallet, label: 'x'.repeat(25) })).status).toBe(400)
    expect((await call(`/api/rooms/${ROOM}`, null)).body.members[0]).toMatchObject({ wallet, points: 100, tag: 'Lead   designer' })

    const profile = await call(`/api/profile/${wallet}`, null)
    expect(profile.body).toMatchObject({
      wallet,
      points: 100,
      byRoom: [{ room: ROOM, symbol: 'NIGHT', points: 100 }],
      tags: [{ room: ROOM, symbol: 'NIGHT', label: 'Lead   designer' }],
      rooms: [{ room: ROOM, dev: false, launched: false }],
      clan: null,
    })
    expect((await call(`/api/profile/${dev.address}`, null)).body.rooms).toEqual([expect.objectContaining({ room: ROOM, dev: true })])
    expect((await call('/api/leaderboard/social', null)).body.board).toEqual([expect.objectContaining({ rank: 1, wallet, points: 100, rooms: 1 })])

    await call(`/api/rooms/${ROOM}/tags`, dev, { wallet, label: null })
    expect((await call(`/api/rooms/${ROOM}`, null)).body.members[0].tag).toBeNull()
  })

  it('runs a clan from founding to the last member leaving, and shows its tag in every chat', async () => {
    const { call, dev, seat, later, sqlite } = setup()
    await call('/api/rooms', dev, { room: ROOM, about: '', wantPost: false, postBrief: '', wantRole: false, roleBrief: '' })
    const [founder, friend, rival] = [newAccount(), newAccount(), newAccount()]

    expect((await call('/api/clans', null, { name: 'Night Wolves', tag: 'wolf' })).status).toBe(401)
    expect((await call('/api/clans', founder, { name: 'Night Wolves', tag: 'w' })).status).toBe(400)
    const founded = await call('/api/clans', founder, { name: 'Night Wolves', tag: 'wolf' })
    expect(founded.body.clan).toMatchObject({ tag: 'WOLF', name: 'Night Wolves', founder: founder.address.toLowerCase(), members: 1 })
    expect((await call('/api/clans', founder, { name: 'Second Pack', tag: 'two' })).status).toBe(409)
    expect((await call('/api/clans', rival, { name: 'night wolves', tag: 'bear' })).body.error).toContain('name is taken')
    expect((await call('/api/clans', rival, { name: 'Bears', tag: 'WOLF' })).body.error).toContain('tag is taken')
    expect((await call('/api/clans', rival, { name: 'Bears', tag: 'bear' })).status).toBe(200)

    // Only a member invites; the invited wallet joins, and is then in one clan only.
    expect((await call('/api/clans/WOLF/join', friend, {})).status).toBe(403)
    expect((await call('/api/clans/WOLF/invites', rival, { wallet: friend.address })).status).toBe(403)
    expect((await call('/api/clans/WOLF/invites', founder, { wallet: friend.address })).status).toBe(201)
    expect((await call('/api/clans/WOLF/invites', founder, { wallet: friend.address })).status).toBe(409)
    await call('/api/clans/BEAR/invites', rival, { wallet: friend.address })
    expect((await call('/api/clans/mine', friend)).body.invites.map((invite: { tag: string }) => invite.tag).sort()).toEqual(['BEAR', 'WOLF'])
    const joined = await call('/api/clans/WOLF/join', friend, {})
    expect(joined.body).toMatchObject({ clan: { tag: 'WOLF', members: 2 }, invites: [] })
    expect((await call('/api/clans/BEAR/join', friend, {})).status).toBe(409)
    // A member who is not the founder can invite too.
    expect((await call('/api/clans/WOLF/invites', friend, { wallet: newAccount().address })).status).toBe(201)

    // The tag rides along with the wallet in a room's chat and in a token's chat.
    seat(friend)
    later(31)
    await call(`/api/rooms/${ROOM}/messages`, friend, { body: 'awoo' })
    expect((await call(`/api/rooms/${ROOM}/messages`, friend)).body.messages[0]).toMatchObject({ authorClan: 'WOLF', authorName: null })
    expect((await call(`/api/rooms/${ROOM}`, null)).body.members[0]).toMatchObject({ clan: 'WOLF' })
    sqlite.prepare("INSERT INTO chat_messages (chain, token, author, body, created_at, signature, room) VALUES ('bsc', ?, ?, 'gm', ?, 'sig', 'public')").run(ROOM, friend.address.toLowerCase(), NOW)
    expect((await call(`/api/chat/bsc/${ROOM}`, null)).body.messages[0]).toMatchObject({ authorClan: 'WOLF' })

    await call(`/api/rooms/${ROOM}/points`, dev, { wallet: friend.address, points: 30, note: '' })
    const clans = await call('/api/clans', null)
    expect(clans.body.clans[0]).toMatchObject({ tag: 'WOLF', members: 2, points: 30 })
    expect((await call('/api/clans/wolf', null)).body.members.map((member: { wallet: string }) => member.wallet)).toEqual([founder.address.toLowerCase(), friend.address.toLowerCase()])
    expect((await call('/api/leaderboard/social', null)).body.board[0]).toMatchObject({ clan: 'WOLF', points: 30 })

    // The founder leaves: the clan passes to the member who has been in longest. The last one out ends it.
    expect((await call('/api/clans/leave', founder, {})).body.clan).toBeNull()
    expect((await call('/api/clans/WOLF', null)).body.clan).toMatchObject({ founder: friend.address.toLowerCase(), members: 1 })
    await call('/api/clans/leave', friend, {})
    expect((await call('/api/clans/WOLF', null)).status).toBe(404)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM clan_invites WHERE clan_id NOT IN (SELECT id FROM clans)').get()).toMatchObject({ n: 0 })
    expect((await call('/api/clans/leave', friend, {})).status).toBe(409)
  })

  it('ranks callers by their approved calls', async () => {
    const { call, sqlite } = setup()
    const [sharp, loud] = ['0x00000000000000000000000000000000000000a1', '0x00000000000000000000000000000000000000a2']
    const insert = sqlite.prepare(
      "INSERT INTO callouts (chain, token, author, kind, url, link_hash, signature, created_at, status, call_mcap, position, closed_mcap) VALUES ('bsc', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    let n = 0
    const add = (author: string, token: string, status: string, position: string, callMcap: number, closedMcap: number | null) => {
      n++
      insert.run(token, author, `https://x.com/a/status/${n}`, `hash${n}`, `sig${n}`, NOW, status, callMcap, position, closedMcap)
    }
    add(sharp, '0xt1', 'approved', 'closed', 100_000, 340_000)
    add(sharp, '0xt2', 'approved', 'open', 50_000, null)
    add(loud, '0xt1', 'approved', 'closed', 200_000, 100_000)
    add(loud, '0xt1', 'pending', 'open', 10, null)
    add(loud, '0xt3', 'rejected', 'open', 10, null)

    const board = (await call('/api/leaderboard/calls', null)).body.board
    expect(board).toEqual([
      { rank: 1, wallet: sharp, name: null, clan: null, calls: 2, tokens: 2, holding: 1, best: 3.4 },
      { rank: 2, wallet: loud, name: null, clan: null, calls: 1, tokens: 1, holding: 0, best: 0.5 },
    ])
    expect((await call(`/api/profile/${sharp}`, null)).body).toMatchObject({ calls: 2, tokensCalled: 2, points: 0 })
    expect((await call('/api/profile/not-a-wallet', null)).status).toBe(400)
  })
})

describe('the list of rooms', () => {
  /** Rooms written straight into the database, as the chain reading would have left them. */
  function seeded() {
    const context = setup()
    const insert = context.sqlite.prepare(
      `INSERT INTO rooms (address, creator, name, symbol, seat_price, seats, seated, sale_deadline, pool_share_bps, launch_fee_bps, created_at, synced_at)
VALUES (?, ?, ?, ?, '1000', 4, 0, ?, 5000, 1000, ?, ?)`,
    )
    const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`
    const add = (n: number, name: string, symbol: string, creator: string, createdAt: number) => insert.run(address(n), creator, name, symbol, NOW + 86_400, createdAt, NOW)
    return { ...context, add, address }
  }
  const DEV_A = '0x00000000000000000000000000000000000000aa'
  const DEV_B = '0x00000000000000000000000000000000000000bb'

  it('is newest first, a hundred to a page', async () => {
    const { call, add, address } = seeded()
    for (let n = 1; n <= 205; n++) add(n, `Room ${n}`, `R${n}`, DEV_A, NOW - 1000 + n)
    const first = (await call('/api/rooms', null)).body
    expect(first).toMatchObject({ sort: 'latest', page: 1, pageSize: 100, total: 205 })
    expect(first.rooms).toHaveLength(100)
    expect(first.rooms[0].address).toBe(address(205))
    expect(first.rooms[99].address).toBe(address(106))
    const third = (await call('/api/rooms?page=3', null)).body
    expect(third.rooms.map((room: { address: string }) => room.address)).toEqual([5, 4, 3, 2, 1].map(address))
    expect((await call('/api/rooms?page=4', null)).body.rooms).toEqual([])
    for (const bad of ['0', '-1', '1.5', 'x', '1;DROP TABLE rooms']) expect((await call(`/api/rooms?page=${encodeURIComponent(bad)}`, null)).status).toBe(400)
    expect((await call('/api/rooms?sort=best', null)).status).toBe(400)
  })

  it('finds rooms by name, symbol, address, dev and dev name, and takes nothing typed as a pattern or as SQL', async () => {
    const { call, add, address, sqlite } = seeded()
    add(1, 'Night Shift', 'NIGHT', DEV_A, NOW - 30)
    add(2, 'Day 100% Shift', 'DAY', DEV_B, NOW - 20)
    add(3, 'Under_score', 'USC', DEV_B, NOW - 10)
    sqlite.prepare("INSERT INTO wallet_names (wallet, name, name_key, updated_at, signature) VALUES (?, 'Billy_Badass', 'billy_badass', ?, 'sig-name')").run(DEV_A, NOW)
    const found = async (q: string) => ((await call(`/api/rooms?q=${encodeURIComponent(q)}`, null)).body.rooms as Array<{ address: string }>).map((room) => room.address)

    expect(await found('shift')).toEqual([address(2), address(1)])
    expect(await found('  NIGHT ')).toEqual([address(1)])
    expect(await found('usc')).toEqual([address(3)])
    expect(await found(address(2))).toEqual([address(2)])
    expect(await found(DEV_B)).toEqual([address(3), address(2)])
    expect(await found('billy')).toEqual([address(1)])
    // A percent sign and an underscore are themselves, not "anything".
    expect(await found('100%')).toEqual([address(2)])
    expect(await found('%')).toEqual([address(2)])
    expect(await found('r_s')).toEqual([address(3)])
    // The dev of room 1 is named Billy_Badass.
    expect(await found('_')).toEqual([address(3), address(1)])
    expect(await found("' OR 1=1 --")).toEqual([])
    expect(await found('"; DROP TABLE rooms; --')).toEqual([])
    expect((await call('/api/rooms', null)).body.total).toBe(3)
    expect((await call(`/api/rooms?q=${'x'.repeat(65)}`, null)).status).toBe(400)
  })

  it('puts the rooms with the most applications and passes of the last day first when asked for what is hot', async () => {
    const { call, add, address, sqlite } = seeded()
    add(1, 'Quiet', 'Q', DEV_A, NOW - 10)
    add(2, 'Asked', 'A', DEV_A, NOW - 500)
    add(3, 'Bought', 'B', DEV_A, NOW - 900)
    add(4, 'Yesterday', 'Y', DEV_A, NOW - 950)
    const apply = sqlite.prepare("INSERT INTO room_applications (room, wallet, status, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)")
    const join = sqlite.prepare('INSERT INTO room_members (room, wallet, seat, joined_at, sync) VALUES (?, ?, ?, ?, ?)')
    for (let n = 1; n <= 3; n++) apply.run(address(2), address(100 + n), NOW - 60, NOW - 60)
    for (let n = 1; n <= 2; n++) join.run(address(3), address(200 + n), n, NOW - 60, NOW)
    // More than a day ago: it no longer counts.
    for (let n = 1; n <= 9; n++) apply.run(address(4), address(300 + n), NOW - 90_000, NOW - 90_000)

    const hot = (await call('/api/rooms?sort=hot', null)).body
    expect(hot.sort).toBe('hot')
    expect(hot.rooms.map((room: { address: string; hot: number }) => [room.address, room.hot])).toEqual([
      [address(3), 4],
      [address(2), 3],
      [address(1), 0],
      [address(4), 0],
    ])
    expect((await call('/api/rooms', null)).body.rooms.map((room: { address: string }) => room.address)).toEqual([1, 2, 3, 4].map(address))
  })

  it('lists the rooms of one wallet, as their dev or as a member', async () => {
    const { call, add, address, sqlite } = seeded()
    add(1, 'Mine', 'M', DEV_A, NOW - 30)
    add(2, 'Joined', 'J', DEV_B, NOW - 20)
    add(3, 'Other', 'O', DEV_B, NOW - 10)
    sqlite.prepare('INSERT INTO room_members (room, wallet, seat, joined_at, sync) VALUES (?, ?, 1, ?, ?)').run(address(2), DEV_A, NOW, NOW)
    const mine = (await call(`/api/rooms?wallet=${DEV_A.toUpperCase().replace('0X', '0x')}`, null)).body
    expect(mine.total).toBe(2)
    expect(mine.rooms.map((room: { address: string; role: string }) => [room.address, room.role])).toEqual([
      [address(2), 'member'],
      [address(1), 'dev'],
    ])
    expect((await call('/api/rooms', null)).body.rooms[0].role).toBeUndefined()
    expect((await call('/api/rooms?wallet=nope', null)).status).toBe(400)
    // The profile carries the same rooms, newest first, with what is needed to value a pass.
    expect((await call(`/api/profile/${DEV_A}`, null)).body.rooms).toEqual([
      expect.objectContaining({ room: address(2), dev: false, seat: 1, seatPrice: '1000', seats: 4, token: null, pair: null }),
      expect.objectContaining({ room: address(1), dev: true, seat: null }),
    ])
  })
})

describe('what the post has to say', () => {
  it('reads what a post says out of the markup X returns', async () => {
    const { postText } = await import('../src/rooms.js')
    const html =
      '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">Cooking  <a href="https://x.com/search?q=%24NIGHT">$NIGHT</a> with <a href="https://x.com/callzfun">@callzfun</a><br>Tom &amp; Jerry&#39;s &#x1F525; CZ-ABC123</p>&mdash; someone (@someone) <a href="https://x.com/someone/status/1">May 1, 2026</a></blockquote>'
    expect(postText(html)).toBe("cooking $night with @callzfun tom & jerry's \u{1F525} cz-abc123")
    // What stands outside the post's own paragraph (the author line) is not what the post says.
    expect(postText(html)).not.toContain('someone')
  })

  it('holds a post to the words the dev set, when applying and again at the check', async () => {
    const { call, dev, state } = setup()
    const settings = { room: ROOM, about: '', wantPost: true, postBrief: 'Tell people why.', postPhrase: '  Cooking $NIGHT   with @CallZFun ', wantRole: false, roleBrief: '' }
    expect((await call('/api/rooms', dev, { ...settings, postPhrase: 'x'.repeat(121) })).status).toBe(400)
    expect((await call('/api/rooms', dev, settings)).body.room).toMatchObject({ postBrief: 'Tell people why.', postPhrase: 'Cooking $NIGHT with @CallZFun' })

    const applicant = newAccount()
    const code = postCode(ROOM, applicant.address)
    // The code alone is not enough any more.
    state.posts.set(post('owl', '1'), { author: 'owl', text: `gm ${code}` })
    const refused = await call(`/api/rooms/${ROOM}/application`, applicant, { postUrl: post('owl', '1') })
    expect(refused.status).toBe(400)
    expect(refused.body.error).toContain('Cooking $NIGHT with @CallZFun')
    expect(refused.body.error).not.toContain(code)
    // The words without the code are somebody else's post.
    state.posts.set(post('owl', '2'), { author: 'owl', text: 'Cooking $NIGHT with @callzfun' })
    expect((await call(`/api/rooms/${ROOM}/application`, applicant, { postUrl: post('owl', '2') })).body.error).toContain(code)

    // As X returns it: the cashtag and the mention are links, in other capitals, with a line break between.
    state.posts.set(post('owl', '3'), {
      author: 'owl',
      text: `COOKING <a href="https://x.com/search?q=%24NIGHT">$NIGHT</a><br>with <a href="https://x.com/callzfun">@callzfun</a> ${code}`,
    })
    const applied = await call(`/api/rooms/${ROOM}/application`, applicant, { postUrl: post('owl', '3') })
    expect(applied.body.application).toMatchObject({ postState: 'ok' })
    expect((await call(`/api/rooms/${ROOM}/applications/${applicant.address}`, dev, { action: 'check' })).body).toMatchObject({ ready: true, hasCode: true, hasPhrase: true })

    // The dev changes the words: the post no longer says what it must, and the check says which part.
    await call('/api/rooms', dev, { ...settings, postPhrase: 'Cooking $NIGHT at dawn' })
    expect((await call(`/api/rooms/${ROOM}/applications/${applicant.address}`, dev, { action: 'check' })).body).toMatchObject({
      ready: false,
      hasCode: true,
      hasPhrase: false,
      application: { postState: 'nocode' },
    })
    // With the requirement switched off, no words are kept.
    expect((await call('/api/rooms', dev, { ...settings, wantPost: false })).body.room.postPhrase).toBe('')
  })
})
