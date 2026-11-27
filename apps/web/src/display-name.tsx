// Display names: the name a wallet gave itself, kept by this site's Worker under /api/names
// (apps/worker/src/names.ts). Chat and callouts get each author's name with the messages and callouts
// themselves; this file is how an author is shown, and how the connected wallet reads, sets and removes its own.
// A wallet in a clan shows the clan's tag in brackets before its name, wherever it is shown.
// Nobody logs in: the wallet signs the change with personal_sign, over plain EIP-1193, so nothing here loads a
// chain library.
import { useEffect, useSyncExternalStore } from "react";
import { short } from "./format";
import { nameSigningText, shownName } from "./names";
import { personalSign } from "./wallet";

const API = "/api/names";
/** A device clock further than this from the server's is corrected for; anything less is network delay. */
const CLOCK_SLACK_MS = 30_000;

/**
 * A wallet as an author. Without a name it is its short address, exactly as before there were names. With one,
 * the name comes first and the short address stays right beside it in a quieter style, so a name can never
 * pass for another wallet. The name is put on the page as a text node, and only if it has the shape of a name.
 */
export function AuthorName({ address, name, clan, className }: { address: string; name?: string | null | undefined; clan?: string | null | undefined; className: string }) {
  const shown = shownName(name);
  const tag = shownClan(clan);
  if (shown === null && tag === null) return <span className={className} title={address}>{short(address)}</span>;
  return (
    <span className={`${className} author-named`} title={address}>
      {tag !== null && <span className="clan-tag">[{tag}]</span>}
      {shown !== null && <span className="author-name">{shown}</span>}{" "}
      <span className="author-address">{short(address)}</span>
    </span>
  );
}

/**
 * A clan tag as it is shown, in brackets before a wallet's name: 2 to 5 capital letters and digits
 * (apps/worker/src/clans.ts). Null for a wallet in no clan, and for anything that does not have that shape.
 */
export function shownClan(value: unknown): string | null {
  return typeof value === "string" && /^[A-Z0-9]{2,5}$/.test(value) ? value : null;
}

/** What is known of one wallet's own name. */
export interface DisplayName {
  /** `ready` once the Worker has answered; `error` when it could not be asked. */
  state: "loading" | "ready" | "error";
  name: string | null;
  /** When the wallet last set or removed its name (unix seconds, by the server's clock). Null if it never has. */
  updatedAt: number | null;
}

const LOADING: DisplayName = { state: "loading", name: null, updatedAt: null };
const FAILED: DisplayName = { state: "error", name: null, updatedAt: null };
/** No wallet is connected: there is no name to wait for. */
const NO_WALLET: DisplayName = { state: "ready", name: null, updatedAt: null };

/** Lowercase wallet address to what is known of its name. Shared by every part of the page that shows it. */
const known = new Map<string, DisplayName>();
/** Counts a wallet's changes made from this page, so an answer asked for before a change cannot undo it. */
const changes = new Map<string, number>();
const reading = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
/** Milliseconds the server's clock is ahead of this device's. */
let clockAhead = 0;

function put(wallet: string, next: DisplayName) {
  known.set(wallet, next);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Asks the Worker for `account`'s name. One request at a time per wallet; a name already known stands if this one fails. */
export function loadDisplayName(account: string): Promise<void> {
  const wallet = account.toLowerCase();
  const running = reading.get(wallet);
  if (running) return running;
  const change = changes.get(wallet) ?? 0;
  const request = (async () => {
    try {
      const response = await fetch(`${API}/${wallet}`);
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as { name?: unknown; updatedAt?: unknown } | null;
      if (typeof body !== "object" || body === null) throw new Error("unexpected response");
      const served = Date.parse(response.headers.get("date") ?? "");
      if (Number.isFinite(served)) {
        const ahead = served - Date.now();
        clockAhead = Math.abs(ahead) > CLOCK_SLACK_MS ? ahead : 0;
      }
      // The wallet changed its name from this page while this was on its way: that change is the newer answer.
      if ((changes.get(wallet) ?? 0) !== change) return;
      put(wallet, { state: "ready", name: shownName(body.name), updatedAt: isCount(body.updatedAt) ? body.updatedAt : null });
    } catch {
      if (known.get(wallet)?.state !== "ready") put(wallet, FAILED);
    } finally {
      reading.delete(wallet);
    }
  })();
  reading.set(wallet, request);
  return request;
}

/** The connected wallet's own name, read once and shared: every part of the page sees a change the moment it is saved. */
export function useDisplayName(account: string | null | undefined): DisplayName {
  const wallet = account ? account.toLowerCase() : null;
  const entry = useSyncExternalStore(subscribe, () => (wallet === null ? NO_WALLET : (known.get(wallet) ?? LOADING)));
  useEffect(() => {
    if (wallet !== null && known.get(wallet)?.state !== "ready") void loadDisplayName(wallet);
  }, [wallet]);
  return entry;
}

/**
 * Sets `account`'s name, or removes it when `name` is null: the wallet signs the change, the Worker stores it.
 * `name` has been through `displayNameError` already. Throws the message to show when it does not go through;
 * what the Worker answers is passed on as it is.
 */
export async function saveDisplayName(account: string, name: string | null, onStep?: (step: "signing" | "saving") => void): Promise<void> {
  const wallet = account.toLowerCase();
  const issuedAt = Math.floor((Date.now() + clockAhead) / 1000);
  onStep?.("signing");
  const signature = await personalSign(nameSigningText({ wallet, name, issuedAt }), account);

  onStep?.("saving");
  let response: Response;
  try {
    response = await fetch(`${API}/${wallet}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, issuedAt, signature }),
    });
  } catch {
    throw new Error("Display names could not be reached. Try again.");
  }
  const body = (await response.json().catch(() => null)) as { error?: unknown; updatedAt?: unknown } | null;
  if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "The name could not be saved. Try again.");
  changes.set(wallet, (changes.get(wallet) ?? 0) + 1);
  put(wallet, { state: "ready", name, updatedAt: isCount(body?.updatedAt) ? body.updatedAt : issuedAt });
}
