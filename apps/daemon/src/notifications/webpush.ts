import { createCipheriv, createECDH, createPrivateKey, createPublicKey, hkdfSync, randomBytes, sign } from "node:crypto";

/**
 * Web Push without dependencies (ADR 0020): VAPID (RFC 8292) to identify the daemon to push
 * services, and `aes128gcm` (RFC 8291) to encrypt the payload for the browser.
 */

/** A P-256 key pair as browsers expect it: base64url of the 65-byte uncompressed point and the 32-byte scalar. */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** A browser's subscription: where to POST and the keys the payload is encrypted for. */
export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKey: ecdh.getPublicKey().toString("base64url"), privateKey: ecdh.getPrivateKey().toString("base64url") };
}

const RECORD_SIZE = 4096;

/**
 * Encrypts `plaintext` for one subscription as a single `aes128gcm` record (RFC 8291 §4). `salt` and
 * `serverKeys` are random per message; tests pass the RFC's fixed values.
 */
export function encryptPayload(
  plaintext: Buffer,
  target: PushTarget["keys"],
  fixed: { salt?: Buffer; serverKeys?: VapidKeys } = {},
): Buffer {
  const uaPublic = Buffer.from(target.p256dh, "base64url");
  const authSecret = Buffer.from(target.auth, "base64url");
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error("p256dh is not an uncompressed P-256 point");
  if (authSecret.length !== 16) throw new Error("auth secret must be 16 bytes");

  const ecdh = createECDH("prime256v1");
  if (fixed.serverKeys) ecdh.setPrivateKey(Buffer.from(fixed.serverKeys.privateKey, "base64url"));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const salt = fixed.salt ?? randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);

  // One record: the plaintext, then the 0x02 delimiter of the last record (no padding).
  const record = Buffer.concat([plaintext, Buffer.from([0x02])]);
  if (record.length + 16 > RECORD_SIZE) throw new Error("push payload too large");
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, ciphertext]);
}

/**
 * The `Authorization` header for a push service (RFC 8292): an ES256 JWT for the endpoint's
 * origin, valid for `ttlSeconds` (at most 24 h), and the public key.
 */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now(), ttlSeconds = 12 * 3600): string {
  const header = b64json({ typ: "JWT", alg: "ES256" });
  const claims = b64json({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + ttlSeconds, sub: subject });
  const input = `${header}.${claims}`;
  const signature = sign("sha256", Buffer.from(input), { key: privateKeyObject(keys), dsaEncoding: "ieee-p1363" });
  return `vapid t=${input}.${signature.toString("base64url")}, k=${keys.publicKey}`;
}

/** The public half as a KeyObject, to verify signatures in tests. */
export function vapidPublicKeyObject(keys: VapidKeys) {
  const { x, y } = point(keys.publicKey);
  return createPublicKey({ key: { kty: "EC", crv: "P-256", x, y }, format: "jwk" });
}

export interface PushOptions {
  vapid: VapidKeys;
  subject: string;
  /** Seconds the push service keeps the message for an offline device. */
  ttl?: number;
  urgency?: "very-low" | "low" | "normal" | "high";
  /** Replaces a pending message with the same topic (≤ 32 base64url characters). */
  topic?: string;
  fetch?: typeof fetch;
  now?: number;
}

/** POSTs one encrypted message; returns the push service's status (201 on success, 404/410 when gone). */
export async function sendPush(target: PushTarget, payload: unknown, options: PushOptions): Promise<{ status: number; body: string }> {
  const body = encryptPayload(Buffer.from(JSON.stringify(payload)), target.keys);
  const headers: Record<string, string> = {
    "content-encoding": "aes128gcm",
    "content-type": "application/octet-stream",
    ttl: String(options.ttl ?? 24 * 3600),
    urgency: options.urgency ?? "normal",
    authorization: vapidAuthorization(target.endpoint, options.vapid, options.subject, options.now),
  };
  if (options.topic) headers.topic = options.topic;
  const res = await (options.fetch ?? fetch)(target.endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(15_000) });
  return { status: res.status, body: await res.text().catch(() => "") };
}

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  return Buffer.from(hkdfSync("sha256", ikm, salt, info, length));
}

function b64json(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function point(publicKey: string): { x: string; y: string } {
  const raw = Buffer.from(publicKey, "base64url");
  if (raw.length !== 65 || raw[0] !== 0x04) throw new Error("VAPID public key is not an uncompressed P-256 point");
  return { x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") };
}

function privateKeyObject(keys: VapidKeys) {
  return createPrivateKey({ key: { kty: "EC", crv: "P-256", d: keys.privateKey, ...point(keys.publicKey) }, format: "jwk" });
}
