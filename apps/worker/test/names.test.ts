import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { stringToHex, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { displayNameError as pageNameError, nameSigningText as pageSigningText, shownName } from '../../web/src/names.js'
import { handleCallouts } from '../src/callouts.js'
import { ISSUED_AT_WINDOW, handleChat } from '../src/chat.js'
import {
  MAX_NAME_LENGTH,
  MIN_NAME_LENGTH,
  NAME_CHANGE_SECONDS,
  RESERVED_NAMES,
  displayNameError,
  handleNames,
  isReservedName,
  nameChangeRefusal,
  nameKeyOf,
  nameSigningText,
  parseNameChange,
  verifyNameSignature,
} from '../src/names.js'

const NOW = 1_800_000_000
const TOKEN = '0x000000000000000000000000000000000000dead'
const CURVE_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

type Env = Parameters<typeof handleNames>[1]
type Account = ReturnType<typeof newAccount>

/** A fresh wallet for each test: no key is ever written down. */
const newAccount = () => privateKeyToAccount(generatePrivateKey())

/** The other valid form of a signature: `s` mirrored in the curve order, recovery bit flipped. */
function twin(signature: Hex): Hex {
  const s = CURVE_ORDER - BigInt(`0x${signature.slice(66, 130)}`)
  const recovery = signature.slice(130) === '1b' ? '1c' : '1b'
  return `0x${signature.slice(2, 66)}${s.toString(16).padStart(64, '0')}${recovery}`
}

const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url).href)

/**
 * D1 as the Worker uses it, over a real SQLite database in memory with every migration applied, 0009 among
 * them. The statements under test run for real: their conditions, the UNIQUE index and the table's CHECKs
 * are SQLite's own, not this file's idea of them.
 */
function database() {
  const sqlite = new DatabaseSync(':memory:')
  for (const file of readdirSync(MIGRATIONS).sort()) sqlite.exec(readFileSync(join(MIGRATIONS, file), 'utf8'))
  const statements: Array<{ sql: string; values: unknown[] }> = []
  const rows = (sql: string, values: unknown[]) => {
    statements.push({ sql, values })
    return sqlite.prepare(sql).all(...(values as never[])).map((row) => ({ ...row }))
  }
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
  } as unknown as Env['DB']
  return { db, sqlite, statements }
}

const urlOf = (wallet: string) => `https://callz.test/api/names/${wallet}`
const errorOf = async (response: Response) => ((await response.json()) as { error: string }).error

/** A signed request to set `name` (or remove the name, for null), as the page sends it. */
async function signed(account: Account, name: string | null, issuedAt: number) {
  const signature = await account.signMessage({ message: nameSigningText({ wallet: account.address, name, issuedAt }) })
  return { name, issuedAt, signature }
}

const send = (db: Env['DB'], wallet: string, body: unknown) =>
  handleNames(new Request(urlOf(wallet), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { DB: db })

/** Signs and sends a change at the present moment of the test's clock. */
const change = async (db: Env['DB'], account: Account, name: string | null) =>
  send(db, account.address, await signed(account, name, Math.floor(Date.now() / 1000)))

const read = async (db: Env['DB'], wallet: string) =>
  (await (await handleNames(new Request(urlOf(wallet)), { DB: db })).json()) as { wallet: string; name: string | null; updatedAt: number | null }

/** The server's clock, held still and moved by hand. Only the clock is replaced: promises and timers run as ever. */
const clock = {
  set: (seconds: number) => vi.setSystemTime(seconds * 1000),
  advance: (seconds: number) => vi.setSystemTime(Date.now() + seconds * 1000),
}
const useClock = () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    clock.set(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })
}

describe('displayNameError', () => {
  it('takes 3 to 20 letters, digits and underscores that start with a letter', () => {
    expect([MIN_NAME_LENGTH, MAX_NAME_LENGTH]).toEqual([3, 20])
    for (const name of ['abc', 'Abc', 'a_b', 'a12', 'Satoshi_2009', 'degen', 'x'.repeat(20), 'A_______________9_z', 'Zed', 'a__']) {
      expect(displayNameError(name), name).toBeNull()
    }
  })

  it('refuses a name shorter than 3 or longer than 20 characters', () => {
    for (const name of ['', 'a', 'ab']) expect(displayNameError(name), name).toBe('A name is at least 3 characters.')
    for (const name of ['x'.repeat(21), 'x'.repeat(200)]) expect(displayNameError(name), name).toBe('A name is at most 20 characters.')
  })

  it('refuses every character outside A-Z, a-z, 0-9 and underscore', () => {
    const message = 'A name can only have letters, digits and underscores (A-Z, a-z, 0-9, _).'
    // Every other character of ASCII, one at a time.
    for (let code = 0; code < 128; code++) {
      const character = String.fromCharCode(code)
      if (/[A-Za-z0-9_]/.test(character)) continue
      expect(displayNameError(`ab${character}cd`), `U+${code.toString(16).padStart(4, '0')}`).toBe(message)
    }
    for (const name of [
      'two words', ' padded', 'padded ', 'tab\there', 'line\nbreak', 'dash-ed', 'dot.ted', 'at@sign', 'sla/sh', 'co:lon',
      // Markup, links and SQL.
      '<b>bold</b>', '<script>x', 'a.com', 'x.com/a', "a'b", 'a";--', 'a%20b',
      // Letters of other scripts made to look like these, and characters nobody sees.
      'аdmin', 'Αlice', 'ａｂｃ', 'ab​cd', 'ab‮cd', 'ab cd', 'café', 'rocket🚀', '名前名前',
    ]) {
      expect(displayNameError(name), JSON.stringify(name)).toBe(message)
    }
  })

  it('refuses a name that starts with a digit or an underscore', () => {
    for (const name of ['1abc', '9lives', '_abc', '___', '123']) expect(displayNameError(name), name).toBe('A name starts with a letter.')
  })

  it('refuses anything that looks like a wallet address', () => {
    for (const name of ['0x12', '0xabc', '0XDEADBEEF', `0x${'ab'.repeat(20)}`, '0x000000000000000000', 'Oxdeadbeef', 'oxABCDEF12', 'OX1234']) {
      expect(displayNameError(name), name).toBe('A name cannot look like a wallet address.')
    }
    // A word that merely begins that way is a word.
    for (const name of ['Oxford', 'oxygen', 'Oxen_1']) expect(displayNameError(name), name).toBeNull()
  })

  it('refuses the reserved names, in any capitals and with underscores worked in', () => {
    const required = [
      'callz', 'admin', 'administrator', 'mod', 'moderator', 'support', 'official', 'team', 'staff', 'system', 'flap', 'pancakeswap',
      'pancake', 'binance', 'bnbchain', 'bnb', 'cz', 'null', 'undefined', 'anonymous',
    ]
    for (const name of required) {
      expect(RESERVED_NAMES.has(name), name).toBe(true)
      for (const spelling of [name, name.toUpperCase(), name[0]!.toUpperCase() + name.slice(1), `${name}_`, [...name].join('_')]) {
        expect(isReservedName(spelling), spelling).toBe(true)
        // Where the spelling is otherwise a name, being reserved is the reason it is refused.
        if (/^[A-Za-z][A-Za-z0-9_]{2,19}$/.test(spelling)) expect(displayNameError(spelling), spelling).toBe('That name is reserved. Choose another.')
        else expect(displayNameError(spelling), spelling).not.toBeNull()
      }
    }
  })

  it('refuses any name that starts with callz', () => {
    for (const name of ['callz', 'CallZ', 'CALLZ', 'callz_support', 'CallZTeam', 'callzfun', 'Callz1', 'call_z', 'c_a_l_l_z_x', 'CallZ_Official_01']) {
      expect(displayNameError(name), name).toBe('That name is reserved. Choose another.')
    }
    // Names that only resemble a reserved one are free.
    for (const name of ['caller', 'calls', 'adminton', 'modern', 'teammate', 'supporter', 'nullable', 'bnbull']) expect(displayNameError(name), name).toBeNull()
  })

  it('refuses anything that is not text', () => {
    for (const value of [undefined, 42, true, {}, ['abc'], null]) expect(displayNameError(value)).toBe('name must be text, or null to remove the name.')
  })

  it('decides uniqueness by the name in lowercase', () => {
    expect(nameKeyOf('Satoshi_2009')).toBe('satoshi_2009')
    expect(nameKeyOf('ALICE')).toBe(nameKeyOf('alice'))
  })
})

describe('the page’s copy of the rules', () => {
  const candidates = [
    '', 'a', 'ab', 'abc', 'Abc', 'a_b', 'x'.repeat(20), 'x'.repeat(21), 'two words', ' abc', 'abc ', 'a-b-c', 'a.b', '<b>x</b>', 'аdmin', 'ab​cd',
    '1abc', '_abc', '0xabc', 'Oxdeadbeef', `0x${'ab'.repeat(20)}`, 'Oxford', 'admin', 'Admin_', 'a_d_m_i_n', 'callz', 'CallZ_fan', 'call_z', 'cz', 'bnb', 'BNB_',
    'null', 'Undefined', 'anonymous', 'moderator', 'Satoshi_2009', 'degen', 'rocket🚀', 'teammate', 'pancake', 'PancakeSwap', 'flap', 'official', 'everyone',
    ...RESERVED_NAMES,
  ]

  it('gives the Worker’s answer for every name, word for word', () => {
    for (const name of candidates) expect(pageNameError(name), JSON.stringify(name)).toBe(displayNameError(name))
  })

  it('signs the very text the Worker verifies', () => {
    const wallet = newAccount().address
    for (const name of ['Satoshi_2009', null]) {
      expect(pageSigningText({ wallet, name, issuedAt: NOW })).toBe(nameSigningText({ wallet, name, issuedAt: NOW }))
    }
  })

  it('shows only what has the shape of a name', () => {
    for (const name of ['abc', 'Satoshi_2009', 'x'.repeat(20)]) expect(shownName(name)).toBe(name)
    for (const value of [null, undefined, 42, '', 'ab', 'x'.repeat(21), '1abc', '<b>x</b>', 'two words', 'a\nb', 'аdmin']) expect(shownName(value)).toBeNull()
  })
})

describe('nameSigningText', () => {
  const WALLET = '0x00000000000000000000000000000000000000Aa'

  it('is exactly the text the wallet shows: the site, the action, the name, the wallet, the chain id and the time', () => {
    expect(nameSigningText({ wallet: WALLET, name: 'Satoshi_2009', issuedAt: NOW })).toBe(
      'CallZ display name\n\nSite: callz.fun\nAction: Set display name\nName: Satoshi_2009\nWallet: 0x00000000000000000000000000000000000000aa\nChain ID: 56\nTime: 1800000000',
    )
  })

  it('has a text of its own for removing the name', () => {
    expect(nameSigningText({ wallet: WALLET, name: null, issuedAt: 1 })).toBe(
      'CallZ display name\n\nSite: callz.fun\nAction: Remove display name\nWallet: 0x00000000000000000000000000000000000000aa\nChain ID: 56\nTime: 1',
    )
  })
})

describe('verifyNameSignature', () => {
  it('accepts the wallet’s own signature, in either spelling of its address', async () => {
    const account = newAccount()
    const fields = { wallet: account.address, name: 'Satoshi_2009', issuedAt: NOW }
    const signature = await account.signMessage({ message: nameSigningText(fields) })
    expect(await verifyNameSignature({ ...fields, signature })).toBe(true)
    expect(await verifyNameSignature({ ...fields, wallet: account.address.toLowerCase(), signature })).toBe(true)
  })

  it('accepts what a browser wallet returns for personal_sign over the UTF-8 bytes', async () => {
    const account = newAccount()
    const fields = { wallet: account.address, name: null, issuedAt: NOW }
    const signature = await account.signMessage({ message: { raw: stringToHex(nameSigningText(fields)) } })
    expect(await verifyNameSignature({ ...fields, signature })).toBe(true)
  })

  it('refuses a signature made by another wallet', async () => {
    const account = newAccount()
    const fields = { wallet: account.address, name: 'Satoshi_2009', issuedAt: NOW }
    // Another wallet signs the very text that names this one.
    const forged = await newAccount().signMessage({ message: nameSigningText(fields) })
    expect(await verifyNameSignature({ ...fields, signature: forged })).toBe(false)
    // And this wallet's signature is not one for another wallet.
    const signature = await account.signMessage({ message: nameSigningText(fields) })
    expect(await verifyNameSignature({ ...fields, wallet: newAccount().address, signature })).toBe(false)
  })

  it('refuses a signature when any signed field differs', async () => {
    const account = newAccount()
    const fields = { wallet: account.address, name: 'Satoshi_2009', issuedAt: NOW }
    const signature = await account.signMessage({ message: nameSigningText(fields) })
    expect(await verifyNameSignature({ ...fields, name: 'Satoshi_2010', signature })).toBe(false)
    expect(await verifyNameSignature({ ...fields, name: 'satoshi_2009', signature })).toBe(false)
    expect(await verifyNameSignature({ ...fields, name: null, signature })).toBe(false)
    expect(await verifyNameSignature({ ...fields, issuedAt: NOW + 1, signature })).toBe(false)
  })

  it('refuses bytes that are not a signature, without throwing', async () => {
    const fields = { wallet: newAccount().address, name: 'Satoshi_2009', issuedAt: NOW }
    expect(await verifyNameSignature({ ...fields, signature: `0x${'00'.repeat(65)}` })).toBe(false)
    expect(await verifyNameSignature({ ...fields, signature: '0x1234' })).toBe(false)
  })
})

describe('parseNameChange', () => {
  const SIGNATURE = `0x${'1'.repeat(128)}1b`
  const good = { name: 'Satoshi_2009', issuedAt: NOW, signature: SIGNATURE }
  const errorOfInput = (input: unknown) => {
    const parsed = parseNameChange(input)
    return parsed.ok ? null : parsed.error
  }

  it('returns the fields as they are verified and stored', async () => {
    const account = newAccount()
    const signature = await account.signMessage({ message: 'gm' })
    expect(parseNameChange({ name: 'Satoshi_2009', issuedAt: NOW, signature: twin(signature) })).toEqual({
      ok: true,
      change: { name: 'Satoshi_2009', issuedAt: NOW, signature },
    })
    expect(parseNameChange({ ...good, name: null })).toEqual({ ok: true, change: { name: null, issuedAt: NOW, signature: SIGNATURE } })
  })

  it('refuses anything that is not an object with exactly the three fields', () => {
    for (const input of [null, undefined, 'abc', 42, [good], []]) expect(errorOfInput(input)).toBe('Send a JSON object with name, issuedAt and signature.')
    const nothingElse = 'Send a JSON object with name, issuedAt and signature, and nothing else.'
    expect(errorOfInput({ ...good, wallet: `0x${'1'.repeat(40)}` })).toBe(nothingElse)
    expect(errorOfInput({ ...good, admin: true })).toBe(nothingElse)
    expect(errorOfInput(JSON.parse('{"name":"Satoshi_2009","issuedAt":1,"signature":"0x","__proto__":{"x":1}}'))).toBe(nothingElse)
    // A request without a name is not a request to remove it: that takes `name: null`, said outright.
    expect(errorOfInput({ issuedAt: NOW, signature: SIGNATURE })).toBe(nothingElse)
    expect(errorOfInput({})).toBe(nothingElse)
  })

  it('refuses a name that breaks a rule, with the rule', () => {
    expect(errorOfInput({ ...good, name: 'ab' })).toBe('A name is at least 3 characters.')
    expect(errorOfInput({ ...good, name: 'admin' })).toBe('That name is reserved. Choose another.')
    expect(errorOfInput({ ...good, name: 42 })).toBe('name must be text, or null to remove the name.')
    expect(errorOfInput({ ...good, name: "x'; DROP TABLE wallet_names;--" })).toMatch(/letters, digits and underscores/)
  })

  it('refuses a time or a signature of the wrong shape', () => {
    for (const issuedAt of [String(NOW), NOW + 0.5, -1, null, undefined]) expect(errorOfInput({ ...good, issuedAt })).toMatch(/issuedAt/)
    for (const signature of ['0x', SIGNATURE.slice(0, -2), `${SIGNATURE.slice(0, 130)}1d`, 27, null, undefined]) {
      expect(errorOfInput({ ...good, signature })).toMatch(/65-byte signature/)
    }
  })
})

describe('nameChangeRefusal', () => {
  const never = { replayed: false, taken: false, updatedAt: null, hasName: false }

  it('lets a first name, a later change and a removal through', () => {
    expect(nameChangeRefusal(never, { name: 'abc', issuedAt: NOW }, NOW)).toBeNull()
    expect(nameChangeRefusal({ ...never, updatedAt: NOW - 600, hasName: true }, { name: 'abc', issuedAt: NOW }, NOW)).toBeNull()
    expect(nameChangeRefusal({ ...never, updatedAt: NOW - 600, hasName: true }, { name: null, issuedAt: NOW }, NOW)).toBeNull()
  })

  it('refuses a used signature, a change inside ten minutes, a taken name and a removal of nothing', () => {
    expect(nameChangeRefusal({ ...never, replayed: true }, { name: 'abc', issuedAt: NOW }, NOW)).toMatchObject({ status: 409, error: 'This request was already used. Sign a new one.' })
    expect(NAME_CHANGE_SECONDS).toBe(600)
    expect(nameChangeRefusal({ ...never, updatedAt: NOW - 599, hasName: true }, { name: 'abc', issuedAt: NOW }, NOW)).toEqual({
      status: 429,
      error: 'A display name can be changed once every 10 minutes. Try again in 1 minute.',
      retryAfter: 1,
    })
    expect(nameChangeRefusal({ ...never, updatedAt: NOW - 61, hasName: true }, { name: null, issuedAt: NOW }, NOW)).toMatchObject({
      status: 429,
      error: 'A display name can be changed once every 10 minutes. Try again in 9 minutes.',
      retryAfter: 539,
    })
    expect(nameChangeRefusal({ ...never, taken: true }, { name: 'abc', issuedAt: NOW }, NOW)).toEqual({ status: 409, error: 'That name is taken by another wallet. Choose another.' })
    expect(nameChangeRefusal(never, { name: null, issuedAt: NOW }, NOW)).toEqual({ status: 409, error: 'This wallet has no display name to remove.' })
    expect(nameChangeRefusal({ ...never, updatedAt: NOW - 900 }, { name: null, issuedAt: NOW }, NOW)).toMatchObject({ status: 409 })
  })

  it('refuses a request signed at or before the wallet’s last change, however long ago that was', () => {
    const before = { ...never, updatedAt: NOW - 1000, hasName: true }
    const stale = { status: 409, error: 'This request was signed before your last name change. Sign a new one.' }
    expect(nameChangeRefusal(before, { name: 'abc', issuedAt: NOW - 1000 }, NOW)).toEqual(stale)
    expect(nameChangeRefusal(before, { name: 'abc', issuedAt: NOW - 5000 }, NOW)).toEqual(stale)
    expect(nameChangeRefusal(before, { name: null, issuedAt: NOW - 1001 }, NOW)).toEqual(stale)
    expect(nameChangeRefusal(before, { name: 'abc', issuedAt: NOW - 999 }, NOW)).toBeNull()
  })

  it('leaves no time at which an older request is fresh again', () => {
    // The wait between changes is longer than the window a signed time may be off by.
    expect(NAME_CHANGE_SECONDS).toBeGreaterThan(ISSUED_AT_WINDOW)
  })
})

// These requests are all turned away before the database is read, so none is given one.
describe('handleNames, before the database', () => {
  const noDatabase = new Proxy(
    {},
    {
      get() {
        throw new Error('the database must not be reached')
      },
    },
  ) as Env['DB']
  const wallet = newAccount().address
  const request = (url: string, init?: RequestInit) => handleNames(new Request(url, init), { DB: noDatabase })
  const postRaw = (body: string, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
    request(urlOf(wallet), { method: 'POST', headers, body })

  it('answers 405 to any method but GET, HEAD and POST', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await request(urlOf(wallet), { method })
      expect(response.status, method).toBe(405)
      expect(response.headers.get('allow')).toBe('GET, HEAD, POST')
    }
  })

  it('answers 404 to another path, and 400 to a wallet that is not an address', async () => {
    expect((await request('https://callz.test/api/names')).status).toBe(404)
    expect((await request('https://callz.test/api/names/')).status).toBe(404)
    expect((await request(`${urlOf(wallet)}/extra`)).status).toBe(404)
    for (const bad of ['0x1234', wallet.slice(2), `${wallet}00`, 'Satoshi_2009', "0x' OR 1=1 --"]) {
      const response = await request(urlOf(encodeURIComponent(bad)))
      expect(response.status, bad).toBe(400)
      expect(await errorOf(response)).toBe('The wallet must be a 0x address.')
    }
  })

  it('answers 400 to a POST that is not application/json, to malformed JSON and to an unknown shape', async () => {
    expect((await postRaw('{}', { 'content-type': 'text/plain' })).status).toBe(400)
    expect((await postRaw('{}', {})).status).toBe(400)
    expect((await postRaw('name=abc', { 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(400)
    expect((await postRaw('{"name":')).status).toBe(400)
    expect((await postRaw('')).status).toBe(400)
    expect((await postRaw('[]')).status).toBe(400)
    expect((await postRaw('"abc"')).status).toBe(400)
    const unknown = await postRaw(JSON.stringify({ name: 'abc', issuedAt: NOW, signature: `0x${'1'.repeat(128)}1b`, role: 'admin' }))
    expect(unknown.status).toBe(400)
    expect(await errorOf(unknown)).toBe('Send a JSON object with name, issuedAt and signature, and nothing else.')
  })

  it('answers 413 to a request body over 1 KB', async () => {
    const response = await postRaw(JSON.stringify({ name: 'a'.repeat(1024) }))
    expect(response.status).toBe(413)
    expect(await errorOf(response)).toBe('The request is larger than 1 KB.')
  })

  it('answers 400 to every name that breaks a rule, before any signature is looked at', async () => {
    for (const [name, error] of [
      ['ab', 'A name is at least 3 characters.'],
      ['x'.repeat(21), 'A name is at most 20 characters.'],
      ['two words', 'A name can only have letters, digits and underscores (A-Z, a-z, 0-9, _).'],
      ['<i>abc</i>', 'A name can only have letters, digits and underscores (A-Z, a-z, 0-9, _).'],
      ['1abc', 'A name starts with a letter.'],
      ['0xabcdef', 'A name cannot look like a wallet address.'],
      ['Admin', 'That name is reserved. Choose another.'],
      ['CallZ_Mod', 'That name is reserved. Choose another.'],
    ] as const) {
      const response = await postRaw(JSON.stringify({ name, issuedAt: NOW, signature: `0x${'1'.repeat(128)}1b` }))
      expect(response.status, name).toBe(400)
      expect(await errorOf(response), name).toBe(error)
    }
  })

  it('answers 400 to a request signed too long ago, or at a time still to come', async () => {
    const account = newAccount()
    const now = Math.floor(Date.now() / 1000)
    for (const issuedAt of [now - ISSUED_AT_WINDOW - 2, now + ISSUED_AT_WINDOW + 2, 0, now * 1000]) {
      const response = await handleNames(
        new Request(urlOf(account.address), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await signed(account, 'Satoshi_2009', issuedAt)) }),
        { DB: noDatabase },
      )
      expect(response.status, String(issuedAt)).toBe(400)
      expect(await errorOf(response)).toBe('The request time is more than 5 minutes from the server clock. Check the clock on your device and try again.')
    }
  })

  it('answers 403 to a request another wallet signed', async () => {
    const victim = newAccount()
    const issuedAt = Math.floor(Date.now() / 1000)
    // Signed by a stranger, over the text that names the victim's wallet.
    const signature = await newAccount().signMessage({ message: nameSigningText({ wallet: victim.address, name: 'Satoshi_2009', issuedAt }) })
    const forged = await handleNames(
      new Request(urlOf(victim.address), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Satoshi_2009', issuedAt, signature }) }),
      { DB: noDatabase },
    )
    expect(forged.status).toBe(403)
    expect(await errorOf(forged)).toBe('The signature does not match this wallet and name.')
    // And a wallet's own request, sent to another wallet's address, is not that wallet's.
    const own = newAccount()
    const moved = await handleNames(
      new Request(urlOf(victim.address), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await signed(own, 'Satoshi_2009', issuedAt)) }),
      { DB: noDatabase },
    )
    expect(moved.status).toBe(403)
  })

  it('sends errors as JSON that is never cached, with no CORS header', async () => {
    const response = await postRaw('{}', { 'content-type': 'application/json', origin: 'https://elsewhere.example' })
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('setting, changing and removing a name', () => {
  useClock()

  it('stores the name a wallet signed, and reads it back', async () => {
    const { db, sqlite } = database()
    const account = newAccount()
    const wallet = account.address.toLowerCase()
    expect(await read(db, account.address)).toEqual({ wallet, name: null, updatedAt: null })

    const response = await change(db, account, 'Satoshi_2009')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ wallet, name: 'Satoshi_2009', updatedAt: NOW })
    // Read by the address in either spelling, and never from a cache.
    expect(await read(db, account.address)).toEqual({ wallet, name: 'Satoshi_2009', updatedAt: NOW })
    expect(await read(db, wallet)).toEqual({ wallet, name: 'Satoshi_2009', updatedAt: NOW })
    expect((await handleNames(new Request(urlOf(wallet)), { DB: db })).headers.get('cache-control')).toBe('no-store')
    // One row: the address and the key in lowercase, the name as typed, the server's time.
    expect(sqlite.prepare('SELECT wallet, name, name_key, updated_at FROM wallet_names').all().map((row) => ({ ...row }))).toEqual([
      { wallet, name: 'Satoshi_2009', name_key: 'satoshi_2009', updated_at: NOW },
    ])
  })

  it('stores the server’s time, not the time the wallet signed', async () => {
    const { db } = database()
    const account = newAccount()
    expect((await send(db, account.address, await signed(account, 'Satoshi_2009', NOW - 200))).status).toBe(200)
    expect((await read(db, account.address)).updatedAt).toBe(NOW)
  })

  it('reaches the database through bound parameters only', async () => {
    const { db, statements } = database()
    const account = newAccount()
    await change(db, account, 'Satoshi_2009')
    await read(db, account.address)
    expect(statements.length).toBeGreaterThan(0)
    for (const { sql } of statements) {
      expect(sql).not.toContain('Satoshi_2009')
      expect(sql.toLowerCase()).not.toContain(account.address.toLowerCase().slice(2))
    }
  })

  it('refuses a signed request the second time it is sent', async () => {
    const { db } = database()
    const account = newAccount()
    const request = await signed(account, 'Satoshi_2009', NOW)
    expect((await send(db, account.address, request)).status).toBe(200)
    for (const again of [request, { ...request, signature: twin(request.signature) }, { ...request, signature: `0x${request.signature.slice(2).toUpperCase()}` }]) {
      const replay = await send(db, account.address, again)
      expect(replay.status).toBe(409)
      expect(await errorOf(replay)).toBe('This request was already used. Sign a new one.')
    }
    // Not ten minutes later either, when the wallet could change its name again: by then it is too old.
    clock.advance(NAME_CHANGE_SECONDS)
    expect((await send(db, account.address, request)).status).toBe(400)
  })

  it('never takes an older request once a newer change is stored', async () => {
    const { db } = database()
    const account = newAccount()
    // Signed with a clock five minutes fast: the latest time a request can carry.
    const first = await signed(account, 'First_name', NOW + ISSUED_AT_WINDOW)
    expect((await send(db, account.address, first)).status).toBe(200)
    clock.advance(NAME_CHANGE_SECONDS)
    expect((await change(db, account, 'Second_name')).status).toBe(200)
    // From here on the first request is refused at every later second.
    for (const later of [0, 1, 299, 300, 599, 600, 601, 3600]) {
      clock.set(NOW + NAME_CHANGE_SECONDS + later)
      const replay = await send(db, account.address, first)
      expect([400, 409, 429], String(later)).toContain(replay.status)
      expect((await read(db, account.address)).name, String(later)).toBe('Second_name')
    }
  })

  it('refuses a name another wallet holds, in any capitals, with 409', async () => {
    const { db } = database()
    const holder = newAccount()
    expect((await change(db, holder, 'Satoshi_2009')).status).toBe(200)
    for (const name of ['Satoshi_2009', 'satoshi_2009', 'SATOSHI_2009', 'sAtOsHi_2009']) {
      const other = newAccount()
      const response = await change(db, other, name)
      expect(response.status, name).toBe(409)
      expect(await errorOf(response)).toBe('That name is taken by another wallet. Choose another.')
      expect(await read(db, other.address)).toMatchObject({ name: null, updatedAt: null })
    }
    expect((await read(db, holder.address)).name).toBe('Satoshi_2009')
    // A name that only resembles it is another name.
    expect((await change(db, newAccount(), 'Satoshi_2010')).status).toBe(200)
  })

  it('keeps one wallet per name even past the Worker’s own checks', () => {
    const { sqlite } = database()
    const insert = (wallet: string, name: string | null, key: string | null, signature: string) =>
      sqlite.prepare('INSERT INTO wallet_names (wallet, name, name_key, updated_at, signature) VALUES (?, ?, ?, ?, ?)').run(wallet, name, key, NOW, signature)
    insert('0xa', 'Alice', 'alice', 's1')
    // The UNIQUE index on the key, the UNIQUE signature and the primary key.
    expect(() => insert('0xb', 'ALICE', 'alice', 's2')).toThrow(/UNIQUE constraint failed: wallet_names\.name_key/)
    expect(() => insert('0xb', 'Bob', 'bob', 's1')).toThrow(/UNIQUE constraint failed: wallet_names\.signature/)
    expect(() => insert('0xa', 'Carol', 'carol', 's3')).toThrow(/UNIQUE constraint failed: wallet_names\.wallet/)
    // And the table's own CHECKs on what a name is.
    for (const [name, key] of [['ab', 'ab'], ['x'.repeat(21), 'x'.repeat(21)], ['1abc', '1abc'], ['a b c', 'a b c'], ['<b>x</b>', '<b>x</b>'], ['Dave', 'DAVE'], ['Dave', null], [null, 'dave']] as const) {
      expect(() => insert('0xc', name, key, 's4'), String(name)).toThrow(/CHECK constraint failed/)
    }
    // Wallets without a name do not collide with each other.
    insert('0xd', null, null, 's5')
    insert('0xe', null, null, 's6')
  })

  it('lets a wallet change its name once every ten minutes, and no sooner', async () => {
    const { db } = database()
    const account = newAccount()
    expect((await change(db, account, 'First_name')).status).toBe(200)

    for (const [after, minutes] of [[1, 10], [300, 5], [599, 1]] as const) {
      clock.set(NOW + after)
      const early = await change(db, account, 'Second_name')
      expect(early.status, String(after)).toBe(429)
      expect(early.headers.get('retry-after')).toBe(String(NAME_CHANGE_SECONDS - after))
      expect(await errorOf(early)).toBe(`A display name can be changed once every 10 minutes. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`)
      // Removing it is a change like any other.
      expect((await change(db, account, null)).status).toBe(429)
      expect((await read(db, account.address)).name).toBe('First_name')
    }

    clock.set(NOW + NAME_CHANGE_SECONDS)
    expect((await change(db, account, 'Second_name')).status).toBe(200)
    expect(await read(db, account.address)).toMatchObject({ name: 'Second_name', updatedAt: NOW + NAME_CHANGE_SECONDS })
    // The name it gave up is free for another wallet; the limit is each wallet's own.
    expect((await change(db, newAccount(), 'first_name')).status).toBe(200)
  })

  it('lets a wallet change the capitals of its own name', async () => {
    const { db } = database()
    const account = newAccount()
    expect((await change(db, account, 'satoshi_2009')).status).toBe(200)
    clock.advance(NAME_CHANGE_SECONDS)
    expect((await change(db, account, 'Satoshi_2009')).status).toBe(200)
    expect((await read(db, account.address)).name).toBe('Satoshi_2009')
  })

  it('removes a name on a signed request, and frees it', async () => {
    const { db, sqlite } = database()
    const account = newAccount()
    const wallet = account.address.toLowerCase()
    expect((await change(db, account, 'Satoshi_2009')).status).toBe(200)
    clock.advance(NAME_CHANGE_SECONDS)

    const removed = await change(db, account, null)
    expect(removed.status).toBe(200)
    expect(await removed.json()).toEqual({ wallet, name: null, updatedAt: NOW + NAME_CHANGE_SECONDS })
    expect(await read(db, account.address)).toEqual({ wallet, name: null, updatedAt: NOW + NAME_CHANGE_SECONDS })
    // The row stays, without a name: it is what remembers when the wallet last changed it.
    expect(sqlite.prepare('SELECT name, name_key, updated_at FROM wallet_names WHERE wallet = ?').all(wallet).map((row) => ({ ...row }))).toEqual([
      { name: null, name_key: null, updated_at: NOW + NAME_CHANGE_SECONDS },
    ])
    // Another wallet can take the name now.
    expect((await change(db, newAccount(), 'satoshi_2009')).status).toBe(200)
    // And the wallet can take a new one, ten minutes on.
    clock.advance(NAME_CHANGE_SECONDS)
    expect((await change(db, account, 'Hal_Finney')).status).toBe(200)
  })

  it('needs the removal signed by the wallet itself, as a removal', async () => {
    const { db } = database()
    const account = newAccount()
    expect((await change(db, account, 'Satoshi_2009')).status).toBe(200)
    clock.advance(NAME_CHANGE_SECONDS)
    const issuedAt = Math.floor(Date.now() / 1000)
    // A stranger's signature over the wallet's removal text.
    const forged = await newAccount().signMessage({ message: nameSigningText({ wallet: account.address, name: null, issuedAt }) })
    expect((await send(db, account.address, { name: null, issuedAt, signature: forged })).status).toBe(403)
    // The wallet's signature for setting a name is not one for removing it.
    const setting = await signed(account, 'Satoshi_2009', issuedAt)
    expect((await send(db, account.address, { ...setting, name: null })).status).toBe(403)
    expect((await read(db, account.address)).name).toBe('Satoshi_2009')
  })

  it('cannot bring a removed name back with the request that once set it', async () => {
    const { db } = database()
    const account = newAccount()
    const setting = await signed(account, 'Satoshi_2009', NOW + ISSUED_AT_WINDOW)
    expect((await send(db, account.address, setting)).status).toBe(200)
    clock.advance(NAME_CHANGE_SECONDS)
    expect((await change(db, account, null)).status).toBe(200)
    for (const later of [0, 1, 300, 600, 601]) {
      clock.set(NOW + NAME_CHANGE_SECONDS + later)
      expect((await send(db, account.address, setting)).status, String(later)).not.toBe(200)
      expect((await read(db, account.address)).name).toBeNull()
    }
  })

  it('answers 409 to a removal when the wallet has no name', async () => {
    const { db, sqlite } = database()
    const account = newAccount()
    const response = await change(db, account, null)
    expect(response.status).toBe(409)
    expect(await errorOf(response)).toBe('This wallet has no display name to remove.')
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM wallet_names').get()).toMatchObject({ n: 0 })
  })

  it('stores nothing for a refused request', async () => {
    const { db, sqlite } = database()
    const account = newAccount()
    for (const name of ['ab', 'admin', 'two words', '0xabcdef', "x'); DROP TABLE wallet_names;--"]) {
      const issuedAt = Math.floor(Date.now() / 1000)
      // Signed all the same, as a client that skips the page's own check would.
      const signature = await account.signMessage({ message: nameSigningText({ wallet: account.address, name, issuedAt }) })
      expect((await send(db, account.address, { name, issuedAt, signature })).status, name).toBe(400)
    }
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM wallet_names').get()).toMatchObject({ n: 0 })
  })
})

describe('names where authors are listed', () => {
  useClock()

  const insertMessage = (sqlite: DatabaseSync, author: string, body: string, room = 'public') =>
    sqlite
      .prepare('INSERT INTO chat_messages (chain, token, author, body, created_at, signature, room) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('bsc', TOKEN, author.toLowerCase(), body, NOW, `sig-${author}-${body}-${room}`, room)
  const insertCallout = (sqlite: DatabaseSync, author: string, id: number) =>
    sqlite
      .prepare(
        `INSERT INTO callouts (id, chain, token, author, kind, url, link_hash, profile, note, signature, created_at, call_mcap, call_balance, held_balance)
VALUES (?, 'bsc', ?, ?, 0, ?, ?, 'x:someuser', '', ?, ?, 40000, '1000', '1000')`,
      )
      .run(id, TOKEN, author.toLowerCase(), `https://x.com/someuser/status/${id}`, `0x${id.toString(16).padStart(64, '0')}`, `callout-sig-${id}`, NOW)

  it('gives each chat message its author’s name, in both rooms, and null where there is none', async () => {
    const { db, sqlite } = database()
    const named = newAccount()
    const plain = newAccount()
    expect((await change(db, named, 'Satoshi_2009')).status).toBe(200)
    insertMessage(sqlite, named.address, 'gm')
    insertMessage(sqlite, plain.address, 'gm back')
    insertMessage(sqlite, named.address, 'holding', 'holders')

    const room = `https://callz.test/api/chat/bsc/${TOKEN}`
    const list = async (url: string) => ((await (await handleChat(new Request(url), { DB: db })).json()) as { messages: Array<Record<string, unknown>> }).messages
    expect(await list(room)).toEqual([
      { id: 1, author: named.address.toLowerCase(), authorName: 'Satoshi_2009', authorClan: null, body: 'gm', createdAt: NOW },
      { id: 2, author: plain.address.toLowerCase(), authorName: null, authorClan: null, body: 'gm back', createdAt: NOW },
    ])
    // The poll for newer messages carries it too, and so does the holder room.
    expect(await list(`${room}?after=1`)).toEqual([{ id: 2, author: plain.address.toLowerCase(), authorName: null, authorClan: null, body: 'gm back', createdAt: NOW }])
    expect(await list(`${room}?room=holders`)).toEqual([{ id: 3, author: named.address.toLowerCase(), authorName: 'Satoshi_2009', authorClan: null, body: 'holding', createdAt: NOW }])
  })

  it('shows the name a wallet has now on what it posted before, and none once it is removed', async () => {
    const { db, sqlite } = database()
    const account = newAccount()
    insertMessage(sqlite, account.address, 'gm')
    const names = async () =>
      ((await (await handleChat(new Request(`https://callz.test/api/chat/bsc/${TOKEN}`), { DB: db })).json()) as { messages: Array<{ authorName: string | null }> }).messages.map(
        (message) => message.authorName,
      )
    expect(await names()).toEqual([null])
    expect((await change(db, account, 'First_name')).status).toBe(200)
    expect(await names()).toEqual(['First_name'])
    clock.advance(NAME_CHANGE_SECONDS)
    expect((await change(db, account, 'Second_name')).status).toBe(200)
    expect(await names()).toEqual(['Second_name'])
    clock.advance(NAME_CHANGE_SECONDS)
    expect((await change(db, account, null)).status).toBe(200)
    expect(await names()).toEqual([null])
  })

  it('gives each callout its author’s name, in the feed and in the review queue', async () => {
    const { db, sqlite } = database()
    const named = newAccount()
    const plain = newAccount()
    expect((await change(db, named, 'Satoshi_2009')).status).toBe(200)
    insertCallout(sqlite, named.address, 1)
    insertCallout(sqlite, plain.address, 2)

    const feed = await handleCallouts(new Request(`https://callz.test/api/callouts/bsc/${TOKEN}`), { DB: db })
    expect(feed.status).toBe(200)
    const { callouts } = (await feed.json()) as { callouts: Array<Record<string, unknown>> }
    expect(callouts.map(({ id, author, authorName }) => ({ id, author, authorName }))).toEqual([
      { id: 2, author: plain.address.toLowerCase(), authorName: null },
      { id: 1, author: named.address.toLowerCase(), authorName: 'Satoshi_2009' },
    ])
    // Everything else a callout carried, it still carries.
    expect(callouts[1]).toMatchObject({ kind: 0, url: 'https://x.com/someuser/status/1', status: 'pending', createdAt: NOW, callMcap: 40000, callBalance: '1000', position: 'open' })

    const review = await handleCallouts(new Request('https://callz.test/api/callouts/bsc/review'), {
      DB: db,
      CALLOUT_ATTESTER: newAccount().address,
      CALLZ_VAULT: newAccount().address,
    })
    expect(review.status).toBe(200)
    const queue = ((await review.json()) as { callouts: Array<Record<string, unknown>> }).callouts
    expect(queue.map(({ id, authorName, token }) => ({ id, authorName, token }))).toEqual([
      { id: 2, authorName: null, token: TOKEN },
      { id: 1, authorName: 'Satoshi_2009', token: TOKEN },
    ])
  })
})
