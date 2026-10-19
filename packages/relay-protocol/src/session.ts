import { concat, framed, fromB64u, text, toB64u, utf8 } from "./bytes.ts";
import { aesKey, agree, equal, generateEphemeral, hkdf, hmac, open, random, seal } from "./crypto.ts";

/**
 * The end-to-end session between a phone and the daemon (ADR 0066). The relay carries these bytes and
 * cannot read or forge them.
 *
 * Both sides share a secret the relay never sees (the pairing code from the QR code's fragment, later a
 * per-device secret). A handshake of two messages authenticates fresh P-256 keys under that secret:
 *
 *   HELLO   phone  → daemon  { v, device, ep, np, mac }       mac = HMAC(K, "hello", device, ep, np)
 *   WELCOME daemon → phone   { v, ed, nd, mac }               mac = HMAC(K, "welcome", device, np, nd, ep, ed)
 *
 * with K = HKDF(secret, "navarch-relay-v1 auth"). The traffic keys come from the ECDH of the fresh keys,
 * one per direction, so a later leak of the secret does not open recorded sessions. Frames are AES-256-GCM
 * with a counter nonce; a counter that does not go up is refused, so a frame cannot be replayed or reordered.
 */

export const VERSION = 1;
export const MAX_FRAME = 1 << 20;

const KIND_HELLO = 1;
const KIND_WELCOME = 2;
const KIND_DATA = 3;
const DIR_CLIENT = 0x63; // "c": phone → daemon
const DIR_SERVER = 0x73; // "s": daemon → phone

export class ProtocolError extends Error {}

type Hello = { v: number; device: string; ep: string; np: string; mac: string };
type Welcome = { v: number; ed: string; nd: string; mac: string };

const authKey = (secret: Uint8Array) => hkdf(secret, new Uint8Array(0), "navarch-relay-v1 auth");
const helloMac = (k: Uint8Array, device: string, ep: Uint8Array, np: Uint8Array) => hmac(k, framed("hello", device, ep, np));
const welcomeMac = (k: Uint8Array, device: string, np: Uint8Array, nd: Uint8Array, ep: Uint8Array, ed: Uint8Array) => hmac(k, framed("welcome", device, np, nd, ep, ed));

function json<T>(frame: Uint8Array, kind: number): T {
  if (frame.length < 2 || frame.length > 4096 || frame[0] !== kind) throw new ProtocolError("unexpected handshake frame");
  return JSON.parse(text(frame.subarray(1))) as T;
}

const handshakeFrame = (kind: number, body: object) => concat(new Uint8Array([kind]), utf8(JSON.stringify(body)));

export class Session {
  readonly deviceId: string;
  private readonly sendKey: CryptoKey;
  private readonly recvKey: CryptoKey;
  private readonly sendDir: number;
  private readonly recvDir: number;
  private sent = 0;
  private received = -1;

  constructor(deviceId: string, sendKey: CryptoKey, recvKey: CryptoKey, role: "client" | "server") {
    this.deviceId = deviceId;
    this.sendKey = sendKey;
    this.recvKey = recvKey;
    this.sendDir = role === "client" ? DIR_CLIENT : DIR_SERVER;
    this.recvDir = role === "client" ? DIR_SERVER : DIR_CLIENT;
  }

  /** One encrypted frame: kind, 8-byte counter, then ciphertext and tag. */
  async seal(plain: Uint8Array): Promise<Uint8Array> {
    if (plain.length > MAX_FRAME) throw new ProtocolError("frame too large");
    if (this.sent >= Number.MAX_SAFE_INTEGER) throw new ProtocolError("session exhausted");
    const counter = this.sent++;
    const head = counterBytes(counter);
    const sealed = await seal(this.sendKey, iv(head), new Uint8Array([KIND_DATA, this.sendDir]), plain);
    return concat(new Uint8Array([KIND_DATA]), head, sealed);
  }

  /** The plaintext of a frame from the other side; throws on a forged, replayed or out-of-order frame. */
  async open(frame: Uint8Array): Promise<Uint8Array> {
    if (frame.length < 1 + 8 + 16 || frame.length > MAX_FRAME + 64 || frame[0] !== KIND_DATA) throw new ProtocolError("bad frame");
    const head = frame.subarray(1, 9);
    const counter = Number(new DataView(head.buffer, head.byteOffset, 8).getBigUint64(0));
    if (!Number.isSafeInteger(counter) || counter <= this.received) throw new ProtocolError("replayed or out-of-order frame");
    let plain: Uint8Array;
    try {
      plain = await open(this.recvKey, iv(head), new Uint8Array([KIND_DATA, this.recvDir]), frame.subarray(9));
    } catch {
      throw new ProtocolError("frame did not authenticate");
    }
    this.received = counter;
    return plain;
  }
}

function counterBytes(n: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
}

const iv = (head: Uint8Array) => concat(new Uint8Array(4), head);

async function trafficKeys(shared: Uint8Array, np: Uint8Array, nd: Uint8Array) {
  const salt = concat(np, nd);
  const [c2s, s2c] = await Promise.all([hkdf(shared, salt, "navarch-relay-v1 c2s"), hkdf(shared, salt, "navarch-relay-v1 s2c")]);
  return { c2s: await aesKey(c2s), s2c: await aesKey(s2c) };
}

export type Pending = { hello: Uint8Array; finish: (welcome: Uint8Array) => Promise<Session> };

/** The phone's first move: the HELLO to send, and what to do with the daemon's answer. */
export async function initiate(secret: Uint8Array, deviceId: string): Promise<Pending> {
  const k = await authKey(secret);
  const eph = await generateEphemeral();
  const np = random(16);
  const hello: Hello = { v: VERSION, device: deviceId, ep: toB64u(eph.publicRaw), np: toB64u(np), mac: toB64u(await helloMac(k, deviceId, eph.publicRaw, np)) };
  return {
    hello: handshakeFrame(KIND_HELLO, hello),
    async finish(frame) {
      const w = json<Welcome>(frame, KIND_WELCOME);
      if (w.v !== VERSION) throw new ProtocolError("unsupported version");
      const ed = fromB64u(w.ed);
      const nd = fromB64u(w.nd);
      if (!equal(fromB64u(w.mac), await welcomeMac(k, deviceId, np, nd, eph.publicRaw, ed))) throw new ProtocolError("the daemon did not prove it knows the secret");
      const keys = await trafficKeys(await agree(eph.privateKey, ed), np, nd);
      return new Session(deviceId, keys.c2s, keys.s2c, "client");
    },
  };
}

export type Accepted = { welcome: Uint8Array; session: Session; deviceId: string; secret: Uint8Array };

/**
 * The daemon's side: checks a HELLO against the secrets that may belong to the device it names (nothing
 * is computed from the phone's key until the MAC checks), and answers. Undefined when it does not match.
 */
export async function accept(hello: Uint8Array, secretsFor: (deviceId: string) => Uint8Array[]): Promise<Accepted | undefined> {
  let h: Hello;
  try {
    h = json<Hello>(hello, KIND_HELLO);
    if (h.v !== VERSION || typeof h.device !== "string" || h.device.length > 128) return undefined;
    const ep = fromB64u(h.ep);
    const np = fromB64u(h.np);
    const mac = fromB64u(h.mac);
    if (ep.length !== 65 || np.length !== 16) return undefined;
    for (const secret of secretsFor(h.device)) {
      const k = await authKey(secret);
      if (!equal(mac, await helloMac(k, h.device, ep, np))) continue;
      const eph = await generateEphemeral();
      const nd = random(16);
      const welcome: Welcome = { v: VERSION, ed: toB64u(eph.publicRaw), nd: toB64u(nd), mac: toB64u(await welcomeMac(k, h.device, np, nd, ep, eph.publicRaw)) };
      const keys = await trafficKeys(await agree(eph.privateKey, ep), np, nd);
      return { welcome: handshakeFrame(KIND_WELCOME, welcome), session: new Session(h.device, keys.s2c, keys.c2s, "server"), deviceId: h.device, secret };
    }
  } catch {
    return undefined;
  }
  return undefined;
}
