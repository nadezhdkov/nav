/**
 * The primitives of the relay protocol, all from WebCrypto (`crypto.subtle`), which Node 22 and every
 * current browser have: HKDF-SHA-256, HMAC-SHA-256, ECDH on P-256 and AES-256-GCM. One implementation, so
 * the daemon, the relay's tests and the phone's loader run the same code.
 */

const subtle = globalThis.crypto.subtle;
// What WebCrypto takes as bytes, read from its own signature so no DOM or Node type is imported.
type BufferSource = Parameters<typeof subtle.digest>[1];
const bs = (b: Uint8Array) => b as BufferSource;

export const random = (n: number): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(n));

export async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string, length = 32): Promise<Uint8Array> {
  const key = await subtle.importKey("raw", bs(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: bs(salt), info: bs(new TextEncoder().encode(info)) }, key, length * 8));
}

export async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await subtle.importKey("raw", bs(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", k, bs(data)));
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest("SHA-256", bs(data)));
}

/** Constant-time comparison of two byte strings. */
export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export type EphemeralKey = { privateKey: CryptoKey; publicRaw: Uint8Array };

export async function generateEphemeral(): Promise<EphemeralKey> {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  return { privateKey: pair.privateKey, publicRaw: new Uint8Array(await subtle.exportKey("raw", pair.publicKey)) };
}

export async function agree(privateKey: CryptoKey, peerRaw: Uint8Array): Promise<Uint8Array> {
  const peer = await subtle.importKey("raw", bs(peerRaw), { name: "ECDH", namedCurve: "P-256" }, false, []);
  return new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: peer }, privateKey, 256));
}

export const aesKey = (raw: Uint8Array): Promise<CryptoKey> => subtle.importKey("raw", bs(raw), "AES-GCM", false, ["encrypt", "decrypt"]);

export async function seal(key: CryptoKey, iv: Uint8Array, aad: Uint8Array, plain: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: bs(iv), additionalData: bs(aad) }, key, bs(plain)));
}

export async function open(key: CryptoKey, iv: Uint8Array, aad: Uint8Array, sealed: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: bs(iv), additionalData: bs(aad) }, key, bs(sealed)));
}
