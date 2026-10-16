import type { DeviceSession } from "@navarch/contracts";
import { ref } from "vue";
import { getToken } from "./token.ts";

/**
 * A paired phone's session (ADR 0020). The refresh token is kept in localStorage so the installed
 * app stays signed in; the 15-minute access token lives in memory only. Refreshes are serialized,
 * across tabs too, because the daemon rotates the refresh token on every use.
 */

const KEY = "navarch.device";
/** What `tailscale serve` (or another proxy) answers while the daemon behind it is down. */
export const GATEWAY = new Set([502, 503, 504]);
/** Refresh this long before the access token expires. */
const EARLY_MS = 60_000;

interface Stored {
  device_id: string;
  name: string;
  refresh_token: string;
}

/** True when this browser signs in as a paired device instead of with the local token. */
export const isDevice = ref(load() !== null);

let access: { token: string; expires: number } | null = null;
let inflight: Promise<string | null> | null = null;

function load(): Stored | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null;
  }
}

function save(session: DeviceSession): void {
  access = { token: session.access_token, expires: Date.parse(session.access_expires_at) };
  const stored: Stored = { device_id: session.device.id, name: session.device.name, refresh_token: session.refresh_token };
  try {
    localStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // Storage blocked: the session lasts as long as this page.
  }
  isDevice.value = true;
}

/** Forgets this device's session (signed out, revoked, or the refresh token was refused). */
export function forgetDevice(): void {
  access = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
  isDevice.value = false;
}

export function deviceId(): string | null {
  return load()?.device_id ?? null;
}

/** Trades a pairing code from the desktop's QR code for a session. */
export async function pairDevice(code: string, name: string): Promise<boolean> {
  const res = await fetch("/api/v1/devices/pair", {
    method: "POST",
    headers: { "content-type": "application/json", "x-navarch-client": "mobile" },
    body: JSON.stringify({ code, name }),
  });
  if (!res.ok) return false;
  save((await res.json()) as DeviceSession);
  return true;
}

/** The bearer token to send: the local token on the desktop, else a fresh device access token. */
export async function bearer(): Promise<string | null> {
  const local = getToken();
  if (local) return local;
  if (!load()) return null;
  if (access && access.expires - EARLY_MS > Date.now()) return access.token;
  return refresh();
}

/** The current token without refreshing, for code that cannot wait (it may be about to expire). */
export function currentBearer(): string | null {
  return getToken() ?? access?.token ?? null;
}

/** Gets a new access token; one refresh at a time in this tab and, where supported, across tabs. */
export function refresh(): Promise<string | null> {
  inflight ??= (async () => {
    try {
      const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
      return locks ? await locks.request(KEY, () => doRefresh()) : await doRefresh();
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

async function doRefresh(): Promise<string | null> {
  // Another tab may have refreshed while this one waited for the lock: its token is in storage.
  const before = access;
  const stored = load();
  if (!stored) return null;
  if (before && before.expires - EARLY_MS > Date.now()) return before.token;
  // A network failure throws; the caller reports the daemon as unreachable, and the device stays paired.
  const res = await fetch("/api/v1/devices/refresh", {
    method: "POST",
    headers: { "content-type": "application/json", "x-navarch-client": "mobile" },
    body: JSON.stringify({ refresh_token: stored.refresh_token }),
  });
  // `tailscale serve` answers 502–504 while the daemon is down: not a refused token either.
  if (GATEWAY.has(res.status)) throw new TypeError(`the daemon did not answer (${res.status})`);
  if (res.status === 401) {
    // Rotated by another tab in the meantime? Then storage holds a newer token: try that once.
    const latest = load();
    if (latest && latest.refresh_token !== stored.refresh_token) return doRefresh();
    forgetDevice();
    return null;
  }
  if (!res.ok) return null;
  const session = (await res.json()) as DeviceSession;
  save(session);
  return session.access_token;
}
