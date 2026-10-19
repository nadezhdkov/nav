import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What this daemon is to a relay (ADR 0066): an id the phones' address contains, a token that proves to the
 * relay that the daemon owns that id, and a key from which each paired phone's secret is derived. It is a
 * daemon credential like `~/.navarch/token` and the VAPID key, so it lives next to them with mode 0600.
 */
export type RelayIdentity = {
  relayId: string;
  token: string;
  /** A phone's secret for the end-to-end handshake; the relay never sees it. */
  deviceSecret(deviceId: string): Uint8Array;
};

type Stored = { relay_id: string; token: string; key: string };

export function loadRelayIdentity(home: string): RelayIdentity {
  const dir = join(home, "relay");
  const path = join(dir, "identity.json");
  let stored: Stored | undefined;
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Stored>;
      if (raw.relay_id && raw.token && raw.key) stored = raw as Stored;
    } catch {
      stored = undefined;
    }
  }
  if (!stored) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    stored = { relay_id: randomBytes(16).toString("base64url"), token: randomBytes(32).toString("base64url"), key: randomBytes(32).toString("base64url") };
    writeFileSync(path, JSON.stringify(stored), { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  const key = Buffer.from(stored.key, "base64url");
  return {
    relayId: stored.relay_id,
    token: stored.token,
    deviceSecret: (deviceId) => new Uint8Array(createHmac("sha256", key).update(`device:${deviceId}`).digest()),
  };
}
