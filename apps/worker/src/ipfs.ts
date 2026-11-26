/**
 * Token metadata and pictures live on IPFS. Flap pins both on its own gateway, which also resizes images;
 * a public gateway is the fallback for content pinned elsewhere.
 */

const CID = '(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,110})'
const CID_PATH = new RegExp(`^${CID}(?:/[A-Za-z0-9._~-]{1,128}){0,4}$`)

/**
 * The IPFS path (a CID, optionally followed by a file path) in a value written the ways token metadata
 * writes it: bare, `ipfs://…`, or a gateway URL. Null for anything else, so nothing but IPFS is ever fetched.
 */
export function ipfsPath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let path = value.trim()
  const viaGateway = /\/ipfs\/(.+)$/.exec(path)
  if (viaGateway?.[1]) path = viaGateway[1]
  else path = path.replace(/^ipfs:\/\//, '')
  path = (path.split(/[?#]/)[0] ?? '').replace(/\/+$/, '')
  return CID_PATH.test(path) ? path : null
}

/** Gateways in the order they are tried. `width` asks for a square thumbnail where the gateway can make one. */
const GATEWAYS: ReadonlyArray<(path: string, width?: number) => string> = [
  (path, width) =>
    `https://flap.mypinata.cloud/ipfs/${path}${width ? `?img-width=${width}&img-height=${width}&img-fit=cover&img-format=webp` : ''}`,
  (path) => `https://4everland.io/ipfs/${path}`,
]

export interface IpfsFetchOptions {
  width?: number
  accept?: string
  timeoutMs?: number
  /** Called before each request; return false to stop (a spent subrequest budget). */
  allow?: () => boolean
}

/** The first successful response for `path`, or null when every gateway failed. */
export async function fetchIpfs(path: string, options: IpfsFetchOptions = {}): Promise<Response | null> {
  for (const gateway of GATEWAYS) {
    if (options.allow && !options.allow()) return null
    try {
      const response = await fetch(gateway(path, options.width), {
        headers: options.accept ? { accept: options.accept } : {},
        signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
      })
      if (response.ok) return response
      await response.body?.cancel()
    } catch {
      // Try the next gateway.
    }
  }
  return null
}

/** Reads a body up to `maxBytes`. Null when it is larger: nothing oversized is buffered or passed on. */
export async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  const reader = response.body?.getReader()
  if (!reader) return null
  if (declared > maxBytes) {
    await reader.cancel()
    return null
  }
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
