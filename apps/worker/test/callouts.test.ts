import { keccak256, stringToHex, toBytes } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import {
  EPOCH_SECONDS,
  MAX_NOTE_LENGTH,
  SUBMISSION_TYPES,
  approvalWindowError,
  calloutSigningText,
  currentEpoch,
  handleCallouts,
  linkHashOf,
  parseCalloutLink,
  parseCalloutPost,
  profileHashOf,
  reviewRejectText,
  samePostPattern,
  submissionDomain,
  verifyAttestation,
  verifyCalloutSignature,
  type Submission,
} from '../src/callouts.js'

const TOKEN = '0xFe189E97832DA1573e4e4Ff034F4fFC3a15c7777'
const OTHER = '0x000000000000000000000000000000000000dEaD'
const VAULT = '0x00000000000000000000000000000000000Fa017'
const NOW = 1_800_000_000
const PUMP = 'https://pump.fun/callouts/0xFe189E97832DA1573e4e4Ff034F4fFC3a15c7777/7f179b33-b00a-4c2e-a119-153b48b7f9d6?share'
const FOMO =
  'https://fomo.family/tokens/bnb/0xfe189e97832da1573e4e4ff034f4ffc3a15c7777?r=FreeRoundHare&tradeId=d962f6f2-0177-4699-bde6-ff1b14d579b3'
const NOT_ACCEPTED = 'Only https links to a post on x.com, a callout on pump.fun or a trade on fomo.family are accepted.'
const FOMO_SHARE = 'Share the link of your trade on fomo.family: it carries your name and the trade.'

/** A fresh wallet for each test: no key is ever written down. */
const newAccount = () => privateKeyToAccount(generatePrivateKey())
const errorOf = (raw: string, token = TOKEN) => {
  const parsed = parseCalloutLink(raw, token)
  return parsed.ok ? null : parsed.error
}

describe('parseCalloutLink, X', () => {
  it('rebuilds a post link in its one canonical spelling', () => {
    const canonical = { ok: true, kind: 0, url: 'https://x.com/someuser_1/status/1859999999999999999', profile: 'x:someuser_1' }
    for (const raw of [
      'https://x.com/SomeUser_1/status/1859999999999999999',
      'https://twitter.com/someuser_1/status/1859999999999999999',
      'https://www.x.com/SOMEUSER_1/status/1859999999999999999',
      'https://mobile.twitter.com/SomeUser_1/status/1859999999999999999',
      'https://mobile.x.com/SomeUser_1/status/1859999999999999999?s=20&t=abc',
      'https://x.com/SomeUser_1/status/1859999999999999999/photo/1',
      'https://x.com/SomeUser_1/status/1859999999999999999#m',
      'HTTPS://X.COM/SomeUser_1/status/1859999999999999999',
      '  https://x.com/SomeUser_1/status/1859999999999999999\n',
    ]) {
      expect(parseCalloutLink(raw, TOKEN), raw).toEqual(canonical)
    }
  })

  it('refuses anything on X that is not a post', () => {
    for (const raw of [
      'https://x.com/someuser',
      'https://x.com/someuser/status/',
      'https://x.com/someuser/status/12ab',
      'https://x.com/someuser/status/12345678901234567890123456',
      'https://x.com/a_name_that_is_too_long/status/1',
      'https://x.com/some.user/status/1',
      'https://x.com/someuser/statuses/1',
      'https://x.com//status/1',
      'https://x.com/someuser/status/1abc',
    ]) {
      expect(errorOf(raw), raw).toMatch(/Link to the post itself/)
    }
  })
})

describe('parseCalloutLink, pump.fun', () => {
  it('accepts a callout for the token it is posted under', () => {
    const canonical = {
      ok: true,
      kind: 1,
      url: 'https://pump.fun/callouts/0xfe189e97832da1573e4e4ff034f4ffc3a15c7777/7f179b33-b00a-4c2e-a119-153b48b7f9d6',
      profile: '',
    }
    expect(parseCalloutLink(PUMP, TOKEN)).toEqual(canonical)
    expect(parseCalloutLink(PUMP, TOKEN.toLowerCase())).toEqual(canonical)
    expect(parseCalloutLink(PUMP.replace('pump.fun', 'www.pump.fun').replace('7f179b33', '7F179B33'), TOKEN)).toEqual(canonical)
  })

  it('refuses a callout for another contract', () => {
    expect(errorOf(PUMP, OTHER)).toBe('This pump.fun callout is for a different contract, so it cannot earn rewards here.')
  })

  it('refuses anything on pump.fun that is not a callout', () => {
    for (const raw of [
      `https://pump.fun/coin/${TOKEN}`,
      `https://pump.fun/callouts/${TOKEN}`,
      `https://pump.fun/callouts/${TOKEN}/not-a-uuid`,
      `https://pump.fun/callouts/${TOKEN}/7f179b33-b00a-4c2e-a119-153b48b7f9d6/extra`,
      `https://pump.fun/callouts/${TOKEN.slice(0, -1)}/7f179b33-b00a-4c2e-a119-153b48b7f9d6`,
    ]) {
      expect(errorOf(raw), raw).toMatch(/Link to the callout itself/)
    }
  })
})

describe('parseCalloutLink, fomo.family', () => {
  const canonical = {
    ok: true,
    kind: 2,
    url: 'https://fomo.family/tokens/bnb/0xfe189e97832da1573e4e4ff034f4ffc3a15c7777?r=FreeRoundHare&tradeId=d962f6f2-0177-4699-bde6-ff1b14d579b3',
    profile: 'fomo:freeroundhare',
  }

  it('accepts the share link of a trade in the token it is posted under', () => {
    expect(parseCalloutLink(FOMO, TOKEN)).toEqual(canonical)
    expect(parseCalloutLink(FOMO.replace('fomo.family', 'www.fomo.family'), TOKEN.toLowerCase())).toEqual(canonical)
    // The address and the trade are written in lowercase, the name as it was given.
    expect(
      parseCalloutLink(`https://fomo.family/tokens/bnb/${TOKEN}?r=FreeRoundHare&tradeId=D962F6F2-0177-4699-BDE6-FF1B14D579B3`, TOKEN),
    ).toEqual(canonical)
  })

  it('keeps only the name and the trade, in that order, and drops every other parameter', () => {
    const base = `https://fomo.family/tokens/bnb/${TOKEN}`
    for (const query of [
      'tradeId=d962f6f2-0177-4699-bde6-ff1b14d579b3&r=FreeRoundHare',
      'utm_source=x&r=FreeRoundHare&ref=abc&tradeId=d962f6f2-0177-4699-bde6-ff1b14d579b3&share',
      'r=FreeRoundHare&tradeId=d962f6f2-0177-4699-bde6-ff1b14d579b3&next=https://evil.example/',
      'r=FreeRoundHare&tradeId=d962f6f2-0177-4699-bde6-ff1b14d579b3#r=Other',
    ]) {
      expect(parseCalloutLink(`${base}?${query}`, TOKEN), query).toEqual(canonical)
    }
  })

  it('refuses a trade in another contract', () => {
    expect(errorOf(FOMO, OTHER)).toBe('This fomo.family callout is for a different contract, so it cannot earn rewards here.')
  })

  it('refuses a link without the trade or the name, and says which link to share', () => {
    const base = `https://fomo.family/tokens/bnb/${TOKEN}`
    for (const raw of [
      base,
      `${base}?r=FreeRoundHare`,
      `${base}?tradeId=d962f6f2-0177-4699-bde6-ff1b14d579b3`,
      `${base}?r=FreeRoundHare&tradeId=`,
      `${base}?r=FreeRoundHare&tradeId=not-a-uuid`,
      `${base}?r=&tradeId=d962f6f2-0177-4699-bde6-ff1b14d579b3`,
      `${base}?r=Free%20Hare&tradeId=d962f6f2-0177-4699-bde6-ff1b14d579b3`,
      `${base}?r=${'a'.repeat(41)}&tradeId=d962f6f2-0177-4699-bde6-ff1b14d579b3`,
      // A parameter given twice has no one meaning.
      `${base}?r=One&r=Two&tradeId=d962f6f2-0177-4699-bde6-ff1b14d579b3`,
      `${base}?r=One&tradeId=d962f6f2-0177-4699-bde6-ff1b14d579b3&tradeId=e962f6f2-0177-4699-bde6-ff1b14d579b3`,
      // Parameter names are matched exactly.
      `${base}?R=FreeRoundHare&tradeid=d962f6f2-0177-4699-bde6-ff1b14d579b3`,
      'https://fomo.family/',
      'https://fomo.family/u/FreeRoundHare',
      `${base}/?r=FreeRoundHare&tradeId=d962f6f2-0177-4699-bde6-ff1b14d579b3`,
      `https://fomo.family/tokens/sol/${TOKEN}?r=FreeRoundHare&tradeId=d962f6f2-0177-4699-bde6-ff1b14d579b3`,
    ]) {
      expect(errorOf(raw), raw).toBe(FOMO_SHARE)
    }
  })
})

describe('parseCalloutLink, everything else', () => {
  it('refuses other sites, naming the three that are accepted', () => {
    for (const raw of [
      'https://example.com/someuser/status/1',
      'https://t.me/somegroup',
      'https://x.com.evil.example/someuser/status/1',
      'https://evilx.com/someuser/status/1',
      'https://notpump.fun/callouts/0xFe189E97832DA1573e4e4Ff034F4fFC3a15c7777/7f179b33-b00a-4c2e-a119-153b48b7f9d6',
      'https://api.x.com/someuser/status/1',
      'https://x.com./someuser/status/1',
      'https://x.com:8443/someuser/status/1',
    ]) {
      expect(errorOf(raw), raw).toBe(NOT_ACCEPTED)
    }
    expect(NOT_ACCEPTED).toMatch(/x\.com.*pump\.fun.*fomo\.family/)
  })

  it('refuses every scheme but https', () => {
    for (const raw of [
      'http://x.com/someuser/status/1',
      'javascript:alert(1)',
      'javascript://x.com/%0aalert(1)',
      'data:text/html,<script>alert(1)</script>',
      'ftp://x.com/someuser/status/1',
      '//x.com/someuser/status/1',
      'x.com/someuser/status/1',
      'https:/x.com/someuser/status/1',
      'https:x.com/someuser/status/1',
    ]) {
      expect(errorOf(raw), raw).toBe(NOT_ACCEPTED)
    }
  })

  it('refuses a real host dressed up as an accepted one', () => {
    for (const raw of [
      // "x.com" here is a user name; the host is evil.com.
      'https://x.com@evil.com/someuser/status/1',
      'https://x.com:pass@evil.com/someuser/status/1',
      'https://x.com%2F@evil.com/someuser/status/1',
      'https://evil.com\\@x.com/someuser/status/1',
      'https://x.com\\someuser\\status\\1',
      'https://evil.com/x.com/someuser/status/1',
      'https://evil.com?https://x.com/someuser/status/1',
      'https://evil.com#https://x.com/someuser/status/1',
    ]) {
      expect(errorOf(raw), raw).toBe(NOT_ACCEPTED)
    }
  })

  it('refuses lookalike letters, invisible characters and spaces anywhere in the link', () => {
    for (const raw of [
      // Cyrillic "х" and "о", a full-width dot, and a Greek "ο".
      'https://х.com/someuser/status/1',
      'https://x.cоm/someuser/status/1',
      'https://x．com/someuser/status/1',
      'https://pump.fun/callouts/0xFe189E97832DA1573e4e4Ff034F4fFC3a15c7777/7f179b33-bο0a-4c2e-a119-153b48b7f9d6',
      'https://x.com/some​user/status/1',
      'https://x.com/someuser/status/1‮',
      'https://x.com/some user/status/1',
      'https://x.com/someuser/status/1\thttps://evil.com',
      'https://x.com/someuser/\u0000status/1',
      // A full-width digit is not a digit of the id.
      'https://x.com/someuser/status/１',
      // The punycode spelling of such a host is another host.
      'https://xn--x-7sb.com/someuser/status/1',
    ]) {
      expect(errorOf(raw), JSON.stringify(raw)).toBe(NOT_ACCEPTED)
    }
  })

  it('refuses an empty link and one over 300 characters', () => {
    expect(errorOf('')).toBe('Paste the link to your callout.')
    expect(errorOf('   ')).toBe('Paste the link to your callout.')
    expect(errorOf(`https://x.com/someuser/status/1?${'a'.repeat(300)}`)).toBe('The link is longer than 300 characters.')
    expect(parseCalloutLink(`https://x.com/someuser/status/1?${'a'.repeat(268)}`, TOKEN).ok).toBe(true)
  })

  it('never returns a link it did not write out itself', () => {
    for (const raw of ['https://x.com/A/status/1?x=<script>', PUMP, `${FOMO}&x="><img/src=x/onerror=alert(1)>`]) {
      const parsed = parseCalloutLink(raw, TOKEN)
      expect(parsed.ok, raw).toBe(true)
      if (parsed.ok) {
        expect(parsed.url).toMatch(/^https:\/\/(x\.com|pump\.fun|fomo\.family)\/[A-Za-z0-9/_.?=&-]+$/)
        // Canonical is a fixed point.
        expect(parseCalloutLink(parsed.url, TOKEN)).toEqual(parsed)
      }
    }
  })
})

describe('link and profile hashes', () => {
  it('hashes the UTF-8 bytes of the canonical link', () => {
    const url = 'https://x.com/someuser/status/1'
    expect(linkHashOf(url)).toBe(keccak256(toBytes(url)))
    expect(linkHashOf(url)).toBe(keccak256(stringToHex(url)))
    expect(linkHashOf(url)).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('hashes a profile, and gives 32 zero bytes when there is none', () => {
    expect(profileHashOf('x:someuser')).toBe(keccak256(toBytes('x:someuser')))
    expect(profileHashOf('')).toBe(`0x${'00'.repeat(32)}`)
  })
})

describe('samePostPattern', () => {
  it('matches the same X post under any name, and the same fomo.family trade under any name', () => {
    expect(samePostPattern(0, 'https://x.com/someuser/status/123')).toBe('https://x.com/%/status/123')
    expect(samePostPattern(2, 'https://fomo.family/tokens/bnb/0xfe189e97832da1573e4e4ff034f4ffc3a15c7777?r=A_b&tradeId=d962f6f2-0177-4699-bde6-ff1b14d579b3')).toBe(
      'https://fomo.family/tokens/bnb/%&tradeId=d962f6f2-0177-4699-bde6-ff1b14d579b3',
    )
    const pump = 'https://pump.fun/callouts/0xfe189e97832da1573e4e4ff034f4ffc3a15c7777/7f179b33-b00a-4c2e-a119-153b48b7f9d6'
    expect(samePostPattern(1, pump)).toBe(pump)
  })

  it('carries one wildcard of its own and none from the link', () => {
    for (const [kind, raw] of [[0, 'https://x.com/a_b_c/status/9'], [1, PUMP], [2, FOMO.replace('FreeRoundHare', 'a_b%c')]] as const) {
      const parsed = parseCalloutLink(raw, TOKEN)
      if (!parsed.ok) continue
      const wildcards = samePostPattern(kind, parsed.url).match(/[%_]/g) ?? []
      expect(wildcards, raw).toEqual(kind === 1 ? [] : ['%'])
    }
  })
})

describe('calloutSigningText', () => {
  it('is exactly the text the wallet shows', () => {
    expect(calloutSigningText({ token: TOKEN, url: 'https://x.com/someuser/status/1', note: 'called it at 40k', issuedAt: NOW })).toBe(
      'CallZ callout\n\nToken: 0xfe189e97832da1573e4e4ff034f4ffc3a15c7777\nNetwork: bsc\nLink: https://x.com/someuser/status/1\nTime: 1800000000\n\ncalled it at 40k',
    )
  })

  it('ends after the blank line when there is no note', () => {
    expect(calloutSigningText({ token: TOKEN.toLowerCase(), url: 'https://x.com/a/status/2', note: '', issuedAt: 1 })).toBe(
      'CallZ callout\n\nToken: 0xfe189e97832da1573e4e4ff034f4ffc3a15c7777\nNetwork: bsc\nLink: https://x.com/a/status/2\nTime: 1\n\n',
    )
  })

  it('has its own text for a rejection', () => {
    expect(reviewRejectText(42, NOW)).toBe('CallZ review\n\nReject callout 42\nTime: 1800000000')
  })
})

describe('verifyCalloutSignature', () => {
  const fields = { token: TOKEN, url: 'https://x.com/someuser/status/1', note: 'to the 🚀', issuedAt: NOW }

  it('accepts the author’s signature over the signing text', async () => {
    const account = newAccount()
    const signature = await account.signMessage({ message: calloutSigningText(fields) })
    expect(await verifyCalloutSignature({ ...fields, author: account.address.toLowerCase(), signature })).toBe(true)
    // What a browser wallet returns for personal_sign over the UTF-8 bytes.
    const raw = await account.signMessage({ message: { raw: stringToHex(calloutSigningText(fields)) } })
    expect(await verifyCalloutSignature({ ...fields, author: account.address, signature: raw })).toBe(true)
  })

  it('rejects another wallet, and any signed field that differs', async () => {
    const account = newAccount()
    const signature = await account.signMessage({ message: calloutSigningText(fields) })
    const signed = { ...fields, author: account.address, signature }
    expect(await verifyCalloutSignature({ ...signed, author: newAccount().address })).toBe(false)
    expect(await verifyCalloutSignature({ ...signed, url: 'https://x.com/someuser/status/2' })).toBe(false)
    expect(await verifyCalloutSignature({ ...signed, note: '' })).toBe(false)
    expect(await verifyCalloutSignature({ ...signed, issuedAt: NOW + 1 })).toBe(false)
    expect(await verifyCalloutSignature({ ...signed, token: OTHER })).toBe(false)
    expect(await verifyCalloutSignature({ ...signed, signature: '0x1234' })).toBe(false)
  })
})

describe('parseCalloutPost', () => {
  const SIGNATURE = `0x${'1'.repeat(128)}1b`
  const AUTHOR = `0x${'1'.repeat(40)}`
  const post = (fields: Record<string, unknown>) =>
    parseCalloutPost({ author: AUTHOR, url: 'https://twitter.com/SomeUser/status/1?s=20', issuedAt: NOW, signature: SIGNATURE, ...fields }, TOKEN)
  const postError = (fields: Record<string, unknown>) => {
    const parsed = post(fields)
    return parsed.ok ? null : parsed.error
  }

  it('returns the fields as they are verified and stored', async () => {
    const account = newAccount()
    const url = 'https://x.com/someuser/status/1'
    const signature = await account.signMessage({ message: calloutSigningText({ token: TOKEN, url, note: 'gm frens', issuedAt: NOW }) })
    const parsed = post({ author: account.address, note: '  gm​ frens\n ', signature })
    expect(parsed).toEqual({
      ok: true,
      post: { author: account.address.toLowerCase(), kind: 0, url, profile: 'x:someuser', note: 'gm frens', issuedAt: NOW, signature },
    })
    if (parsed.ok) expect(await verifyCalloutSignature({ token: TOKEN, ...parsed.post })).toBe(true)
  })

  it('takes a callout without a note', () => {
    expect(post({})).toMatchObject({ ok: true, post: { note: '' } })
    expect(post({ note: null })).toMatchObject({ ok: true, post: { note: '' } })
    expect(post({ note: ' ​ ' })).toMatchObject({ ok: true, post: { note: '' } })
  })

  it('refuses a link in the note, plain or dressed up', () => {
    for (const note of ['more at https://example.com', 'www.example.org', 'join t.me/somegroup', 'example[.]com', 'example dot com', 'tg://resolve?domain=x']) {
      expect(postError({ note }), note).toBe('Links are not allowed in the note. The callout link goes in its own box.')
    }
    expect(post({ note: 'called it at 40k, now 1.5M. LFG' }).ok).toBe(true)
  })

  it('refuses a note over 140 characters, counted after cleaning', () => {
    expect(MAX_NOTE_LENGTH).toBe(140)
    expect(post({ note: '🚀'.repeat(140) }).ok).toBe(true)
    expect(post({ note: `${'a'.repeat(140)}​` }).ok).toBe(true)
    expect(postError({ note: 'a'.repeat(141) })).toBe('The note is longer than 140 characters.')
    expect(postError({ note: 42 })).toBe('note must be text.')
  })

  it('refuses a link that is not accepted, with the reason', () => {
    expect(postError({ url: 'https://example.com/a/status/1' })).toBe(NOT_ACCEPTED)
    expect(postError({ url: PUMP.replace(TOKEN, OTHER) })).toMatch(/different contract/)
    expect(postError({ url: 42 })).toBe('url must be text.')
  })

  it('refuses a body of the wrong shape', () => {
    expect(parseCalloutPost(null, TOKEN)).toMatchObject({ ok: false })
    expect(parseCalloutPost([], TOKEN)).toMatchObject({ ok: false })
    expect(postError({ author: AUTHOR.slice(2) })).toBe('author must be a 0x address.')
    expect(postError({ issuedAt: String(NOW) })).toMatch(/issuedAt/)
    expect(postError({ issuedAt: NOW + 0.5 })).toMatch(/issuedAt/)
    expect(postError({ signature: '0x' })).toMatch(/65-byte signature/)
  })

  it('keeps SQL and HTML in a note as the plain text it is', () => {
    const note = `'; DROP TABLE callouts;-- <script>alert(1)</script> " OR 1=1`
    expect(post({ note })).toMatchObject({ ok: true, post: { note } })
  })
})

describe('the reviewer’s attestation', () => {
  const url = 'https://x.com/someuser/status/1'
  const submission = (holder: string, overrides: Partial<Submission> = {}): Submission => ({
    holder,
    token: TOKEN.toLowerCase(),
    epoch: currentEpoch(NOW),
    kind: 0,
    linkHash: linkHashOf(url),
    profileHash: profileHashOf('x:someuser'),
    nonce: 7,
    deadline: (currentEpoch(NOW) + 1) * EPOCH_SECONDS,
    ...overrides,
  })
  /** Signs the way the review page does: viem's signTypedData over the same domain and types. */
  const sign = (attester: ReturnType<typeof newAccount>, s: Submission, vault = VAULT) =>
    attester.signTypedData({
      domain: submissionDomain(vault),
      types: SUBMISSION_TYPES,
      primaryType: 'Submission',
      message: {
        holder: s.holder.toLowerCase() as `0x${string}`,
        token: s.token.toLowerCase() as `0x${string}`,
        epoch: BigInt(s.epoch),
        kind: s.kind,
        linkHash: s.linkHash,
        profileHash: s.profileHash,
        nonce: BigInt(s.nonce),
        deadline: BigInt(s.deadline),
      },
    })

  it('has the domain and struct the vault checks', () => {
    expect(submissionDomain(VAULT)).toEqual({ name: 'CallZ Vault', version: '1', chainId: 56, verifyingContract: VAULT.toLowerCase() })
    expect(SUBMISSION_TYPES.Submission.map(({ name, type }) => `${type} ${name}`).join(',')).toBe(
      'address holder,address token,uint256 epoch,uint8 kind,bytes32 linkHash,bytes32 profileHash,uint256 nonce,uint256 deadline',
    )
  })

  it('verifies the attester’s signature over a submission', async () => {
    const attester = newAccount()
    const s = submission(newAccount().address.toLowerCase())
    const signature = await sign(attester, s)
    expect(await verifyAttestation(attester.address.toLowerCase(), VAULT.toLowerCase(), s, signature)).toBe(true)
    // Addresses may come in their checksummed spelling too.
    expect(await verifyAttestation(attester.address, VAULT, { ...s, token: TOKEN }, signature)).toBe(true)
  })

  it('verifies a link that names no profile, with 32 zero bytes in its place', async () => {
    const attester = newAccount()
    const s = submission(newAccount().address, { kind: 1, linkHash: linkHashOf(PUMP), profileHash: profileHashOf('') })
    expect(await verifyAttestation(attester.address, VAULT, s, await sign(attester, s))).toBe(true)
  })

  it('rejects a signature from any wallet but the attester', async () => {
    const s = submission(newAccount().address)
    const signature = await sign(newAccount(), s)
    expect(await verifyAttestation(newAccount().address, VAULT, s, signature)).toBe(false)
    // The author cannot approve their own callout.
    const author = newAccount()
    const own = submission(author.address)
    expect(await verifyAttestation(newAccount().address, VAULT, own, await sign(author, own))).toBe(false)
  })

  it('rejects a signature when any attested field, or the vault, differs', async () => {
    const attester = newAccount()
    const s = submission(newAccount().address)
    const signature = await sign(attester, s)
    const check = (other: Partial<Submission>, vault = VAULT) => verifyAttestation(attester.address, vault, { ...s, ...other }, signature)
    expect(await check({})).toBe(true)
    expect(await check({ holder: newAccount().address })).toBe(false)
    expect(await check({ token: OTHER })).toBe(false)
    expect(await check({ epoch: s.epoch + 1 })).toBe(false)
    expect(await check({ kind: 1 })).toBe(false)
    expect(await check({ linkHash: linkHashOf('https://x.com/someuser/status/2') })).toBe(false)
    expect(await check({ profileHash: profileHashOf('x:other') })).toBe(false)
    expect(await check({ nonce: 8 })).toBe(false)
    expect(await check({ deadline: s.deadline - 1 })).toBe(false)
    expect(await check({}, OTHER)).toBe(false)
  })

  it('rejects a personal_sign signature and bytes that are no signature, without throwing', async () => {
    const attester = newAccount()
    const s = submission(newAccount().address)
    const personal = await attester.signMessage({ message: JSON.stringify(s) })
    expect(await verifyAttestation(attester.address, VAULT, s, personal)).toBe(false)
    expect(await verifyAttestation(attester.address, VAULT, s, `0x${'00'.repeat(65)}`)).toBe(false)
    expect(await verifyAttestation(attester.address, VAULT, s, '0x1234')).toBe(false)
  })
})

describe('approvalWindowError', () => {
  const epoch = currentEpoch(NOW)
  const end = (epoch + 1) * EPOCH_SECONDS

  it('accepts the round in progress, valid until its end at the latest', () => {
    expect(EPOCH_SECONDS).toBe(86_400)
    expect(currentEpoch(86_399)).toBe(0)
    expect(currentEpoch(86_400)).toBe(1)
    expect(approvalWindowError(epoch, end, NOW)).toBeNull()
    expect(approvalWindowError(epoch, NOW + 1, NOW)).toBeNull()
  })

  it('refuses a past or a later round', () => {
    expect(approvalWindowError(epoch - 1, end, NOW)).toMatch(/current round/)
    expect(approvalWindowError(epoch + 1, end + EPOCH_SECONDS, NOW)).toMatch(/current round/)
    expect(approvalWindowError(epoch + 2, end + 2 * EPOCH_SECONDS, end - 1)).toMatch(/current round/)
  })

  it('accepts the next round only in the last five minutes of this one', () => {
    expect(approvalWindowError(epoch + 1, end + EPOCH_SECONDS, end - 300)).toBeNull()
    expect(approvalWindowError(epoch + 1, end + EPOCH_SECONDS, end - 1)).toBeNull()
    expect(approvalWindowError(epoch + 1, end + EPOCH_SECONDS, end - 301)).toMatch(/current round/)
  })

  it('refuses a deadline after the end of the round, or one that has passed', () => {
    expect(approvalWindowError(epoch, end + 1, NOW)).toMatch(/end of the round/)
    expect(approvalWindowError(epoch, NOW, NOW)).toMatch(/already passed/)
    expect(approvalWindowError(epoch, NOW - 1, NOW)).toMatch(/already passed/)
  })
})

// These requests are all turned away before the database is read, so none is given one.
describe('handleCallouts, before the database', () => {
  const noDatabase = new Proxy(
    {},
    {
      get() {
        throw new Error('the database must not be reached')
      },
    },
  ) as Parameters<typeof handleCallouts>[1]['DB']
  const FEED = `https://callz.test/api/callouts/bsc/${TOKEN}`
  const REVIEW = 'https://callz.test/api/callouts/bsc/review'
  const JSON_TYPE = { 'content-type': 'application/json' }

  const send = (url: string, init?: RequestInit, env: Omit<Parameters<typeof handleCallouts>[1], 'DB'> = {}) =>
    handleCallouts(new Request(url, init), { DB: noDatabase, ...env })
  const postJson = (body: unknown, headers: Record<string, string> = JSON_TYPE) =>
    send(FEED, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })
  const errorOfResponse = async (response: Response) => ((await response.json()) as { error: string }).error
  const now = () => Math.floor(Date.now() / 1000)

  it('answers 405 to any method but GET, HEAD and POST', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await send(FEED, { method })
      expect(response.status, method).toBe(405)
      expect(response.headers.get('allow')).toBe('GET, HEAD, POST')
    }
  })

  it('answers 404 to another network or path, and 400 to a token that is not an address', async () => {
    expect((await send(`https://callz.test/api/callouts/bscTestnet/${TOKEN}`)).status).toBe(404)
    expect((await send(`https://callz.test/api/callouts/eth/${TOKEN}`)).status).toBe(404)
    expect((await send('https://callz.test/api/callouts/bsc')).status).toBe(404)
    expect((await send(`${FEED}/extra`)).status).toBe(404)
    expect((await send(`${REVIEW}/extra`)).status).toBe(404)
    expect((await send('https://callz.test/api/callouts/bsc/0x1234')).status).toBe(400)
  })

  it('answers 400 to a POST that is not JSON, and 413 to one over 4 KB', async () => {
    expect((await postJson('{}', { 'content-type': 'text/plain' })).status).toBe(400)
    expect((await postJson('{"author":')).status).toBe(400)
    expect((await postJson('[]')).status).toBe(400)
    const large = await postJson({ note: 'a'.repeat(4096) })
    expect(large.status).toBe(413)
    expect(await errorOfResponse(large)).toBe('The request is larger than 4 KB.')
  })

  it('answers 400 to a pump.fun callout for another contract, before any signature is checked', async () => {
    const response = await postJson({ author: newAccount().address, url: PUMP.replace(TOKEN, OTHER), issuedAt: now(), signature: `0x${'1'.repeat(128)}1b` })
    expect(response.status).toBe(400)
    expect(await errorOfResponse(response)).toBe('This pump.fun callout is for a different contract, so it cannot earn rewards here.')
  })

  it('answers 400 to a callout signed outside the five minute window', async () => {
    const account = newAccount()
    const issuedAt = now() - 301
    const url = 'https://x.com/someuser/status/1'
    const signature = await account.signMessage({ message: calloutSigningText({ token: TOKEN, url, note: '', issuedAt }) })
    const response = await postJson({ author: account.address, url, issuedAt, signature })
    expect(response.status).toBe(400)
    expect(await errorOfResponse(response)).toMatch(/5 minutes/)
  })

  it('answers 403 to a callout signed by another wallet, or over another spelling of the link', async () => {
    const issuedAt = now()
    const url = 'https://x.com/someuser/status/1'
    const stranger = await newAccount().signMessage({ message: calloutSigningText({ token: TOKEN, url, note: '', issuedAt }) })
    expect((await postJson({ author: newAccount().address, url, issuedAt, signature: stranger })).status).toBe(403)
    // The author signs the canonical link, not the one that was pasted.
    const account = newAccount()
    const pasted = 'https://twitter.com/SomeUser/status/1?s=20'
    const overPasted = await account.signMessage({ message: calloutSigningText({ token: TOKEN, url: pasted, note: '', issuedAt }) })
    expect((await postJson({ author: account.address, url: pasted, issuedAt, signature: overPasted })).status).toBe(403)
  })

  it('answers 503 to review until both the reviewer and the vault are set', async () => {
    const attester = newAccount().address
    for (const env of [{}, { CALLOUT_ATTESTER: attester }, { CALLZ_VAULT: VAULT }, { CALLOUT_ATTESTER: 'not an address', CALLZ_VAULT: VAULT }]) {
      for (const init of [undefined, { method: 'POST', headers: JSON_TYPE, body: '{}' }]) {
        const response = await send(REVIEW, init, env)
        expect(response.status).toBe(503)
        expect(await errorOfResponse(response)).toBe('Callout review is not configured yet.')
      }
    }
  })

  describe('a review decision', () => {
    const attester = newAccount()
    const env = { CALLOUT_ATTESTER: attester.address, CALLZ_VAULT: VAULT }
    const decide = (body: unknown) => send(REVIEW, { method: 'POST', headers: JSON_TYPE, body: JSON.stringify(body) }, env)
    const SIGNATURE = `0x${'1'.repeat(128)}1b`

    it('answers 400 to a decision of the wrong shape', async () => {
      expect((await decide([])).status).toBe(400)
      expect((await decide({ id: '7', decision: 'approve', signature: SIGNATURE })).status).toBe(400)
      expect((await decide({ id: 0, decision: 'approve', signature: SIGNATURE })).status).toBe(400)
      expect((await decide({ id: 7, decision: 'delete', signature: SIGNATURE })).status).toBe(400)
      expect((await decide({ id: 7, decision: 'approve', epoch: 1, deadline: 2, signature: '0x' })).status).toBe(400)
      expect((await decide({ id: 7, decision: 'approve', epoch: '1', deadline: 2, signature: SIGNATURE })).status).toBe(400)
      expect((await decide({ id: 7, decision: 'reject', signature: SIGNATURE })).status).toBe(400)
    })

    it('answers 400 to an approval for another round or with a deadline outside it', async () => {
      const epoch = currentEpoch(now())
      const end = (epoch + 1) * EPOCH_SECONDS
      expect((await decide({ id: 7, decision: 'approve', epoch: epoch - 1, deadline: end, signature: SIGNATURE })).status).toBe(400)
      expect((await decide({ id: 7, decision: 'approve', epoch: epoch + 2, deadline: end, signature: SIGNATURE })).status).toBe(400)
      expect((await decide({ id: 7, decision: 'approve', epoch, deadline: end + 1, signature: SIGNATURE })).status).toBe(400)
      expect((await decide({ id: 7, decision: 'approve', epoch, deadline: now() - 1, signature: SIGNATURE })).status).toBe(400)
    })

    it('answers 403 to a rejection that the reviewer wallet did not sign', async () => {
      const issuedAt = now()
      const stranger = await newAccount().signMessage({ message: reviewRejectText(7, issuedAt) })
      expect((await decide({ id: 7, decision: 'reject', issuedAt, signature: stranger })).status).toBe(403)
      // The reviewer's signature for one callout does not reject another.
      const other = await attester.signMessage({ message: reviewRejectText(8, issuedAt) })
      expect((await decide({ id: 7, decision: 'reject', issuedAt, signature: other })).status).toBe(403)
      const late = await attester.signMessage({ message: reviewRejectText(7, issuedAt - 301) })
      expect((await decide({ id: 7, decision: 'reject', issuedAt: issuedAt - 301, signature: late })).status).toBe(400)
    })
  })

  it('sends errors as JSON that is never cached, with no CORS header', async () => {
    const response = await postJson('{}', { ...JSON_TYPE, origin: 'https://elsewhere.example' })
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })
})
