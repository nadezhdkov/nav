import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

function readStored(path: string): Stored | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Stored>;
    return raw.relay_id && raw.token && raw.key ? (raw as Stored) : undefined;
  } catch {
    return undefined;
  }
}

export function loadRelayIdentity(home: string): RelayIdentity {
  const dir = join(home, "relay");
  const path = join(dir, "identity.json");
  let stored = readStored(path);
  if (!stored) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fresh: Stored = { relay_id: randomBytes(16).toString("base64url"), token: randomBytes(32).toString("base64url"), key: randomBytes(32).toString("base64url") };
    try {
      // `wx` fails when the file exists, so two daemons starting together cannot overwrite each other's identity.
      writeFileSync(path, JSON.stringify(fresh), { mode: 0o600, flag: "wx" });
      stored = fresh;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      stored = readStored(path);
      if (!stored) {
        // An unreadable file (damaged JSON) is replaced, as before.
        writeFileSync(path, JSON.stringify(fresh), { mode: 0o600 });
        stored = fresh;
      }
    }
    chmodSync(path, 0o600);
  }
  const key = Buffer.from(stored.key, "base64url");
  return {
    relayId: stored.relay_id,
    token: stored.token,
    deviceSecret: (deviceId) => new Uint8Array(createHmac("sha256", key).update(`device:${deviceId}`).digest()),
  };
}
