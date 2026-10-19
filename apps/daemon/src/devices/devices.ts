import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Locale, newId, type Actor, type DevicePairing, type DeviceSession, type DeviceView, type PushSubscriptionRequest } from "@navarch/contracts";
import type { EventStore } from "../events/store.ts";

export const PAIRING_TTL_MS = 5 * 60_000;
export const ACCESS_TTL_MS = 15 * 60_000;
export const REFRESH_TTL_MS = 30 * 86_400_000;
/** Two tabs refreshing at once present the same token; within this window that is not theft. */
const REUSE_GRACE_MS = 60_000;
const LAST_SEEN_EVERY_MS = 60_000;

export class DeviceError extends Error {
  readonly code: "unauthorized" | "not_found" | "conflict";
  constructor(code: DeviceError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/** A stored push subscription of one device. */
export interface DeviceSubscription {
  device_id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  locale: Locale;
}

const system: Actor = { kind: "system", component: "devices" };

/**
 * Paired phones (ADR 0020, spec §6.12.3). Pairing codes live in memory; a device's existence and
 * revocation are events; its refresh-token hash and push subscription are credentials kept in
 * tables that are not projections.
 */
export class DeviceService {
  private readonly store: EventStore;
  private readonly key: Buffer;
  private readonly now: () => number;
  private readonly pairings = new Map<string, number>();
  private readonly seen = new Map<string, number>();

  constructor(store: EventStore, keyFile: string, now: () => number = Date.now) {
    this.store = store;
    this.key = loadKey(keyFile);
    this.now = now;
  }

  /** A single-use code for `remoteUrl/#pair=<code>`, shown as a QR code on the desktop. */
  createPairing(remoteUrl: string): DevicePairing {
    const now = this.now();
    for (const [c, expires] of this.pairings) if (expires <= now) this.pairings.delete(c);
    const code = randomBytes(32).toString("base64url");
    this.pairings.set(code, now + PAIRING_TTL_MS);
    const url = `${remoteUrl.replace(/\/+$/, "")}/#pair=${code}`;
    return { code, url, expires_at: new Date(now + PAIRING_TTL_MS).toISOString() };
  }

  pair(code: string, name: string): DeviceSession {
    const expires = this.pairings.get(code);
    this.pairings.delete(code);
    if (expires === undefined || expires <= this.now()) throw new DeviceError("unauthorized", "unknown or expired pairing code; pair again from the desktop");
    const id = newId("dev");
    this.store.append([{ type: "device.paired", run_id: null, task_id: null, actor: { kind: "user", via: "mobile", device_id: id }, payload: { device_id: id, name } }]);
    const refresh = newRefreshToken();
    this.store.db
      .prepare("INSERT INTO device_credentials (device_id, refresh_hash, refresh_expires_at, last_seen_at) VALUES (?, ?, ?, ?)")
      .run(id, hash(refresh), this.iso(REFRESH_TTL_MS), this.iso(0));
    return this.session(id, refresh);
  }

  /** Trades a refresh token for a new pair; reusing a rotated one revokes the device. */
  refresh(token: string): DeviceSession {
    const h = hash(token);
    const row = this.store.db.prepare("SELECT device_id, refresh_expires_at FROM device_credentials WHERE refresh_hash = ?").get(h) as
      | { device_id: string; refresh_expires_at: string }
      | undefined;
    if (!row) {
      const used = this.store.db.prepare("SELECT device_id, used_at FROM device_refresh_used WHERE hash = ?").get(h) as
        | { device_id: string; used_at: string }
        | undefined;
      if (used && this.now() - Date.parse(used.used_at) > REUSE_GRACE_MS) {
        this.revoke(used.device_id, system, "a refresh token was used twice");
      }
      throw new DeviceError("unauthorized", "refresh token is not valid");
    }
    const device = this.store.getDevice(row.device_id);
    if (!device || device.revoked_at) throw new DeviceError("unauthorized", "device was revoked");
    if (Date.parse(row.refresh_expires_at) <= this.now()) throw new DeviceError("unauthorized", "refresh token expired; pair again");

    const next = newRefreshToken();
    this.store.db.exec("BEGIN");
    try {
      this.store.db.prepare("INSERT OR REPLACE INTO device_refresh_used (hash, device_id, used_at) VALUES (?, ?, ?)").run(h, row.device_id, this.iso(0));
      this.store.db
        .prepare("UPDATE device_credentials SET refresh_hash = ?, refresh_expires_at = ?, rotated_at = ?, last_seen_at = ? WHERE device_id = ?")
        .run(hash(next), this.iso(REFRESH_TTL_MS), this.iso(0), this.iso(0), row.device_id);
      this.store.db.exec("COMMIT");
    } catch (err) {
      this.store.db.exec("ROLLBACK");
      throw err;
    }
    return this.session(row.device_id, next);
  }

  /** The device an access token belongs to, if it is genuine, unexpired and not revoked. */
  authenticate(token: string): string | undefined {
    if (!token.startsWith("nvd_")) return undefined;
    const [body, sig] = token.slice(4).split(".");
    if (!body || !sig) return undefined;
    const expected = this.sign(body);
    const given = Buffer.from(sig, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    let claims: { d?: unknown; e?: unknown };
    try {
      claims = JSON.parse(Buffer.from(body, "base64url").toString());
    } catch {
      return undefined;
    }
    if (typeof claims.d !== "string" || typeof claims.e !== "number" || claims.e <= this.now()) return undefined;
    const device = this.store.getDevice(claims.d);
    if (!device || device.revoked_at) return undefined;
    this.touch(claims.d);
    return claims.d;
  }

  revoke(deviceId: string, actor: Actor, reason: string): DeviceView {
    const device = this.store.getDevice(deviceId);
    if (!device) throw new DeviceError("not_found", `device ${deviceId} not found`);
    if (!device.revoked_at) {
      this.store.append([{ type: "device.revoked", run_id: null, task_id: null, actor, payload: { device_id: deviceId, reason } }]);
      this.store.db.prepare("DELETE FROM device_credentials WHERE device_id = ?").run(deviceId);
      this.store.db.prepare("DELETE FROM push_subscriptions WHERE device_id = ?").run(deviceId);
    }
    return this.store.getDevice(deviceId)!;
  }

  list(): DeviceView[] {
    return this.store.listDevices();
  }

  get(deviceId: string): DeviceView | undefined {
    return this.store.getDevice(deviceId);
  }

  setSubscription(deviceId: string, sub: PushSubscriptionRequest, actor: Actor): void {
    this.store.db
      .prepare("INSERT OR REPLACE INTO push_subscriptions (device_id, endpoint, p256dh, auth, locale, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(deviceId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, sub.locale, this.iso(0));
    if (!this.store.getDevice(deviceId)?.push) {
      this.store.append([{ type: "device.push_changed", run_id: null, task_id: null, actor, payload: { device_id: deviceId, enabled: true } }]);
    }
  }

  clearSubscription(deviceId: string, actor: Actor): void {
    this.store.db.prepare("DELETE FROM push_subscriptions WHERE device_id = ?").run(deviceId);
    if (this.store.getDevice(deviceId)?.push) {
      this.store.append([{ type: "device.push_changed", run_id: null, task_id: null, actor, payload: { device_id: deviceId, enabled: false } }]);
    }
  }

  /** Subscriptions of devices that are not revoked. */
  subscriptions(): DeviceSubscription[] {
    const rows = this.store.db
      .prepare("SELECT s.* FROM push_subscriptions s JOIN devices d ON d.id = s.device_id WHERE d.revoked_at IS NULL")
      .all() as { device_id: string; endpoint: string; p256dh: string; auth: string; locale: string }[];
    return rows.map((r) => ({
      device_id: r.device_id,
      endpoint: r.endpoint,
      keys: { p256dh: r.p256dh, auth: r.auth },
      locale: Locale.safeParse(r.locale).data ?? "en",
    }));
  }

  private session(deviceId: string, refresh: string): DeviceSession {
    const expires = this.now() + ACCESS_TTL_MS;
    const body = Buffer.from(JSON.stringify({ d: deviceId, e: expires })).toString("base64url");
    return {
      device: this.store.getDevice(deviceId)!,
      access_token: `nvd_${body}.${this.sign(body).toString("base64url")}`,
      access_expires_at: new Date(expires).toISOString(),
      refresh_token: refresh,
    };
  }

  private sign(body: string): Buffer {
    return createHmac("sha256", this.key).update(`nvd.${body}`).digest();
  }

  private touch(deviceId: string): void {
    const now = this.now();
    if (now - (this.seen.get(deviceId) ?? 0) < LAST_SEEN_EVERY_MS) return;
    this.seen.set(deviceId, now);
    this.store.db.prepare("UPDATE device_credentials SET last_seen_at = ? WHERE device_id = ?").run(new Date(now).toISOString(), deviceId);
  }

  private iso(offsetMs: number): string {
    return new Date(this.now() + offsetMs).toISOString();
  }
}

function newRefreshToken(): string {
  return `nvr_${randomBytes(32).toString("base64url")}`;
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The HMAC key for access tokens, created on first use (mode 0600). */
export function loadKey(file: string): Buffer {
  const read = (): Buffer | undefined => {
    try {
      return Buffer.from(readFileSync(file, "utf8").trim(), "base64url");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  };
  const existing = read();
  if (existing && existing.length >= 32) return existing;
  mkdirSync(dirname(file), { recursive: true });
  const key = randomBytes(32);
  // No file yet: create it exclusively, and if another process made one first, use that. A file that is
  // there but too short to be a key is replaced.
  try {
    writeFileSync(file, key.toString("base64url") + "\n", { mode: 0o600, flag: existing ? "w" : "wx" });
    // `mode` only applies when the file is created; a file that was there keeps its old permissions.
    chmodSync(file, 0o600);
    return key;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const winner = read();
    if (!winner || winner.length < 32) throw err;
    return winner;
  }
}
