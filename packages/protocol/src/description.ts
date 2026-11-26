/**
 * Launcher description, format version 1.
 * Spec: https://docs.flap.sh/en/flap/v2/developers/pool-launch/build-an-indexer#launcher-description
 *
 * Display data only. Never use it for gating, accounting or payments.
 */
export interface LauncherDescription {
  v: number
  name?: string
  symbol?: string
  /** Lowercase hex; the zero address means native BNB. */
  quoteToken?: string
  /** 1e18 fixed point. */
  targetRaise?: bigint
  /** Share of supply that goes into the pool, 1e18 = 100%. */
  poolTokenRatio?: bigint
  /** Titles keyed by language suffix: `en`, `zh`, `ja`, ... */
  titles: Record<string, string>
  summaries: Record<string, string>
}

export type ParsedDescription =
  | { kind: 'none' }
  | { kind: 'text'; text: string }
  | { kind: 'v1'; description: LauncherDescription }

function decimalToBigInt(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined
  return BigInt(value)
}

/**
 * Applies the reader rules of the spec: "" means no description; a non-empty
 * string that is not a JSON object is plain text; unknown keys are ignored and
 * keys whose value is "" are hidden.
 */
export function parseLauncherDescription(raw: string): ParsedDescription {
  if (raw === '') return { kind: 'none' }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { kind: 'text', text: raw }
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { kind: 'text', text: raw }
  }
  const obj = json as Record<string, unknown>
  const str = (key: string): string | undefined => {
    const value = obj[key]
    return typeof value === 'string' && value !== '' ? value : undefined
  }
  const description: LauncherDescription = {
    v: typeof obj.v === 'number' ? obj.v : 1,
    titles: {},
    summaries: {},
  }
  const name = str('name')
  if (name !== undefined) description.name = name
  const symbol = str('symbol')
  if (symbol !== undefined) description.symbol = symbol
  const quoteToken = str('quoteToken')
  if (quoteToken !== undefined) description.quoteToken = quoteToken.toLowerCase()
  const targetRaise = decimalToBigInt(obj.targetRaise)
  if (targetRaise !== undefined) description.targetRaise = targetRaise
  const poolTokenRatio = decimalToBigInt(obj.poolTokenRatio)
  if (poolTokenRatio !== undefined) description.poolTokenRatio = poolTokenRatio

  for (const key of Object.keys(obj)) {
    const value = str(key)
    if (value === undefined) continue
    const title = /^title([A-Z][A-Za-z]*)$/.exec(key)
    if (title?.[1]) description.titles[title[1].toLowerCase()] = value
    const summary = /^summary([A-Z][A-Za-z]*)$/.exec(key)
    if (summary?.[1]) description.summaries[summary[1].toLowerCase()] = value
  }
  return { kind: 'v1', description }
}

/** Picks a language, falling back to English as the spec requires. */
export function localized(values: Record<string, string>, lang: string): string | undefined {
  return values[lang] ?? values.en
}
