export const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** A base-unit amount as a decimal, trimmed to `maxDecimals` places. Exact: no floating point. */
export function amount(value: bigint | string | null | undefined, maxDecimals = 4, decimals = 18): string {
  if (value === null || value === undefined || value === "") return "—";
  const wei = typeof value === "bigint" ? value : BigInt(value);
  const unit = 10n ** BigInt(decimals);
  const fraction = (wei % unit).toString().padStart(decimals, "0").slice(0, maxDecimals).replace(/0+$/, "");
  return `${group((wei / unit).toString())}${fraction ? `.${fraction}` : ""}`;
}

/** A large whole-token count in compact form: 1B, 21M, 108. */
export function compact(value: string | null | undefined, decimals = 18): string {
  if (!value) return "—";
  const whole = Number(BigInt(value) / 10n ** BigInt(decimals));
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(whole);
}

/** A price with 18 decimals, to four significant figures. Display only. */
export function price(value: string | null | undefined): string {
  if (!value) return "—";
  const number = Number(BigInt(value)) / 1e18;
  if (number === 0) return "0";
  return number >= 1 ? number.toLocaleString("en", { maximumFractionDigits: 4 }) : number.toPrecision(4).replace(/\.?0+$/, "");
}

/** A 1e18-scaled ratio as a percentage: "500000000000000000" is 50%. */
export function percent(ratio: bigint | undefined): string {
  if (ratio === undefined) return "—";
  const bps = Number((ratio * 10_000n) / 10n ** 18n);
  return `${bps / 100}%`;
}

export function ago(timestamp: number | null | undefined, now = Date.now()): string {
  if (!timestamp) return "—";
  const seconds = Math.max(0, Math.floor(now / 1000) - timestamp);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}
