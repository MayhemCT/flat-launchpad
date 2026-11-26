/**
 * DexScreener market data and chart embeds for BNB Chain (chain slug "bsc").
 * Read-only: pair stats, charts, and the token's "info" (website, docs, socials).
 *
 * That info is submitted to DexScreener by the token's own team, not checked by this site. It is shown
 * on the token's page as what it is ("from DexScreener, submitted by the token's team"), only as
 * plain https links that open in a new tab, and not at all for a token found to take holders'
 * balances (pairLinks below, token.tsx).
 */

export const DS_CHAIN = "bsc";

export type DsPair = {
  pairAddress: string;
  dexId: string;
  labels?: string[];
  url: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  priceNative?: string;
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  liquidity?: { usd?: number };
  volume?: { m5?: number; h1?: number; h6?: number; h24?: number };
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  txns?: Record<"m5" | "h1" | "h6" | "h24", { buys: number; sells: number }>;
  info?: { websites?: { label?: string; url?: string }[]; socials?: { type?: string; url?: string }[] };
};

export type TokenLink = { kind: "website" | "docs" | "x" | "telegram" | "discord" | "other"; label: string; url: string };

const SOCIAL: Record<string, { kind: TokenLink["kind"]; label: string }> = {
  twitter: { kind: "x", label: "X" },
  x: { kind: "x", label: "X" },
  telegram: { kind: "telegram", label: "Telegram" },
  discord: { kind: "discord", label: "Discord" },
};
const tidy = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim();
/** A link as given, if it is a plain https address; null for anything else (http, javascript:, data:, credentials in the address). */
function httpsUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length > 300) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password && u.hostname.includes(".") ? u : null;
  } catch {
    return null;
  }
}

/**
 * The website, docs and social links DexScreener holds for `token`, from the first of `pairs`
 * that has the token as its base and carries info. Submitted by the token's team: the label of a
 * website is its host name, as written in the address, so what is shown is where the link goes.
 * At most 8, each address once.
 */
export function pairLinks(pairs: DsPair[] | null, token: string): TokenLink[] {
  const t = token.toLowerCase();
  const info = pairs?.find((p) => p.baseToken.address.toLowerCase() === t && ((p.info?.websites?.length ?? 0) > 0 || (p.info?.socials?.length ?? 0) > 0))?.info;
  if (!info) return [];
  const out: TokenLink[] = [];
  const seen = new Set<string>();
  const add = (l: TokenLink) => {
    if (seen.has(l.url) || out.length >= 8) return;
    seen.add(l.url);
    out.push(l);
  };
  for (const w of info.websites ?? []) {
    const u = httpsUrl(w?.url);
    if (!u) continue;
    const docs = /^docs?$/i.test(tidy(String(w?.label ?? "")));
    add({ kind: docs ? "docs" : "website", label: docs ? `Docs · ${u.hostname.replace(/^www\./, "")}` : u.hostname.replace(/^www\./, ""), url: u.href });
  }
  for (const s of info.socials ?? []) {
    const u = httpsUrl(s?.url);
    if (!u) continue;
    const known = SOCIAL[String(s?.type ?? "").toLowerCase()];
    add({ kind: known?.kind ?? "other", label: known?.label ?? u.hostname.replace(/^www\./, ""), url: u.href });
  }
  return out;
}

/**
 * Whether a token's DexScreener profile is paid ("Dex paid"), from DexScreener's orders endpoint
 * (`/orders/v1/{chain}/{token}`): the newest tokenProfile order's status.
 */
export async function dexPaidStatus(token: string, signal?: AbortSignal): Promise<"paid" | "review" | "no"> {
  const res = await fetch(`https://api.dexscreener.com/orders/v1/${DS_CHAIN}/${token}`, { signal });
  if (!res.ok) throw new Error(`DexScreener returned HTTP ${res.status}.`);
  const j = (await res.json()) as { orders?: { type?: string; status?: string; paymentTimestamp?: number }[] } | { type?: string; status?: string; paymentTimestamp?: number }[];
  const list = Array.isArray(j) ? j : j.orders ?? [];
  const prof = list.filter((o) => o.type === "tokenProfile").sort((a, b) => (b.paymentTimestamp ?? 0) - (a.paymentTimestamp ?? 0))[0];
  if (prof?.status === "approved") return "paid";
  if (prof?.status === "processing" || prof?.status === "on-hold") return "review";
  return "no";
}

/** All pools DexScreener lists for a token, deepest liquidity first. */
export async function tokenPairs(token: string, signal?: AbortSignal): Promise<DsPair[]> {
  const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/${DS_CHAIN}/${token}`, { signal });
  if (!res.ok) throw new Error(`DexScreener returned HTTP ${res.status}.`);
  const pairs = (await res.json()) as DsPair[];
  return (Array.isArray(pairs) ? pairs : []).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
}

export function venueName(p: DsPair) {
  if (p.dexId === "pancakeswap") return `PancakeSwap ${p.labels?.[0] ?? ""}`.trim();
  if (p.dexId === "uniswap") return `Uniswap ${p.labels?.[0] ?? ""}`.trim();
  return /^0x[0-9a-f]{40}$/i.test(p.dexId) ? `DEX ${p.dexId.slice(0, 6)}…` : p.dexId;
}

/**
 * DexScreener's embed for a pair or token address (a token address resolves to its top pool), in the
 * site's dark theme. With `trades`, DexScreener's own transactions list sits under the chart, so the
 * page shows live trades without reading any logs from the RPC.
 */
/**
 * The pair's own page on DexScreener, for the link above each chart: the URL DexScreener's API
 * gives for the pair when it is a dexscreener.com link, otherwise built from the pool (or token) id.
 */
export function pairPageUrl(pair: Pick<DsPair, "url" | "pairAddress"> | null, fallbackId: string) {
  if (pair?.url && /^https:\/\/dexscreener\.com\/[a-z0-9-]+\/0x[0-9a-fA-F]{40,64}$/.test(pair.url)) return pair.url;
  return `https://dexscreener.com/${DS_CHAIN}/${(pair?.pairAddress || fallbackId).toLowerCase()}`;
}

export function chartEmbedUrl(id: string, interval = "15", trades = false) {
  const q = new URLSearchParams({
    embed: "1",
    loadChartSettings: "0",
    trades: trades ? "1" : "0",
    tabs: "0",
    info: "0",
    chartLeftToolbar: "0",
    chartDefaultOnMobile: "1",
    chartTheme: "dark",
    theme: "dark",
    chartStyle: "1",
    chartType: "usd",
    interval,
  });
  return `https://dexscreener.com/${DS_CHAIN}/${id}?${q.toString()}`;
}
