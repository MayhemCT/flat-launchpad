// Signing in: once per device, the wallet signs one plain text and this site's Worker answers with a session
// token (apps/worker/src/session.ts). Rooms, clans and everything else that is private or personal is asked
// for with that token, so nobody signs every request. The token is kept in this browser's storage and sent as
// an Authorization header, never as a cookie: no other site can make this browser send it. It proves who is
// asking and nothing more; every on-chain action is still a transaction the wallet confirms itself.
import { useSyncExternalStore } from "react";
import { personalSign } from "./wallet";

const KEY = "callz.session";
/** A device clock further than this from the server's is corrected for; anything less is network delay. */
const CLOCK_SLACK_MS = 30_000;

interface Session {
  /** Lowercase address. */
  wallet: string;
  token: string;
  /** Unix seconds. */
  expiresAt: number;
}

function stored(): Session | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(KEY) ?? "null") as Partial<Session> | null;
    if (!value || typeof value.wallet !== "string" || typeof value.token !== "string" || typeof value.expiresAt !== "number") return null;
    if (!/^0x[0-9a-f]{40}$/.test(value.wallet) || !/^[0-9a-f]{64}$/.test(value.token) || value.expiresAt * 1000 <= Date.now()) return null;
    return { wallet: value.wallet, token: value.token, expiresAt: value.expiresAt };
  } catch {
    // Storage is blocked or holds something else: not signed in.
    return null;
  }
}

let session: Session | null = typeof window === "undefined" ? null : stored();
const listeners = new Set<() => void>();

function set(next: Session | null) {
  session = next;
  try {
    if (next) window.localStorage.setItem(KEY, JSON.stringify(next));
    else window.localStorage.removeItem(KEY);
  } catch {
    // Without storage the session lasts until the page is closed.
  }
  for (const listener of listeners) listener();
}

/** The wallet this browser is signed in as (lowercase), or null. */
export function sessionWallet(): string | null {
  return session && session.expiresAt * 1000 > Date.now() ? session.wallet : null;
}

/**
 * Whether `account`, the connected wallet, is signed in. A session belongs to one wallet: after switching
 * accounts in the wallet, the new account signs in itself.
 */
export function useSignedIn(account: string | null | undefined): boolean {
  const wallet = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sessionWallet,
  );
  return !!account && wallet === account.toLowerCase();
}

/**
 * The exact text the wallet signs to sign in.
 * Keep in sync with `sessionSigningText` in apps/worker/src/session.ts: one character of difference and no signature verifies.
 */
export function sessionSigningText({ wallet, issuedAt }: { wallet: string; issuedAt: number }): string {
  return `CallZ sign-in\n\nWallet: ${wallet.toLowerCase()}\nSite: callz.fun\nTime: ${issuedAt}\n\nSigning this proves the wallet is yours. It sends no transaction and costs nothing.`;
}

/** What the API said went wrong, with the HTTP status it said it with. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function failed(response: Response): Promise<ApiError> {
  let message = "The request did not go through. Try again.";
  try {
    const body = (await response.json()) as { error?: unknown } | null;
    if (body && typeof body.error === "string") message = body.error;
  } catch {
    // Not JSON: the general message stands.
  }
  // The session ran out or was signed out elsewhere: this browser is no longer signed in.
  if (response.status === 401 && session) set(null);
  return new ApiError(message, response.status);
}

/** Signs `account` in: the wallet signs the sign-in text, the Worker answers with the session. Throws the message to show. */
export async function signIn(account: string): Promise<void> {
  const wallet = account.toLowerCase();
  // The Worker checks the time in the text against its own clock, so a wrong device clock is corrected first.
  let ahead = 0;
  try {
    const probe = await fetch("/api/session", { method: "HEAD" });
    const served = Date.parse(probe.headers.get("date") ?? "");
    if (Number.isFinite(served) && Math.abs(served - Date.now()) > CLOCK_SLACK_MS) ahead = served - Date.now();
  } catch {
    // The sign-in itself will say if the Worker cannot be reached.
  }
  const issuedAt = Math.floor((Date.now() + ahead) / 1000);
  const signature = await personalSign(sessionSigningText({ wallet, issuedAt }), account);
  let response: Response;
  try {
    response = await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet, issuedAt, signature }) });
  } catch {
    throw new Error("The sign-in could not be sent. Check your connection and try again.");
  }
  if (!response.ok) throw await failed(response);
  const body = (await response.json()) as Partial<Session>;
  if (typeof body.token !== "string" || typeof body.expiresAt !== "number") throw new Error("The sign-in answer was not understood. Try again.");
  set({ wallet, token: body.token, expiresAt: body.expiresAt });
}

/** Signs this browser out. The token stops working on the Worker too. */
export function signOut(): void {
  const token = session?.token;
  set(null);
  if (token) void fetch("/api/session", { method: "DELETE", headers: { authorization: `Bearer ${token}` } }).catch(() => undefined);
}

export interface ApiOptions {
  /** POST this as JSON. */
  body?: unknown;
  /** POST these bytes as they are (a picture). */
  bytes?: Blob;
  signal?: AbortSignal;
}

function request(path: string, { body, bytes, signal }: ApiOptions): Promise<Response> {
  const headers: Record<string, string> = {};
  const token = sessionWallet() ? session!.token : null;
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  if (bytes) headers["content-type"] = bytes.type || "application/octet-stream";
  const posting = body !== undefined || bytes !== undefined;
  return fetch(path, {
    method: posting ? "POST" : "GET",
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : bytes ? { body: bytes } : {}),
    ...(signal ? { signal } : {}),
  });
}

/**
 * Asks this site's API, signed in when this browser is. A GET without `body` or `bytes`, a POST with either.
 * Resolves with the JSON answer; throws an `ApiError` carrying the API's own message when it refuses.
 */
export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await request(path, options);
  } catch (cause) {
    if ((cause as { name?: string } | null)?.name === "AbortError") throw cause;
    throw new ApiError("The site could not be reached. Check your connection and try again.", 0);
  }
  if (!response.ok) throw await failed(response);
  return (await response.json()) as T;
}

/** A private picture, fetched signed in. The caller shows it through an object URL and revokes that when done. */
export async function apiBlob(path: string, signal?: AbortSignal): Promise<Blob> {
  let response: Response;
  try {
    response = await request(path, signal ? { signal } : {});
  } catch (cause) {
    if ((cause as { name?: string } | null)?.name === "AbortError") throw cause;
    throw new ApiError("The picture could not be loaded.", 0);
  }
  if (!response.ok) throw await failed(response);
  return response.blob();
}
