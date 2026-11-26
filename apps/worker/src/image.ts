/**
 * `/api/image/<ipfs path>?w=<64|128|256>`: a token's picture as a small square thumbnail.
 *
 * The page loads pictures from its own origin, so its content policy stays `img-src 'self'` and no visitor's
 * browser talks to a third party. Only IPFS paths are accepted, only raster images are passed on, and nothing
 * larger than 2 MB. IPFS content never changes, so a picture is cached for good.
 */
import { fetchIpfs, ipfsPath, readCapped } from './ipfs.js'

const WIDTHS = new Set([64, 128, 256])
const DEFAULT_WIDTH = 128
const MAX_BYTES = 2_097_152
/** Raster formats only: an SVG can carry script. */
const RASTER = new Set(['image/webp', 'image/png', 'image/jpeg', 'image/gif', 'image/avif'])

function failure(status: number, message: string, maxAge = 0): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': maxAge > 0 ? `public, max-age=${maxAge}` : 'no-store',
    },
  })
}

export async function handleImage(request: Request, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return failure(405, 'method not allowed')
  const url = new URL(request.url)
  let requested: string
  try {
    requested = decodeURIComponent(url.pathname.slice('/api/image/'.length))
  } catch {
    return failure(400, 'malformed path')
  }
  const path = ipfsPath(requested)
  const width = url.searchParams.has('w') ? Number(url.searchParams.get('w')) : DEFAULT_WIDTH
  if (!path) return failure(400, 'not an IPFS path')
  if (!WIDTHS.has(width)) return failure(400, 'w must be 64, 128 or 256')

  const cache = caches.default
  const cacheKey = new Request(`${url.origin}/api/image/${path}?w=${width}`)
  const cached = await cache.match(cacheKey)
  if (cached) return cached

  const upstream = await fetchIpfs(path, { width, accept: 'image/*', timeoutMs: 10_000 })
  if (!upstream) return failure(404, 'image not available', 300)
  const type = (upstream.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (!RASTER.has(type)) {
    await upstream.body?.cancel()
    return failure(415, 'not a raster image', 3600)
  }
  const bytes = await readCapped(upstream, MAX_BYTES)
  if (!bytes) return failure(413, 'image too large', 3600)

  const response = new Response(bytes, {
    headers: {
      'content-type': type,
      'content-length': String(bytes.byteLength),
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cross-origin-resource-policy': 'same-origin',
    },
  })
  ctx.waitUntil(cache.put(cacheKey, response.clone()))
  return response
}

const META_MAX_BYTES = 262_144
/** The text fields a token's metadata may carry to the page. Anything else in the file is dropped. */
const META_FIELDS = ['name', 'symbol', 'description', 'image', 'website', 'twitter', 'telegram', 'github', 'youtube'] as const

/**
 * `/api/meta/<ipfs path>`: the metadata a token's creator pinned at launch, as plain strings: its
 * description and links. Read from IPFS once and cached for good, since IPFS content never changes.
 * The page shows these as text and as plain https links; nothing in the file is ever run.
 */
export async function handleMeta(request: Request, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return failure(405, 'method not allowed')
  const url = new URL(request.url)
  let requested: string
  try {
    requested = decodeURIComponent(url.pathname.slice('/api/meta/'.length))
  } catch {
    return failure(400, 'malformed path')
  }
  const path = ipfsPath(requested)
  if (!path) return failure(400, 'not an IPFS path')

  const cache = caches.default
  const cacheKey = new Request(`${url.origin}/api/meta/${path}`)
  const cached = await cache.match(cacheKey)
  if (cached) return cached

  const upstream = await fetchIpfs(path, { accept: 'application/json', timeoutMs: 10_000 })
  if (!upstream) return failure(404, 'metadata not available', 300)
  const bytes = await readCapped(upstream, META_MAX_BYTES)
  let source: unknown = null
  try {
    source = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null
  } catch {
    // Not JSON: some tokens point their metadata straight at a picture.
  }
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return failure(404, 'no metadata', 3600)

  const meta: Record<string, string> = {}
  for (const field of META_FIELDS) {
    const value = (source as Record<string, unknown>)[field]
    if (typeof value === 'string' && value !== '') meta[field] = value.slice(0, field === 'description' ? 2000 : 300)
  }
  const response = new Response(JSON.stringify(meta), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    },
  })
  ctx.waitUntil(cache.put(cacheKey, response.clone()))
  return response
}
