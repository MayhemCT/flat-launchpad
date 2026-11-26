import { describe, expect, it } from 'vitest'
import { marketCapFromReserves } from '../src/market.js'

const E18 = 10n ** 18n

describe('marketCapFromReserves', () => {
  it('prices a USDT pool directly: supply times USDT per token', () => {
    // 1,000,000,000 tokens; the pool holds 100,000,000 of them against 5,000 USDT: 0.00005 USDT each.
    expect(marketCapFromReserves(1_000_000_000n * E18, 100_000_000n * E18, 5_000n * E18, null)).toBe(50_000)
  })

  it('prices a BNB pool through the BNB/USDT pool', () => {
    // The pool holds 500,000,000 tokens against 1 BNB, and BNB is 600 USDT: the supply is worth 2 BNB, 1,200 dollars.
    expect(marketCapFromReserves(1_000_000_000n * E18, 500_000_000n * E18, E18, { wbnb: 1_000n * E18, usdt: 600_000n * E18 })).toBe(1_200)
  })

  it('does not depend on the token having 18 decimals', () => {
    // The same token with 9 decimals: supply and reserve shrink together.
    expect(marketCapFromReserves(1_000_000_000n * 10n ** 9n, 100_000_000n * 10n ** 9n, 5_000n * E18, null)).toBe(50_000)
  })

  it('gives no figure rather than a wrong one', () => {
    expect(marketCapFromReserves(0n, E18, E18, null)).toBeNull()
    expect(marketCapFromReserves(E18, 0n, E18, null)).toBeNull()
    expect(marketCapFromReserves(E18, E18, 0n, null)).toBeNull()
    expect(marketCapFromReserves(E18, E18, E18, { wbnb: 0n, usdt: E18 })).toBeNull()
    // Worth less than a dollar: not a whole-dollar market cap.
    expect(marketCapFromReserves(E18, 1_000n * E18, E18, null)).toBeNull()
  })
})
