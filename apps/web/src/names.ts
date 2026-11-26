// The rules of a display name, as the page applies them before it asks a wallet to sign anything. The Worker
// applies the same rules to every request (apps/worker/src/names.ts) and is the one that decides: what is
// here is a courtesy, so a visitor hears what is wrong with a name while typing it. This file imports
// nothing, and the Worker's tests (apps/worker/test/names.test.ts) hold it to the Worker's own answers.

export const MIN_NAME_LENGTH = 3;
export const MAX_NAME_LENGTH = 20;
/** The site and the chain id the signed text states. */
const NAME_SITE = "callz.fun";
const NAME_CHAIN_ID = 56;

const NAME = /^[A-Za-z][A-Za-z0-9_]{2,19}$/;
const NAME_ALPHABET = /^[A-Za-z0-9_]*$/;
const STARTS_WITH_LETTER = /^[A-Za-z]/;
/** "0x" and hex digits, at any length, and the same written with a letter O. */
const LOOKS_LIKE_ADDRESS = /^[0oO][xX][0-9a-fA-F]+$/;

/**
 * Names nobody can take, because they could pass for the site's staff, a partner, or nobody at all. Matched
 * in lowercase with underscores taken out.
 * Keep in sync with `RESERVED_NAMES` in apps/worker/src/names.ts.
 */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "callz", "admin", "admins", "administrator", "mod", "mods", "moderator", "moderators", "support", "helpdesk", "official", "team", "staff",
  "system", "security", "verified", "owner", "founder", "dev", "devs", "developer", "deployer", "reviewer", "treasury", "vault", "bot",
  "flap", "flapsh", "pancakeswap", "pancake", "binance", "bnbchain", "bnb", "cz", "pumpfun", "fomofamily", "dexscreener", "metamask", "trustwallet",
  "null", "undefined", "nan", "none", "nobody", "unknown", "anonymous", "anon", "everyone",
]);
/** A name that starts with the site's own name is the site's, whatever follows. */
const RESERVED_PREFIX = "callz";

function isReservedName(name: string): boolean {
  const plain = name.toLowerCase().replaceAll("_", "");
  return RESERVED_NAMES.has(plain) || plain.startsWith(RESERVED_PREFIX);
}

/**
 * Why `raw` cannot be a display name, or null when it can. The name is taken exactly as given: the wallet
 * signs these very characters.
 * Keep in sync with `displayNameError` in apps/worker/src/names.ts: the Worker says the same, and has the last word.
 */
export function displayNameError(raw: string): string | null {
  if (LOOKS_LIKE_ADDRESS.test(raw)) return "A name cannot look like a wallet address.";
  if (!NAME_ALPHABET.test(raw)) return "A name can only have letters, digits and underscores (A-Z, a-z, 0-9, _).";
  if (raw.length < MIN_NAME_LENGTH) return `A name is at least ${MIN_NAME_LENGTH} characters.`;
  if (raw.length > MAX_NAME_LENGTH) return `A name is at most ${MAX_NAME_LENGTH} characters.`;
  if (!STARTS_WITH_LETTER.test(raw)) return "A name starts with a letter.";
  if (isReservedName(raw)) return "That name is reserved. Choose another.";
  return null;
}

/**
 * A display name the API returned, if it has the shape of one: 3 to 20 ASCII letters, digits and underscores,
 * starting with a letter. Anything else is no name at all, and the wallet is shown by its address alone. The
 * page puts on screen only what passed this, and only ever as text.
 */
export function shownName(value: unknown): string | null {
  return typeof value === "string" && NAME.test(value) ? value : null;
}

/**
 * The exact text the wallet signs to set its name, or to remove it when `name` is null: the site, what is
 * being done, the name, the wallet, the chain id and the time (`issuedAt`, unix seconds).
 * Keep in sync with `nameSigningText` in apps/worker/src/names.ts: one character of difference and no signature verifies.
 */
export function nameSigningText({ wallet, name, issuedAt }: { wallet: string; name: string | null; issuedAt: number }): string {
  const action = name === null ? "Action: Remove display name" : `Action: Set display name\nName: ${name}`;
  return `CallZ display name\n\nSite: ${NAME_SITE}\n${action}\nWallet: ${wallet.toLowerCase()}\nChain ID: ${NAME_CHAIN_ID}\nTime: ${issuedAt}`;
}
