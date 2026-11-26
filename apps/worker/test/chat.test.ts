import { stringToHex, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import {
  ISSUED_AT_WINDOW,
  MAX_BODY_LENGTH,
  canonicalSignature,
  chatSigningText,
  cleanBody,
  handleChat,
  issuedAtInWindow,
  containsLink,
  parseChatPost,
  verifyChatSignature,
} from '../src/chat.js'

const TOKEN = '0x000000000000000000000000000000000000dEaD'
const NOW = 1_800_000_000
const CURVE_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

/** A fresh wallet for each test: no key is ever written down. */
const newAccount = () => privateKeyToAccount(generatePrivateKey())

/** The other valid form of a signature: `s` mirrored in the curve order, recovery bit flipped. */
function twin(signature: Hex): Hex {
  const s = CURVE_ORDER - BigInt(`0x${signature.slice(66, 130)}`)
  const recovery = signature.slice(130) === '1b' ? '1c' : '1b'
  return `0x${signature.slice(2, 66)}${s.toString(16).padStart(64, '0')}${recovery}`
}

describe('cleanBody', () => {
  const REMOVED_RANGES: ReadonlyArray<[number, number]> = [
    [0x0000, 0x001f],
    [0x007f, 0x009f],
    [0x200b, 0x200f],
    [0x202a, 0x202e],
    [0x2066, 0x2069],
  ]

  it('removes every control and invisible character', () => {
    for (const [first, last] of REMOVED_RANGES) {
      for (let code = first; code <= last; code++) {
        expect(cleanBody(`a${String.fromCharCode(code)}b`), `U+${code.toString(16).padStart(4, '0')}`).toBe('ab')
      }
    }
  })

  it('keeps the characters on either side of each removed range', () => {
    // U+0020 is a space, which is trimmed at the ends, so it is checked inside a word.
    for (const code of [0x0020, 0x007e, 0x00a1, 0x200a, 0x2010, 0x2029, 0x202f, 0x2065, 0x206a]) {
      const character = String.fromCharCode(code)
      expect(cleanBody(`a${character}b`)).toBe(`a${character}b`)
    }
  })

  it('makes a message one line and trims it', () => {
    expect(cleanBody('  gm\r\n\tfrens  ')).toBe('gmfrens')
    expect(cleanBody('​  hello world ‮')).toBe('hello world')
    expect(cleanBody('one  two')).toBe('one  two')
  })

  it('keeps emoji and other scripts, and drops unpaired surrogates', () => {
    expect(cleanBody('to the 🚀 月 달')).toBe('to the 🚀 月 달')
    expect(cleanBody('a\ud83db')).toBe('ab')
    expect(cleanBody('a\ude80b')).toBe('ab')
  })

  it('leaves nothing of a message made only of removed characters', () => {
    expect(cleanBody(' \u0000​⁦\n ')).toBe('')
  })

  it('changes nothing the second time', () => {
    const once = cleanBody('  ‮reversed‬ text\u0007  ')
    expect(cleanBody(once)).toBe(once)
  })
})

describe('chatSigningText', () => {
  it('is exactly the text the wallet shows', () => {
    expect(chatSigningText({ chain: 'bsc', token: TOKEN.toLowerCase(), body: 'gm', issuedAt: NOW })).toBe(
      'CallZ chat\n\nToken: 0x000000000000000000000000000000000000dead\nNetwork: bsc\nTime: 1800000000\n\ngm',
    )
  })

  it('names the network and writes the token in lowercase', () => {
    expect(chatSigningText({ chain: 'bscTestnet', token: TOKEN, body: 'hello world', issuedAt: 1 })).toBe(
      'CallZ chat\n\nToken: 0x000000000000000000000000000000000000dead\nNetwork: bscTestnet\nTime: 1\n\nhello world',
    )
  })
})

describe('issuedAtInWindow', () => {
  it('accepts a time up to five minutes early or late', () => {
    expect(ISSUED_AT_WINDOW).toBe(300)
    expect(issuedAtInWindow(NOW, NOW)).toBe(true)
    expect(issuedAtInWindow(NOW - 300, NOW)).toBe(true)
    expect(issuedAtInWindow(NOW + 300, NOW)).toBe(true)
  })

  it('rejects a time further away than that', () => {
    expect(issuedAtInWindow(NOW - 301, NOW)).toBe(false)
    expect(issuedAtInWindow(NOW + 301, NOW)).toBe(false)
    expect(issuedAtInWindow(0, NOW)).toBe(false)
    // Milliseconds sent where seconds belong.
    expect(issuedAtInWindow(NOW * 1000, NOW)).toBe(false)
  })

  it('rejects anything that is not a whole number of seconds', () => {
    expect(issuedAtInWindow(NOW + 0.5, NOW)).toBe(false)
    expect(issuedAtInWindow(Number.NaN, NOW)).toBe(false)
    expect(issuedAtInWindow(Number.POSITIVE_INFINITY, NOW)).toBe(false)
  })
})

describe('canonicalSignature', () => {
  it('leaves a wallet signature as it is, in lowercase', async () => {
    const signature = await newAccount().signMessage({ message: 'gm' })
    expect(canonicalSignature(signature)).toBe(signature)
    expect(canonicalSignature(`0x${signature.slice(2).toUpperCase()}`)).toBe(signature)
  })

  it('gives both spellings of the recovery byte the same form', async () => {
    const signature = await newAccount().signMessage({ message: 'gm' })
    const parity = signature.slice(130) === '1b' ? '00' : '01'
    expect(canonicalSignature(`${signature.slice(0, 130)}${parity}`)).toBe(signature)
  })

  it('gives a signature and its twin the same form', async () => {
    const signature = await newAccount().signMessage({ message: 'gm' })
    expect(twin(signature)).not.toBe(signature)
    expect(canonicalSignature(twin(signature))).toBe(signature)
  })

  it('rejects anything that is not a 65-byte signature', async () => {
    const signature = await newAccount().signMessage({ message: 'gm' })
    expect(canonicalSignature(signature.slice(0, -2))).toBeNull()
    expect(canonicalSignature(`${signature}00`)).toBeNull()
    expect(canonicalSignature(signature.slice(2))).toBeNull()
    expect(canonicalSignature(`${signature.slice(0, 130)}1d`)).toBeNull()
    expect(canonicalSignature(`0x${'zz'.repeat(65)}`)).toBeNull()
    // `s` must be between 1 and the curve order.
    expect(canonicalSignature(`0x${'11'.repeat(32)}${'00'.repeat(32)}1b`)).toBeNull()
    expect(canonicalSignature(`0x${'11'.repeat(32)}${'ff'.repeat(32)}1b`)).toBeNull()
    expect(canonicalSignature(undefined)).toBeNull()
    expect(canonicalSignature(27)).toBeNull()
  })
})

describe('verifyChatSignature', () => {
  const fields = { chain: 'bsc', token: TOKEN.toLowerCase(), body: 'to the 🚀', issuedAt: NOW } as const

  it('accepts the author’s signature over the signing text', async () => {
    const account = newAccount()
    const signature = await account.signMessage({ message: chatSigningText(fields) })
    expect(await verifyChatSignature({ ...fields, author: account.address.toLowerCase(), signature })).toBe(true)
    // The address may come in its checksummed spelling too.
    expect(await verifyChatSignature({ ...fields, author: account.address, signature })).toBe(true)
  })

  it('accepts what a browser wallet returns for personal_sign over the UTF-8 bytes', async () => {
    const account = newAccount()
    // The page hands the wallet the text as 0x hex; the wallet signs those bytes.
    const signature = await account.signMessage({ message: { raw: stringToHex(chatSigningText(fields)) } })
    expect(await verifyChatSignature({ ...fields, author: account.address, signature })).toBe(true)
  })

  it('accepts the twin of a signature once it is in canonical form', async () => {
    const account = newAccount()
    const signature = await account.signMessage({ message: chatSigningText(fields) })
    const canonical = canonicalSignature(twin(signature))
    expect(canonical).not.toBeNull()
    expect(await verifyChatSignature({ ...fields, author: account.address, signature: canonical! })).toBe(true)
  })

  it('rejects a signature from another wallet', async () => {
    const signature = await newAccount().signMessage({ message: chatSigningText(fields) })
    expect(await verifyChatSignature({ ...fields, author: newAccount().address, signature })).toBe(false)
  })

  it('rejects a signature when any signed field differs', async () => {
    const account = newAccount()
    const signature = await account.signMessage({ message: chatSigningText(fields) })
    const signed = { ...fields, author: account.address, signature }
    expect(await verifyChatSignature({ ...signed, body: 'to the 🚀!' })).toBe(false)
    expect(await verifyChatSignature({ ...signed, issuedAt: NOW + 1 })).toBe(false)
    expect(await verifyChatSignature({ ...signed, chain: 'bscTestnet' })).toBe(false)
    expect(await verifyChatSignature({ ...signed, token: '0x000000000000000000000000000000000000beef' })).toBe(false)
  })

  it('rejects bytes that are not a signature, without throwing', async () => {
    const author = newAccount().address
    expect(await verifyChatSignature({ ...fields, author, signature: `0x${'00'.repeat(65)}` })).toBe(false)
    expect(await verifyChatSignature({ ...fields, author, signature: `0x${'ff'.repeat(64)}1b` })).toBe(false)
    expect(await verifyChatSignature({ ...fields, author, signature: '0x1234' })).toBe(false)
  })
})

describe('parseChatPost', () => {
  const signed = async (body: string) => {
    const account = newAccount()
    const signature = await account.signMessage({
      message: chatSigningText({ chain: 'bsc', token: TOKEN, body: cleanBody(body), issuedAt: NOW }),
    })
    return { author: account.address, body, issuedAt: NOW, signature }
  }
  const errorOf = (input: unknown) => {
    const parsed = parseChatPost(input)
    return parsed.ok ? null : parsed.error
  }

  it('returns the fields as they are verified and stored', async () => {
    const input = await signed('  gm​ frens\n ')
    const parsed = parseChatPost(input)
    expect(parsed).toEqual({
      ok: true,
      post: { author: input.author.toLowerCase(), body: 'gm frens', issuedAt: NOW, signature: input.signature },
    })
    if (parsed.ok) expect(await verifyChatSignature({ chain: 'bsc', token: TOKEN, ...parsed.post })).toBe(true)
  })

  it('accepts a message of exactly the longest length, counted in characters', async () => {
    expect(MAX_BODY_LENGTH).toBe(280)
    expect(parseChatPost(await signed('a'.repeat(280))).ok).toBe(true)
    // An emoji is one character, though it takes two UTF-16 units.
    expect(parseChatPost(await signed('🚀'.repeat(280))).ok).toBe(true)
  })

  it('rejects a message that is empty or too long once cleaned', async () => {
    expect(errorOf(await signed(' ​\n '))).toBe('The message is empty.')
    expect(errorOf(await signed(''))).toBe('The message is empty.')
    expect(errorOf(await signed('a'.repeat(281)))).toBe('The message is longer than 280 characters.')
    // Removed characters do not count towards the length.
    expect(parseChatPost(await signed(`${'a'.repeat(280)}​​`)).ok).toBe(true)
  })

  it('rejects a body that is not a JSON object with the four fields', async () => {
    const good = await signed('gm')
    expect(errorOf(null)).toMatch(/JSON object/)
    expect(errorOf([good])).toMatch(/JSON object/)
    expect(errorOf('gm')).toMatch(/JSON object/)
    expect(errorOf({ ...good, author: good.author.slice(0, -1) })).toBe('author must be a 0x address.')
    expect(errorOf({ ...good, author: good.author.slice(2) })).toBe('author must be a 0x address.')
    expect(errorOf({ ...good, author: undefined })).toBe('author must be a 0x address.')
    expect(errorOf({ ...good, body: 42 })).toBe('body must be text.')
    expect(errorOf({ ...good, issuedAt: String(NOW) })).toMatch(/issuedAt/)
    expect(errorOf({ ...good, issuedAt: NOW + 0.5 })).toMatch(/issuedAt/)
    expect(errorOf({ ...good, issuedAt: -1 })).toMatch(/issuedAt/)
    expect(errorOf({ ...good, signature: '0x' })).toMatch(/65-byte signature/)
    expect(errorOf({ ...good, signature: undefined })).toMatch(/65-byte signature/)
  })
})

// These requests are all turned away before the database is read, so none is given one.
describe('handleChat, before the database', () => {
  const noDatabase = new Proxy(
    {},
    {
      get() {
        throw new Error('the database must not be reached')
      },
    },
  ) as Parameters<typeof handleChat>[1]
  const ROOM = `https://callz.test/api/chat/bsc/${TOKEN}`

  const send = (url: string, init?: RequestInit) => handleChat(new Request(url, init), noDatabase)
  const postJson = (body: string, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
    send(ROOM, { method: 'POST', headers, body })
  const errorOf = async (response: Response) => ((await response.json()) as { error: string }).error

  it('answers 405 to any method but GET, HEAD and POST', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await send(ROOM, { method })
      expect(response.status, method).toBe(405)
      expect(response.headers.get('allow')).toBe('GET, HEAD, POST')
      expect(await errorOf(response)).toBe('Method not allowed.')
    }
  })

  it('answers 404 to an unknown network or path, and 400 to a token that is not an address', async () => {
    expect((await send(`https://callz.test/api/chat/eth/${TOKEN}`)).status).toBe(404)
    expect((await send('https://callz.test/api/chat/bsc')).status).toBe(404)
    expect((await send(`${ROOM}/extra`)).status).toBe(404)
    expect((await send('https://callz.test/api/chat/bsc/0x1234')).status).toBe(400)
  })

  it('answers 400 to a POST that is not application/json', async () => {
    expect((await postJson('{}', { 'content-type': 'text/plain' })).status).toBe(400)
    expect((await postJson('{}', {})).status).toBe(400)
    expect((await postJson('author=0x', { 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(400)
  })

  it('answers 400 to malformed JSON and to a body of the wrong shape', async () => {
    expect((await postJson('{"author":')).status).toBe(400)
    expect((await postJson('')).status).toBe(400)
    expect((await postJson('[]')).status).toBe(400)
    const response = await postJson('{}', { 'content-type': 'application/json; charset=utf-8' })
    expect(response.status).toBe(400)
    expect(await errorOf(response)).toBe('author must be a 0x address.')
  })

  it('answers 413 to a request body over 4 KB', async () => {
    const response = await postJson(JSON.stringify({ body: 'a'.repeat(4096) }))
    expect(response.status).toBe(413)
    expect(await errorOf(response)).toBe('The request is larger than 4 KB.')
  })

  it('answers 400 to a message signed outside the five minute window', async () => {
    const account = newAccount()
    const issuedAt = Math.floor(Date.now() / 1000) - 301
    const signature = await account.signMessage({ message: chatSigningText({ chain: 'bsc', token: TOKEN, body: 'gm', issuedAt }) })
    const response = await postJson(JSON.stringify({ author: account.address, body: 'gm', issuedAt, signature }))
    expect(response.status).toBe(400)
    expect(await errorOf(response)).toMatch(/5 minutes/)
  })

  it('answers 403 to a message signed by another wallet', async () => {
    const issuedAt = Math.floor(Date.now() / 1000)
    const signature = await newAccount().signMessage({ message: chatSigningText({ chain: 'bsc', token: TOKEN, body: 'gm', issuedAt }) })
    const response = await postJson(JSON.stringify({ author: newAccount().address, body: 'gm', issuedAt, signature }))
    expect(response.status).toBe(403)
  })

  it('sends errors as JSON that is never cached, with no CORS header', async () => {
    const response = await postJson('{}', { 'content-type': 'application/json', origin: 'https://elsewhere.example' })
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('links and injection', () => {
  it('refuses links, plain or dressed up', () => {
    for (const body of [
      'check https://example.com now',
      'http://evil.test/x',
      'www.example.org',
      'go to example.com',
      'join t.me/somegroup',
      'discord.gg/abc',
      'example[.]com',
      'example (dot) com',
      'example dot com',
      'example。com',
      'tg://resolve?domain=x',
      '1.2.3.4/login',
      'buy at pancake.finance',
    ]) {
      expect(containsLink(body), body).toBe(true)
      expect(parseChatPost({ author: `0x${'1'.repeat(40)}`, body, issuedAt: 1, signature: `0x${'1'.repeat(128)}1b` })).toEqual({
        ok: false,
        error: 'Links are not allowed in chat.',
      })
    }
  })

  it('lets ordinary messages through', () => {
    for (const body of ['gm', 'bought 0.05 BNB, up 3.5x', 'this is going to 1.5M mcap. LFG', 'e.g. the dev sold', '$KOALA to the moon!!', 'price 0.00012 now']) {
      expect(containsLink(body), body).toBe(false)
    }
  })

  it('keeps SQL and HTML as the plain text it is', () => {
    const body = `'; DROP TABLE chat_messages;-- <script>alert(1)</script> " OR 1=1`
    const parsed = parseChatPost({ author: `0x${'1'.repeat(40)}`, body, issuedAt: 1, signature: `0x${'1'.repeat(128)}1b` })
    // It is stored through a bound parameter and shown as a text node, so it stays exactly this string.
    expect(parsed).toMatchObject({ ok: true, post: { body } })
  })
})
