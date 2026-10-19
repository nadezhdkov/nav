import {
  accept,
  bodyBytes,
  CHUNK_BYTES,
  concat,
  decodeMessage,
  encodeMessage,
  fromB64u,
  MAX_IN_FLIGHT,
  MAX_REQUEST_BODY,
  MAX_RESPONSE_BODY,
  MAX_STREAMS,
  text,
  toB64u,
  utf8,
  type Message,
  type Session,
} from "@navarch/relay-protocol";
import type { DeviceSession } from "@navarch/contracts";
import type { RelayIdentity } from "./identity.ts";

/**
 * The daemon's end of the relay (ADR 0066). It dials out to the relay, answers each phone's handshake with
 * the secret of the device it names, and then serves that phone's requests by calling the daemon's own API
 * on loopback, with the phone's own bearer token, so every rule of the REST API (device allowlist, policy)
 * applies exactly as it does over Tailscale. Nothing here can do more than a request from that phone could.
 */

export interface RelayDevices {
  /** Pairing codes that can still be used. */
  activePairingCodes(): string[];
  isActive(deviceId: string): boolean;
  pair(code: string, name: string): DeviceSession;
}

export type ConnectorDeps = {
  relayUrl: string;
  identity: RelayIdentity;
  devices: RelayDevices;
  /** The daemon's own port, for the loopback calls. */
  port: () => number;
  log?: (line: string) => void;
  /** Delay before reconnecting after attempt n (tests shorten it). */
  backoff?: (attempt: number) => number;
};

type Channel = {
  id: string;
  session?: Session;
  /** A pairing channel may only enroll; a device channel may only call the API. */
  kind?: "pairing" | "device";
  deviceId?: string;
  code?: string;
  inflight: number;
  streams: Map<number, WebSocket>;
  incoming: Promise<void>;
  outgoing: Promise<void>;
  handshaken: boolean;
};

const HANDSHAKES_PER_MINUTE = 30;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "DELETE"]);
/** Headers a phone may pass on; anything else is dropped, and the relay marker is always ours. */
const REQUEST_HEADERS = ["authorization", "content-type", "accept", "if-none-match", "x-navarch-client"];
const RESPONSE_HEADERS = ["content-type", "cache-control", "etag", "location", "content-security-policy", "x-content-type-options", "referrer-policy"];
export const RELAY_MARKER = "x-navarch-relay";

export class RelayConnector {
  private readonly deps: ConnectorDeps;
  private socket: WebSocket | undefined;
  private readonly channels = new Map<string, Channel>();
  private stopped = false;
  private ready = false;
  private attempt = 0;
  private timer: NodeJS.Timeout | undefined;
  private handshakes: number[] = [];

  constructor(deps: ConnectorDeps) {
    this.deps = deps;
  }

  get connected(): boolean {
    return this.ready;
  }

  /** The address a phone opens: the relay's page for this daemon. */
  get phoneUrl(): string {
    return `${this.deps.relayUrl.replace(/\/+$/, "")}/r/${this.deps.identity.relayId}`;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const chan of [...this.channels.values()]) this.drop(chan, false);
    this.socket?.close(1000);
    this.socket = undefined;
    this.ready = false;
  }

  private connect(): void {
    if (this.stopped) return;
    const url = `${this.deps.relayUrl.replace(/\/+$/, "").replace(/^http/, "ws")}/d`;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      this.deps.log?.(`relay: bad address (${(err as Error).message})`);
      return;
    }
    this.socket = socket;
    socket.addEventListener("open", () => socket.send(JSON.stringify({ t: "auth", relay: this.deps.identity.relayId, token: this.deps.identity.token })));
    socket.addEventListener("message", (e) => this.onMessage(String(e.data)));
    const lost = () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.ready = false;
      for (const chan of [...this.channels.values()]) this.drop(chan, false);
      if (this.stopped) return;
      const wait = this.deps.backoff?.(this.attempt) ?? Math.min(60_000, 1_000 * 2 ** this.attempt);
      this.attempt++;
      this.timer = setTimeout(() => this.connect(), wait);
      this.timer.unref();
    };
    socket.addEventListener("close", lost);
    socket.addEventListener("error", () => {});
  }

  private onMessage(raw: string): void {
    let m: { t?: string; c?: string; d?: string };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.t === "ready") {
      this.ready = true;
      this.attempt = 0;
      this.deps.log?.("relay: connected");
      return;
    }
    if (typeof m.c !== "string") return;
    if (m.t === "open") {
      if (this.channels.size >= 64) return this.sendRelay({ t: "close", c: m.c });
      this.channels.set(m.c, { id: m.c, inflight: 0, streams: new Map(), incoming: Promise.resolve(), outgoing: Promise.resolve(), handshaken: false });
    } else if (m.t === "close") {
      const chan = this.channels.get(m.c);
      if (chan) this.drop(chan, false);
    } else if (m.t === "data" && typeof m.d === "string") {
      const chan = this.channels.get(m.c);
      if (!chan) return;
      let frame: Uint8Array;
      try {
        frame = fromB64u(m.d);
      } catch {
        return this.drop(chan, true);
      }
      chan.incoming = chan.incoming.then(() => this.frame(chan, frame)).catch(() => this.drop(chan, true));
    }
  }

  private async frame(chan: Channel, frame: Uint8Array): Promise<void> {
    if (!chan.handshaken) {
      chan.handshaken = true;
      const now = Date.now();
      this.handshakes = this.handshakes.filter((t) => now - t < 60_000);
      if (this.handshakes.length >= HANDSHAKES_PER_MINUTE) return this.drop(chan, true);
      this.handshakes.push(now);
      const accepted = await accept(frame, (id) => (id === "pairing" ? this.deps.devices.activePairingCodes().map(utf8) : this.deps.devices.isActive(id) ? [this.deps.identity.deviceSecret(id)] : []));
      if (!accepted) return this.drop(chan, true);
      chan.session = accepted.session;
      chan.kind = accepted.deviceId === "pairing" ? "pairing" : "device";
      chan.deviceId = accepted.deviceId;
      if (chan.kind === "pairing") chan.code = text(accepted.secret);
      this.sendRelay({ t: "data", c: chan.id, d: toB64u(accepted.welcome) });
      return;
    }
    const session = chan.session;
    if (!session) return this.drop(chan, true);
    // A phone that was revoked loses its channel at its next frame.
    if (chan.kind === "device" && !this.deps.devices.isActive(chan.deviceId!)) return this.drop(chan, true);
    const message = decodeMessage(await session.open(frame));
    void this.dispatch(chan, message).catch((err: Error) => this.reply(chan, { k: "err", id: message.id, message: err.message.slice(0, 200) }));
  }

  private async dispatch(chan: Channel, m: Message): Promise<void> {
    if (chan.kind === "pairing") {
      if (m.k !== "enroll") return this.drop(chan, true);
      // The pairing code is single use: enrolling spends it, and the channel ends with the answer.
      const session = this.deps.devices.pair(chan.code!, m.name.slice(0, 80) || "Phone");
      const secret = toB64u(this.deps.identity.deviceSecret(session.device.id));
      await this.reply(chan, { k: "enrolled", id: m.id, session, secret });
      return this.drop(chan, true);
    }
    if (m.k === "req") return this.request(chan, m);
    if (m.k === "sub") return this.subscribe(chan, m);
    if (m.k === "send") {
      const ws = chan.streams.get(m.id);
      if (ws?.readyState === 1) ws.send(m.d);
      return;
    }
    if (m.k === "end") {
      chan.streams.get(m.id)?.close();
      return;
    }
    this.drop(chan, true);
  }

  private async request(chan: Channel, m: Extract<Message, { k: "req" }>): Promise<void> {
    if (!METHODS.has(m.method) || !safePath(m.path)) return void (await this.reply(chan, { k: "err", id: m.id, message: "request refused" }));
    if (chan.inflight >= MAX_IN_FLIGHT) return void (await this.reply(chan, { k: "err", id: m.id, message: "too many requests at once" }));
    const body = bodyBytes(m.body);
    if (body.length > MAX_REQUEST_BODY) return void (await this.reply(chan, { k: "err", id: m.id, message: "request body too large" }));
    chan.inflight++;
    try {
      const res = await fetch(`http://127.0.0.1:${this.deps.port()}${m.path}`, {
        method: m.method,
        headers: forwarded(m.headers),
        redirect: "manual",
        signal: AbortSignal.timeout(60_000),
        ...(body.length && m.method !== "GET" && m.method !== "HEAD" ? { body: body as unknown as ArrayBuffer } : {}),
      });
      await this.reply(chan, { k: "res", id: m.id, status: res.status, headers: pick(res.headers, RESPONSE_HEADERS) });
      let total = 0;
      let pending: Uint8Array = new Uint8Array(0);
      const flush = async (all: boolean) => {
        while (pending.length >= CHUNK_BYTES || (all && pending.length)) {
          const piece = pending.subarray(0, CHUNK_BYTES);
          pending = pending.subarray(piece.length);
          await this.reply(chan, { k: "chunk", id: m.id, d: toB64u(piece) });
        }
      };
      if (res.body) {
        for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
          total += part.length;
          if (total > MAX_RESPONSE_BODY) throw new Error("response too large for the relay");
          pending = concat(pending, part);
          await flush(false);
        }
      }
      await flush(true);
      await this.reply(chan, { k: "done", id: m.id });
    } finally {
      chan.inflight--;
    }
  }

  private async subscribe(chan: Channel, m: Extract<Message, { k: "sub" }>): Promise<void> {
    if (m.path !== "/api/v1/stream" || chan.streams.size >= MAX_STREAMS) return void (await this.reply(chan, { k: "err", id: m.id, message: "subscription refused" }));
    const auth = m.headers?.authorization ?? m.headers?.Authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) return void (await this.reply(chan, { k: "err", id: m.id, message: "a device token is needed" }));
    const ws = new WebSocket(`ws://127.0.0.1:${this.deps.port()}/api/v1/stream?token=${encodeURIComponent(token)}&relay=1`);
    chan.streams.set(m.id, ws);
    ws.addEventListener("open", () => void this.reply(chan, { k: "subok", id: m.id }));
    ws.addEventListener("message", (e) => void this.reply(chan, { k: "msg", id: m.id, d: String(e.data) }));
    ws.addEventListener("close", () => {
      chan.streams.delete(m.id);
      void this.reply(chan, { k: "end", id: m.id });
    });
    ws.addEventListener("error", () => {});
  }

  /** Encrypts a message to the phone; sends are in order, which the frame counter needs. */
  private reply(chan: Channel, m: Message): Promise<void> {
    const next = chan.outgoing.then(async () => {
      if (!chan.session || !this.channels.has(chan.id)) return;
      this.sendRelay({ t: "data", c: chan.id, d: toB64u(await chan.session.seal(encodeMessage(m))) });
    });
    chan.outgoing = next.catch(() => {});
    return next;
  }

  private drop(chan: Channel, tell: boolean): void {
    if (!this.channels.delete(chan.id)) return;
    for (const ws of chan.streams.values()) ws.close();
    chan.streams.clear();
    if (tell) this.sendRelay({ t: "close", c: chan.id });
  }

  private sendRelay(m: object): void {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(m));
  }
}

/** A path on the daemon's own API or files: absolute, no scheme, no `//`, no dot segments, no control characters. */
export function safePath(path: string): boolean {
  if (path.length > 2048 || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  return path.split("?")[0]!.split("/").every((segment) => {
    try {
      const decoded = decodeURIComponent(segment);
      return decoded !== ".." && decoded !== "." && !decoded.includes("\\");
    } catch {
      return false;
    }
  });
}

function forwarded(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (typeof v === "string" && REQUEST_HEADERS.includes(k.toLowerCase()) && v.length <= 4096 && !/[\r\n]/.test(v)) out[k.toLowerCase()] = v;
  }
  out[RELAY_MARKER] = "1";
  return out;
}

function pick(headers: Headers, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = headers.get(n);
    if (v) out[n] = v;
  }
  return out;
}
