import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_PAGE_BYTES, MAX_PICTURE_BYTES, handlePreview, postDate, postWords, previewTarget, readPageMeta } from '../src/preview.js'
import { handleSession, sessionSigningText } from '../src/session.js'

const NOW = 1_800_000_000
const ORIGIN = 'https://callz.test'
const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url).href)

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
  return { db }
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 1, 2, 3, 4])
const html = (markup: string, headers: Record<string, string> = {}) => new Response(markup, { headers: { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'track=1', ...headers } })
const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } })

type Reply = Response | (() => Response) | Error

/**
 * The web as the Worker sees it, for the tests: the answer each address gives, and a record of every request
 * the Worker made.
 */
function setup(pages: Record<string, Reply> = {}) {
  const { db } = database()
  const env = { DB: db }
  const asked: Array<{ url: string; init: RequestInit }> = []
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    asked.push({ url, init })
    const reply = pages[url]
    if (reply === undefined) throw new Error(`nothing answers at ${url}`)
    if (reply instanceof Error) throw reply
    return typeof reply === 'function' ? reply() : reply.clone()
  }) as typeof fetch
  const waiting: Array<Promise<unknown>> = []
  const ctx = { waitUntil: (promise: Promise<unknown>) => void waiting.push(promise), passThroughOnException: () => undefined } as unknown as ExecutionContext

  let token: string | null = null
  const signIn = async (): Promise<string> => {
    if (token) return token
    const account = privateKeyToAccount(generatePrivateKey())
    const issuedAt = Math.floor(Date.now() / 1000)
    const signature = await account.signMessage({ message: sessionSigningText({ wallet: account.address, issuedAt }) })
    const response = await handleSession(
      new Request(`${ORIGIN}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: account.address, issuedAt, signature }) }),
      env,
    )
    expect(response.status).toBe(201)
    token = ((await response.json()) as { token: string }).token
    return token
  }

  /** One request to the API, signed in unless `signedIn` is false, answered with its status, headers and body. */
  const call = async (path: string, { signedIn = true, method = 'GET' }: { signedIn?: boolean; method?: string } = {}): Promise<{ status: number; body: any; headers: Headers }> => {
    const headers: Record<string, string> = signedIn ? { authorization: `Bearer ${await signIn()}` } : {}
    const response = await handlePreview(new Request(`${ORIGIN}${path}`, { method, headers }), env, ctx, fetcher)
    const type = response.headers.get('content-type') ?? ''
    return { status: response.status, body: type.startsWith('application/json') ? await response.json() : new Uint8Array(await response.arrayBuffer()), headers: response.headers }
  }
  const page = (url: string) => call(`/api/preview?url=${encodeURIComponent(url)}`)
  const picture = (url: string) => call(`/api/preview/image?url=${encodeURIComponent(url)}`)
  const post = (url: string) => call(`/api/preview/post?url=${encodeURIComponent(url)}`)
  return { env, ctx, asked, waiting, fetcher, call, page, picture, post }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW * 1000)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the address a preview may fetch', () => {
  it('refuses everything that is not a public web page', () => {
    const hostile: unknown[] = [
      // This machine and private networks, in every spelling of an address.
      'http://127.0.0.1',
      'https://127.0.0.1/',
      'https://127.1',
      'https://2130706433',
      'https://0x7f.1',
      'https://0x7f000001',
      'https://0177.0.0.1',
      'https://017700000001',
      'https://127.0.0.1.',
      'https://[::1]',
      'https://[::ffff:127.0.0.1]',
      'https://[fd00::1]',
      'https://[fe80::1%25eth0]',
      '[::1]',
      '127.0.0.1',
      '2130706433',
      'https://10.0.0.1',
      'https://192.168.1.1/admin',
      'https://169.254.169.254',
      'https://169.254.169.254/latest/meta-data/',
      'https://0.0.0.0',
      'https://1.1.1.1',
      'https://localhost',
      'https://LOCALHOST',
      'https://localhost.',
      'https://app.localhost',
      'localhost:8787',
      'https://example',
      'https://intranet',
      'example',
      'https://metadata.google.internal',
      'https://metadata.google.internal./computeMetadata/v1/',
      'https://printer.local',
      'https://router.lan',
      'https://nas.home',
      'https://1.0.0.127.in-addr.arpa',
      'https://something.onion',
      'https://site.test',
      'https://www.example',
      'https://nothing.invalid',
      'https://box.corp',
      'https://db.localdomain',
      // A top-level label that is not letters, and names that are not names.
      'https://example.c0m',
      'https://example.c',
      'https://example.123',
      'https://example.xn--p1ai',
      'https://exa_mple.com',
      'https://-example.com',
      'https://example-.com',
      'https://example..com',
      'https://.com',
      'https://example.com.',
      `https://${'a'.repeat(64)}.com`,
      // Somebody's name and password, and other ports.
      'https://user:pw@example.com',
      'https://user@example.com',
      'https://example.com@127.0.0.1',
      'https://127.0.0.1@example.com',
      'user:pw@example.com',
      'https://example.com:8443',
      'https://example.com:80',
      'https://example.com:22',
      'http://example.com:8080',
      'example.com:8443/path',
      // Other schemes.
      'ftp://example.com/file',
      'file:///etc/passwd',
      'gopher://example.com',
      'ws://example.com',
      'wss://example.com',
      'javascript:alert(1)',
      'JavaScript:alert(1)//example.com',
      'data:text/html,<script>alert(1)</script>',
      'mailto:someone@example.com',
      'tel:+15555550100',
      'blob:https://example.com/1',
      'view-source:https://example.com',
      '//example.com',
      '/etc/passwd',
      'https:///example.com',
      'https:/example.com',
      'https:example.com',
      'https://',
      // Characters parsers disagree on.
      'https://example.com\\@127.0.0.1',
      'https:\\\\example.com',
      'https://exam ple.com',
      'https://example.com/a b',
      'https://example.com/\nx',
      'https://example.com\t.evil.internal',
      'https://example.com/\u0000',
      'https://127.0.0.1#.example.com',
      'https://127.0.0.1?.example.com',
      'https://127.0.0.1/.example.com',
      'https://%31%32%37.0.0.1',
      'https://%6c%6f%63%61%6c%68%6f%73%74',
      'https://１２７.０.０.１',
      'https://ⓛⓞⓒⓐⓛⓗⓞⓢⓣ',
      // This site itself.
      'https://callz.fun/api/session',
      'https://www.callz.fun',
      'callz.fun',
      'http://CALLZ.FUN/api/preview?url=https://callz.fun',
      'https://api.callz.fun',
      'https://callz.someone.workers.dev',
      'https://workers.dev',
      // Too long, and nothing at all.
      `https://example.com/${'a'.repeat(2001 - 'https://example.com/'.length)}`,
      `example.com/${'a'.repeat(1995)}`,
      '',
      '   ',
      null,
      undefined,
      7,
      ['https://example.com'],
      { href: 'https://example.com' },
    ]
    for (const input of hostile) expect(previewTarget(input), String(input)).toBeNull()
  })

  it('reads a link as people type it into the one https address', () => {
    const longest = `https://example.com/${'a'.repeat(2000 - 'https://example.com/'.length)}`
    const friendly: Array<[string, string]> = [
      ['liquidlabs.io', 'https://liquidlabs.io/'],
      ['liquidlabs.io/work', 'https://liquidlabs.io/work'],
      ['LiquidLabs.io/Work?a=1#x', 'https://liquidlabs.io/Work?a=1'],
      ['http://example.com', 'https://example.com/'],
      ['HTTP://Example.COM/Path', 'https://example.com/Path'],
      ['http://example.com:80/a', 'https://example.com/a'],
      ['https://example.com:443/a', 'https://example.com/a'],
      ['example.com:443', 'https://example.com/'],
      ['  https://sub.domain.example.co.uk/a/b?c=d&e=f  ', 'https://sub.domain.example.co.uk/a/b?c=d&e=f'],
      ['https://x.com/jack/status/20', 'https://x.com/jack/status/20'],
      ['www.example.org/a:b', 'https://www.example.org/a:b'],
      ['https://xn--mnchen-3ya.de/', 'https://xn--mnchen-3ya.de/'],
      ['https://münchen.de/', 'https://xn--mnchen-3ya.de/'],
      [longest, longest],
    ]
    for (const [input, expected] of friendly) {
      const target = previewTarget(input)
      expect(target?.href, input).toBe(expected)
      expect(target?.protocol).toBe('https:')
      expect(target?.port).toBe('')
      expect(target?.username).toBe('')
    }
  })
})

describe('reading a page', () => {
  const NOTHING = { title: null, description: null, image: null, site: null }

  it('prefers Open Graph, then what X reads, then the title and description of the page', () => {
    expect(
      readPageMeta(`<!doctype html><html><head>
<title>Plain title</title>
<meta name="description" content="Plain description">
<meta name="twitter:title" content="Twitter title">
<meta name="twitter:description" content="Twitter description">
<meta name="twitter:image" content="/twitter.png">
<meta property="og:title" content="OG title">
<meta property="og:description" content="OG description">
<meta property="og:image" content="/og.png">
<meta property="og:site_name" content="Liquid Labs">
</head><body></body></html>`),
    ).toEqual({ title: 'OG title', description: 'OG description', image: '/og.png', site: 'Liquid Labs' })

    expect(
      readPageMeta(`<head><title>Plain title</title><meta name="description" content="Plain description">
<META NAME='Twitter:Title' CONTENT='Twitter title'><meta content="Twitter description" name=twitter:description><meta name="twitter:image:src" content=https://cdn.example.com/t.png></head>`),
    ).toEqual({ title: 'Twitter title', description: 'Twitter description', image: 'https://cdn.example.com/t.png', site: null })

    expect(readPageMeta('<html><head><title>\n  Plain   title\n</title><meta name="description" content="Plain description"></head></html>')).toEqual({
      ...NOTHING,
      title: 'Plain title',
      description: 'Plain description',
    })
    expect(readPageMeta('<p>No head at all</p>')).toEqual(NOTHING)
    expect(readPageMeta('')).toEqual(NOTHING)
    // An empty tag does not hide the one after it.
    expect(readPageMeta('<meta property="og:title" content="  "><meta property="og:title" content="Second"><title>Third</title>').title).toBe('Second')
    expect(readPageMeta('<meta property="og:title" content=""><title>Third</title>').title).toBe('Third')
  })

  it('reads character references back into characters, once', () => {
    const meta = readPageMeta(
      '<title>Tom &amp; Jerry&#39;s &quot;caf&#xE9;&quot; &mdash; &lt;b&gt;bold&lt;/b&gt; &#x1F525; &amp;lt; &bogus; &#99999999;</title><meta name="description" content="1 &lt; 2 &amp;&amp; 3 &gt; 2&nbsp;&hellip;">',
    )
    expect(meta.title).toBe('Tom & Jerry\'s "café" — <b>bold</b> \u{1F525} &lt; &bogus; &#99999999;')
    expect(meta.description).toBe('1 < 2 && 3 > 2 …')
  })

  it('hands markup in a title on as letters, and takes out what cannot be seen', () => {
    const meta = readPageMeta(
      '<head><title><script>alert(1)</script></title><meta property="og:description" content="&lt;img src=x onerror=alert(1)&gt; <script>alert(2)</script>‮gnp.exe​\u0007\r\n  next   line"></head>',
    )
    expect(meta.title).toBe('<script>alert(1)</script>')
    expect(meta.description).toBe('<img src=x onerror=alert(1)> <script>alert(2)</script>gnp.exe next line')
    expect(readPageMeta('<meta property="og:title" content="&#60;script&#62;alert(1)&#60;/script&#62;">').title).toBe('<script>alert(1)</script>')
  })

  it('caps a title at 200 characters and a description at 300', () => {
    const meta = readPageMeta(`<title>${'t'.repeat(500)}</title><meta name="description" content="${'\u{1F525}'.repeat(400)}">`)
    expect(meta.title).toBe('t'.repeat(200))
    expect([...(meta.description ?? '')]).toHaveLength(300)
    expect(readPageMeta(`<meta property="og:title" content="${'o'.repeat(500)}">`).title).toBe('o'.repeat(200))
  })

  it('does not take a tag written inside a comment, a script or another tag for a tag of the page', () => {
    const meta = readPageMeta(`<head>
<!-- <meta property="og:title" content="In a comment"> -->
<script>var s = '<meta property="og:title" content="In a script"><title>Script title</title>'</script>
<style>/* <meta property="og:title" content="In a style"> */</style>
<noscript><meta property="og:title" content="In noscript"></noscript>
<svg><title>Icon</title></svg>
<link rel="x" href="a>b" data-x='<meta property="og:title" content="In an attribute">'>
<meta name="x" content="a > b"><meta http-equiv="refresh" content="0; url=https://evil.example.com/">
<title>Real title</title>
<meta property="og:description" content='She said "hi" > bye'>
</head>`)
    expect(meta).toEqual({ title: 'Real title', description: 'She said "hi" > bye', image: null, site: null })
    // Markup that never closes ends the reading; it does not hang it.
    expect(readPageMeta('<title>Kept</title><script>never closed <meta property="og:title" content="no">').title).toBe('Kept')
    expect(readPageMeta('<meta property="og:title" content="never closed').title).toBe('never closed')
    expect(readPageMeta(`${'<meta '.repeat(20_000)}<title>after</title>`).title).toBeNull()
    expect(readPageMeta('<'.repeat(100_000))).toEqual(NOTHING)
    expect(readPageMeta(`${'<a "'.repeat(50_000)}`)).toEqual(NOTHING)
  })
})

describe('GET /api/preview', () => {
  const PAGE = `<!doctype html><html><head><title>Liquid Labs</title>
<meta property="og:title" content="Our work &amp; play">
<meta property="og:description" content="What we   built.">
<meta property="og:image" content="/img/cover.png?v=2">
<meta property="og:site_name" content="Liquid Labs">
<meta http-equiv="refresh" content="0; url=https://127.0.0.1/">
</head><body><script>alert(1)</script></body></html>`

  it('answers with the page as plain text and one https picture address, and sends nothing of the visitor', async () => {
    const { page, asked } = setup({ 'https://liquidlabs.io/work': html(PAGE) })
    const preview = await page('liquidlabs.io/work#team')
    expect(preview.status).toBe(200)
    expect(preview.body).toEqual({
      url: 'https://liquidlabs.io/work',
      site: 'Liquid Labs',
      title: 'Our work & play',
      description: 'What we built.',
      image: 'https://liquidlabs.io/img/cover.png?v=2',
    })
    // Nothing of the upstream answer but those five values.
    expect(Object.fromEntries(preview.headers)).toEqual({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })

    // One request, for the page alone: the refresh in it was not followed, and neither was the picture fetched.
    expect(asked).toHaveLength(1)
    const { url, init } = asked[0]!
    expect(url).toBe('https://liquidlabs.io/work')
    expect(init.redirect).toBe('manual')
    expect(init.method).toBe('GET')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.body).toBeUndefined()
    expect(init.credentials).toBeUndefined()
    const sent = new Headers(init.headers)
    expect([...sent.keys()].sort()).toEqual(['accept', 'user-agent'])
    expect(sent.get('user-agent')).toBe('CallZ-LinkPreview/1.0 (+https://callz.fun)')
    expect(sent.get('accept')).toContain('text/html')
  })

  it('needs a session, a GET and an address it may fetch', async () => {
    const { call, asked } = setup({ 'https://liquidlabs.io/': html(PAGE) })
    for (const path of ['/api/preview?url=liquidlabs.io', '/api/preview/post?url=https://x.com/jack/status/20', '/api/preview/image?url=https://liquidlabs.io/a.png']) {
      const signedOut = await call(path, { signedIn: false })
      expect(signedOut.status).toBe(401)
      expect(signedOut.body).toEqual({ error: 'Sign in with your wallet first.' })
      expect((await call(path, { method: 'POST' })).status).toBe(405)
      expect((await call(path, { method: 'DELETE' })).status).toBe(405)
    }
    const stale = await handlePreview(new Request(`${ORIGIN}/api/preview?url=liquidlabs.io`, { headers: { authorization: `Bearer ${'f'.repeat(64)}` } }), { DB: database().db }, {} as ExecutionContext, fetch)
    expect(stale.status).toBe(401)

    const hostile = ['http://127.0.0.1', 'https://2130706433', 'https://[::1]', 'https://localhost', 'https://169.254.169.254/latest', 'https://metadata.google.internal', 'https://user:pw@example.com', 'https://example.com:8443', 'ftp://example.com', 'javascript:alert(1)', 'https://callz.fun/api/session', 'https://callz.test/api/session', '']
    for (const bad of hostile) {
      for (const route of ['/api/preview', '/api/preview/image', '/api/preview/post']) {
        const refused = await call(`${route}?url=${encodeURIComponent(bad)}`)
        expect(refused.status, `${route} ${bad}`).toBe(400)
        expect(typeof refused.body.error).toBe('string')
      }
    }
    expect((await call('/api/preview')).status).toBe(400)
    expect((await call('/api/preview/nothing?url=liquidlabs.io')).status).toBe(404)
    expect((await call('/api/preview/image/extra?url=liquidlabs.io')).status).toBe(404)
    // None of that reached another server.
    expect(asked).toEqual([])
  })

  it('follows a redirect only to where it may go itself', async () => {
    const { page, asked } = setup({
      'https://short.example.org/a': redirect('https://liquidlabs.io/work', 301),
      'https://liquidlabs.io/work': html(PAGE),
      'https://relative.example.org/a/b': redirect('../work?x=1', 307),
      'https://relative.example.org/work?x=1': html('<title>Moved here</title>'),
      'https://plain.example.org/': redirect('http://liquidlabs.io/work'),
      'https://evil.example.org/1': redirect('http://127.0.0.1/admin'),
      'https://evil.example.org/2': redirect('https://169.254.169.254/latest/meta-data/'),
      'https://evil.example.org/3': redirect('//metadata.google.internal/computeMetadata/v1/'),
      'https://evil.example.org/4': redirect('https://[::1]/'),
      'https://evil.example.org/5': redirect('https://liquidlabs.io:8443/work'),
      'https://evil.example.org/6': redirect('https://user:pw@liquidlabs.io/work'),
      'https://evil.example.org/7': redirect('ftp://liquidlabs.io/work'),
      'https://evil.example.org/8': redirect('https://callz.fun/api/session'),
      'https://evil.example.org/9': redirect('https://2130706433/'),
      'https://evil.example.org/10': new Response(null, { status: 302 }),
      'https://evil.example.org/11': redirect('javascript:alert(1)'),
      'https://evil.example.org/12': redirect('https://localhost/'),
    })
    expect((await page('https://short.example.org/a')).body).toMatchObject({ url: 'https://liquidlabs.io/work', title: 'Our work & play' })
    expect((await page('https://relative.example.org/a/b')).body).toMatchObject({ url: 'https://relative.example.org/work?x=1', site: 'relative.example.org', title: 'Moved here' })
    // A redirect to http is asked over https, or not at all.
    expect((await page('https://plain.example.org/')).body.url).toBe('https://liquidlabs.io/work')
    asked.length = 0

    for (let n = 1; n <= 12; n++) {
      const refused = await page(`https://evil.example.org/${n}`)
      expect(refused.status, String(n)).toBe(502)
      expect(refused.body).toEqual({ error: 'That page could not be reached.' })
    }
    // Twelve requests: each first address, and never the place it pointed at.
    expect(asked.map(({ url }) => url)).toEqual(Array.from({ length: 12 }, (_, index) => `https://evil.example.org/${index + 1}`))
  })

  it('follows three redirects and refuses the fourth', async () => {
    const hops = (count: number): Record<string, Reply> => {
      const pages: Record<string, Reply> = {}
      for (let n = 0; n < count; n++) pages[`https://hop.example.org/${n}`] = redirect(`/${n + 1}`)
      pages[`https://hop.example.org/${count}`] = html('<title>The end</title>')
      return pages
    }
    const three = setup(hops(3))
    expect((await three.page('https://hop.example.org/0')).body).toMatchObject({ url: 'https://hop.example.org/3', title: 'The end' })
    expect(three.asked).toHaveLength(4)

    const four = setup(hops(4))
    expect((await four.page('https://hop.example.org/0')).status).toBe(502)
    expect(four.asked.map(({ url }) => url)).toEqual([0, 1, 2, 3].map((n) => `https://hop.example.org/${n}`))

    const loop = setup({ 'https://loop.example.org/': redirect('https://loop.example.org/') })
    expect((await loop.page('https://loop.example.org/')).status).toBe(502)
    expect(loop.asked).toHaveLength(4)
  })

  it('reads the first 256 KB of a page and cancels the rest', async () => {
    let pulled = 0
    let cancelled = false
    const chunk = new TextEncoder().encode('x'.repeat(65_536))
    const endless = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('<head><title>Early title</title>'))
          },
          pull(controller) {
            pulled++
            if (pulled > 1000) throw new Error('the body was read without end')
            controller.enqueue(chunk)
          },
          cancel() {
            cancelled = true
          },
        }),
        { headers: { 'content-type': 'text/html' } },
      )
    const late = `<head>${' '.repeat(MAX_PAGE_BYTES)}<title>Late title</title><meta property="og:title" content="Late"></head>`
    const { page } = setup({ 'https://big.example.org/': endless, 'https://late.example.org/': html(late) })
    expect((await page('https://big.example.org/')).body).toMatchObject({ title: 'Early title' })
    expect(cancelled).toBe(true)
    expect(pulled).toBeLessThan(20)
    // What stands past the cap was never read.
    const nothing = await page('https://late.example.org/')
    expect(nothing.status).toBe(404)
    expect(nothing.body).toEqual({ error: 'That page has nothing to show as a preview.' })
  })

  it('reads nothing that is not HTML, and answers 404 for a page with nothing to show', async () => {
    const tags = '<title>Not a page</title><meta property="og:title" content="Not a page">'
    const { page } = setup({
      'https://files.example.org/data.json': new Response(JSON.stringify({ html: tags }), { headers: { 'content-type': 'application/json' } }),
      'https://files.example.org/notes.txt': new Response(tags, { headers: { 'content-type': 'text/plain' } }),
      'https://files.example.org/feed.xml': new Response(tags, { headers: { 'content-type': 'application/xml' } }),
      'https://files.example.org/icon.svg': new Response(`<svg xmlns="http://www.w3.org/2000/svg">${tags}<script>alert(1)</script></svg>`, { headers: { 'content-type': 'image/svg+xml' } }),
      'https://files.example.org/doc.pdf': new Response(`%PDF-1.7 ${tags}`, { headers: { 'content-type': 'application/pdf' } }),
      'https://files.example.org/untyped': new Response(new TextEncoder().encode(tags)),
      'https://files.example.org/empty': html('<html><head></head><body><p>Hello</p></body></html>'),
      'https://files.example.org/blank': html(''),
      'https://files.example.org/real': html(tags),
      'https://files.example.org/missing': new Response(tags, { status: 404, headers: { 'content-type': 'text/html' } }),
      'https://files.example.org/broken': new Response(tags, { status: 500, headers: { 'content-type': 'text/html' } }),
      'https://files.example.org/down': new Error('connection refused'),
      'https://files.example.org/slow': new DOMException('The operation timed out.', 'TimeoutError') as unknown as Error,
    })
    for (const path of ['data.json', 'notes.txt', 'feed.xml', 'icon.svg', 'doc.pdf', 'untyped', 'empty', 'blank', 'missing', 'broken']) {
      const nothing = await page(`https://files.example.org/${path}`)
      expect(nothing.status, path).toBe(404)
      expect(Object.keys(nothing.body), path).toEqual(['error'])
    }
    expect((await page('https://files.example.org/real')).body.title).toBe('Not a page')
    for (const path of ['down', 'slow', 'nowhere']) expect((await page(`https://files.example.org/${path}`)).status, path).toBe(502)
  })

  it('keeps only a picture address it could fetch itself', async () => {
    const withImage = (image: string) => html(`<title>T</title><meta property="og:image" content="${image}">`)
    const { page } = setup({
      'https://a.example.org/1': withImage('http://cdn.example.org/a.png'),
      'https://a.example.org/2': withImage('//cdn.example.org/a.png'),
      'https://a.example.org/3': withImage('img/a.png'),
      'https://a.example.org/4': withImage('http://127.0.0.1/a.png'),
      'https://a.example.org/5': withImage('https://169.254.169.254/latest/a.png'),
      'https://a.example.org/6': withImage('data:image/png;base64,iVBORw0KGgo='),
      'https://a.example.org/7': withImage('javascript:alert(1)'),
      'https://a.example.org/8': withImage('https://callz.fun/api/rooms/image/x'),
      'https://a.example.org/9': withImage('https://cdn.example.org:8443/a.png'),
      'https://a.example.org/10': html('<meta property="og:image" content="https://localhost/a.png">'),
    })
    expect((await page('https://a.example.org/1')).body.image).toBe('https://cdn.example.org/a.png')
    expect((await page('https://a.example.org/2')).body.image).toBe('https://cdn.example.org/a.png')
    expect((await page('https://a.example.org/3')).body.image).toBe('https://a.example.org/img/a.png')
    for (let n = 4; n <= 9; n++) expect((await page(`https://a.example.org/${n}`)).body, String(n)).toEqual({ url: `https://a.example.org/${n}`, site: 'a.example.org', title: 'T', description: null, image: null })
    // A page whose only content was a picture it may not name has nothing to show.
    expect((await page('https://a.example.org/10')).status).toBe(404)
  })

  it('answers for a link that is a picture with the picture itself', async () => {
    const { page } = setup({
      'https://cdn.example.org/cat.png': new Response(PNG, { headers: { 'content-type': 'image/png' } }),
      // Named a page by its server, a picture by its bytes.
      'https://cdn.example.org/cat': new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]), { headers: { 'content-type': 'text/html' } }),
      'https://cdn.example.org/moved': redirect('/cat.png'),
      // Named a picture by its server, markup by its bytes.
      'https://cdn.example.org/fake.png': new Response('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', { headers: { 'content-type': 'image/png' } }),
    })
    expect((await page('https://cdn.example.org/cat.png')).body).toEqual({ url: 'https://cdn.example.org/cat.png', site: 'cdn.example.org', title: null, description: null, image: 'https://cdn.example.org/cat.png' })
    expect((await page('cdn.example.org/cat')).body).toMatchObject({ title: null, image: 'https://cdn.example.org/cat' })
    expect((await page('https://cdn.example.org/moved')).body).toMatchObject({ url: 'https://cdn.example.org/cat.png', image: 'https://cdn.example.org/cat.png' })
    expect((await page('https://cdn.example.org/fake.png')).status).toBe(404)
  })

  it('reads a page in the encoding its server names', async () => {
    const latin = new Uint8Array([...new TextEncoder().encode('<title>Caf'), 0xe9, ...new TextEncoder().encode('</title>')])
    const { page } = setup({
      'https://old.example.org/': new Response(latin, { headers: { 'content-type': 'text/html; charset=ISO-8859-1' } }),
      'https://odd.example.org/': new Response('<title>Café</title>', { headers: { 'content-type': 'TEXT/HTML; charset="no-such-charset"' } }),
    })
    expect((await page('https://old.example.org/')).body.title).toBe('Café')
    expect((await page('https://odd.example.org/')).body.title).toBe('Café')
  })

  it('keeps an answer in the cache for a day, nothing-to-show for ten minutes, and a failure not at all', async () => {
    const store = new Map<string, Response>()
    const ages: Record<string, string | null> = {}
    vi.stubGlobal('caches', {
      default: {
        match: async (key: Request) => store.get(key.url)?.clone(),
        put: async (key: Request, response: Response) => {
          ages[key.url] = response.headers.get('cache-control')
          store.set(key.url, response)
        },
      },
    })
    const { page, picture, asked, waiting, call } = setup({
      'https://liquidlabs.io/work': html(PAGE),
      'https://liquidlabs.io/cover.png': new Response(PNG),
      'https://liquidlabs.io/empty': html('<p>nothing</p>'),
      'https://liquidlabs.io/down': new Error('offline'),
    })
    const first = await page('https://liquidlabs.io/work')
    await Promise.all(waiting)
    const second = await page('liquidlabs.io/work#again')
    expect(second.status).toBe(200)
    expect(second.body).toEqual(first.body)
    expect(second.headers.get('cache-control')).toBe('no-store')
    expect((await picture('https://liquidlabs.io/cover.png')).body).toEqual(PNG)
    await Promise.all(waiting)
    const again = await picture('https://liquidlabs.io/cover.png')
    expect(again.body).toEqual(PNG)
    expect(again.headers.get('content-type')).toBe('image/png')
    expect(again.headers.get('cache-control')).toBe('private, max-age=86400')
    expect(again.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    for (let n = 0; n < 2; n++) {
      expect((await page('https://liquidlabs.io/empty')).status).toBe(404)
      expect((await page('https://liquidlabs.io/down')).status).toBe(502)
      await Promise.all(waiting)
    }
    expect(asked.map(({ url }) => url)).toEqual(['https://liquidlabs.io/work', 'https://liquidlabs.io/cover.png', 'https://liquidlabs.io/empty', 'https://liquidlabs.io/down', 'https://liquidlabs.io/down'])
    expect(Object.values(ages).sort()).toEqual(['public, max-age=600', 'public, max-age=86400', 'public, max-age=86400'])
    // A key names no address: it is the hash of one. And the cache is asked only after the session is.
    for (const key of store.keys()) expect(key).toMatch(/^https:\/\/callz\.test\/api\/preview\/kept\/(page|image)\/[0-9a-f]{64}$/)
    expect((await call('/api/preview?url=liquidlabs.io/work', { signedIn: false })).status).toBe(401)
    expect((await call(new URL([...store.keys()][0]!).pathname)).status).toBe(404)
  })
})

describe('GET /api/preview/image', () => {
  it('passes on a PNG, JPEG, WebP or GIF as exactly that, under a policy that runs nothing', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1])
    const { picture, asked } = setup({
      // What the server calls it does not matter, and none of its headers come along.
      'https://cdn.example.org/a.png': new Response(PNG, { headers: { 'content-type': 'text/html', 'set-cookie': 'a=1', 'x-powered-by': 'someone', 'content-disposition': 'attachment; filename=a.exe' } }),
      'https://cdn.example.org/a.jpg': new Response(jpeg, { headers: { 'content-type': 'application/octet-stream' } }),
      'https://cdn.example.org/a.gif': new Response(new TextEncoder().encode('GIF89a..........')),
      'https://cdn.example.org/a.webp': new Response(new TextEncoder().encode('RIFF....WEBPVP8 ')),
      'https://cdn.example.org/moved': redirect('https://cdn.example.org/a.png'),
    })
    const served = await picture('cdn.example.org/a.png')
    expect(served.status).toBe(200)
    expect(served.body).toEqual(PNG)
    expect(Object.fromEntries(served.headers)).toEqual({
      'content-type': 'image/png',
      'content-length': String(PNG.byteLength),
      'cache-control': 'private, max-age=86400',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'content-disposition': 'inline',
      'cross-origin-resource-policy': 'same-origin',
    })
    expect((await picture('https://cdn.example.org/a.jpg')).headers.get('content-type')).toBe('image/jpeg')
    expect((await picture('https://cdn.example.org/a.gif')).headers.get('content-type')).toBe('image/gif')
    expect((await picture('https://cdn.example.org/a.webp')).headers.get('content-type')).toBe('image/webp')
    expect((await picture('https://cdn.example.org/moved')).body).toEqual(PNG)
    expect(new Headers(asked[0]!.init.headers).get('accept')).toBe('image/png, image/jpeg, image/webp, image/gif')
    expect(asked[0]!.init.redirect).toBe('manual')
  })

  it('refuses SVG, HTML, anything else, and a picture over 2 MB', async () => {
    const tooBig = new Uint8Array(MAX_PICTURE_BYTES + 1)
    tooBig.set(PNG)
    const justFits = new Uint8Array(MAX_PICTURE_BYTES)
    justFits.set(PNG)
    let cancelled = false
    let pulled = 0
    const endless = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled++
            if (pulled > 1000) throw new Error('the body was read without end')
            const chunk = new Uint8Array(262_144)
            if (pulled === 1) chunk.set(PNG)
            controller.enqueue(chunk)
          },
          cancel() {
            cancelled = true
          },
        }),
        { headers: { 'content-type': 'image/png' } },
      )
    const { picture } = setup({
      'https://cdn.example.org/a.svg': new Response('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', { headers: { 'content-type': 'image/svg+xml' } }),
      'https://cdn.example.org/lying.png': new Response('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', { headers: { 'content-type': 'image/png' } }),
      'https://cdn.example.org/page': html('<!doctype html><script>alert(1)</script>'),
      'https://cdn.example.org/polyglot': new Response('<html><!-- \u0089PNG --><script>alert(1)</script>', { headers: { 'content-type': 'image/png' } }),
      'https://cdn.example.org/a.avif': new Response(new Uint8Array([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0, 0]), { headers: { 'content-type': 'image/avif' } }),
      'https://cdn.example.org/tiny': new Response(new Uint8Array([0x89, 0x50]), { headers: { 'content-type': 'image/png' } }),
      'https://cdn.example.org/empty': new Response(null, { headers: { 'content-type': 'image/png' } }),
      'https://cdn.example.org/missing.png': new Response(PNG, { status: 404 }),
      'https://cdn.example.org/big.png': new Response(tooBig, { headers: { 'content-type': 'image/png' } }),
      'https://cdn.example.org/fits.png': new Response(justFits, { headers: { 'content-type': 'image/png' } }),
      'https://cdn.example.org/endless.png': endless,
      'https://cdn.example.org/inward': redirect('https://127.0.0.1/a.png'),
      'https://cdn.example.org/down': new Error('offline'),
    })
    for (const path of ['a.svg', 'lying.png', 'page', 'polyglot', 'a.avif', 'tiny', 'empty', 'missing.png', 'big.png', 'endless.png']) {
      const refused = await picture(`https://cdn.example.org/${path}`)
      expect(refused.status, path).toBe(415)
      expect(refused.headers.get('content-type'), path).toBe('application/json; charset=utf-8')
      expect(Object.keys(refused.body), path).toEqual(['error'])
    }
    expect(cancelled).toBe(true)
    expect(pulled).toBeLessThan(20)
    expect((await picture('https://cdn.example.org/fits.png')).body).toHaveLength(MAX_PICTURE_BYTES)
    expect((await picture('https://cdn.example.org/inward')).status).toBe(502)
    expect((await picture('https://cdn.example.org/down')).status).toBe(502)
  })
})

describe('GET /api/preview/post', () => {
  const EMBED =
    '<blockquote class="twitter-tweet" data-dnt="true"><p lang="en" dir="ltr">Cooking  <a href="https://twitter.com/search?q=%24NIGHT&amp;src=ctag">$NIGHT</a> with <a href="https://twitter.com/CallZFun?ref_src=twsrc%5Etfw">@CallZFun</a><br>Tom &amp; Jerry&#39;s &#x1F525; <a href="https://twitter.com/hashtag/BNB">#BNB</a> &lt;script&gt;alert(1)&lt;/script&gt; <a href="https://t.co/abc">pic.twitter.com/abc</a></p>&mdash; Night Owl \u{1F989} (@NightOwl) <a href="https://twitter.com/NightOwl/status/20?ref_src=twsrc%5Etfw">March 21, 2006</a></blockquote>\n'
  const oembed = (url: string) => `https://publish.x.com/oembed?url=${encodeURIComponent(url)}&omit_script=1&dnt=1`

  it('reads what a post says with its capitals, and when it was made', () => {
    expect(postWords(EMBED)).toBe("Cooking $NIGHT with @CallZFun Tom & Jerry's \u{1F525} #BNB <script>alert(1)</script> pic.twitter.com/abc")
    expect(postDate(EMBED)).toBe('March 21, 2006')
    // The author line is not what the post says, and a link inside the post is not its date.
    expect(postWords(EMBED)).not.toContain('Night Owl')
    expect(postDate('<blockquote><p>see <a href="https://t.co/x">this</a></p>&mdash; someone (@someone)</blockquote>')).toBeNull()
    expect(postDate('<blockquote>no paragraph <a href="#">May 1, 2026</a></blockquote>')).toBeNull()
    expect(postWords('<blockquote>no paragraph</blockquote>')).toBeNull()
    expect(postWords('<p>  </p>')).toBeNull()
    expect(postWords('<p>one<br>two<br/>three<br />four​‮</p>')).toBe('one two three four')
  })

  it('answers for a post with its text, its author and its date', async () => {
    const { post, asked } = setup({
      [oembed('https://x.com/NightOwl/status/20')]: Response.json(
        { url: 'https://twitter.com/NightOwl/status/20', author_name: ' Night  Owl \u{1F989}​', author_url: 'https://twitter.com/NightOwl', html: EMBED, provider_name: 'Twitter', type: 'rich' },
        { headers: { 'set-cookie': 'guest_id=1' } },
      ),
    })
    const preview = await post('https://twitter.com/NightOwl/status/20?s=46&t=abc')
    expect(preview.status).toBe(200)
    expect(preview.body).toEqual({
      url: 'https://x.com/NightOwl/status/20',
      handle: 'NightOwl',
      authorName: 'Night Owl \u{1F989}',
      text: "Cooking $NIGHT with @CallZFun Tom & Jerry's \u{1F525} #BNB <script>alert(1)</script> pic.twitter.com/abc",
      date: 'March 21, 2006',
    })
    expect(preview.headers.get('set-cookie')).toBeNull()
    expect(asked).toHaveLength(1)
    expect(asked[0]!.init.redirect).toBe('manual')
    expect(new Headers(asked[0]!.init.headers).get('accept')).toBe('application/json')
    // Every spelling of the link is the one post.
    for (const spelled of ['x.com/NightOwl/status/20', 'http://mobile.twitter.com/NightOwl/status/20/photo/1', 'https://www.x.com/NightOwl/status/20#m']) {
      expect((await post(spelled)).body.url, spelled).toBe('https://x.com/NightOwl/status/20')
    }
  })

  it('takes only a link to a post on X', async () => {
    const { post, asked } = setup()
    for (const bad of ['https://x.com/NightOwl', 'https://x.com/NightOwl/status/abc', 'https://x.com.evil.io/a/status/1', 'https://example.com/a/status/1', 'https://publish.x.com/oembed?url=https://x.com/a/status/1', 'https://127.0.0.1/a/status/1']) {
      expect((await post(bad)).status, bad).toBe(400)
    }
    expect(asked).toEqual([])
  })

  it('answers 404 when X has no such post and 502 when X could not be asked', async () => {
    const at = (id: number) => `https://x.com/owl/status/${id}`
    const { post } = setup({
      [oembed(at(1))]: new Response('<html>Nothing to see here</html>', { status: 404 }),
      [oembed(at(2))]: new Response('', { status: 403 }),
      [oembed(at(3))]: new Error('X is down'),
      [oembed(at(4))]: new Response('', { status: 429 }),
      [oembed(at(5))]: new Response('<html>rate limited</html>', { status: 200 }),
      [oembed(at(6))]: Response.json({ author_url: 'https://x.com/owl' }),
      [oembed(at(7))]: Response.json({ html: '<blockquote>no paragraph</blockquote>' }),
      [oembed(at(8))]: redirect('https://127.0.0.1/oembed'),
      [oembed(at(9))]: Response.json({ html: `<blockquote><p>${'x'.repeat(70_000)}</p></blockquote>` }),
      [oembed(at(10))]: Response.json(null),
      // X names no author it can be held to: the handle is the one in the link.
      [oembed(at(11))]: Response.json({ html: '<blockquote><p>gm</p></blockquote>', author_url: 'https://evil.example.com/someone', author_name: 7 }),
    })
    for (const id of [1, 2]) {
      const missing = await post(at(id))
      expect(missing.status).toBe(404)
      expect(missing.body.error).toContain('no such post')
    }
    for (const id of [3, 4, 5, 6, 7, 8, 9, 10, 12]) {
      const down = await post(at(id))
      expect(down.status, String(id)).toBe(502)
      expect(Object.keys(down.body)).toEqual(['error'])
    }
    expect((await post(at(11))).body).toEqual({ url: at(11), handle: 'owl', authorName: null, text: 'gm', date: null })
  })
})
