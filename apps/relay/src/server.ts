import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";

/**
 * The Navarch relay (spec §6.12.2 option B, ADR 0066). A phone cannot reach a PC behind a home router, so the
 * PC keeps one outgoing WebSocket here and phones connect here; the relay copies frames between them.
 *
 * It holds **no key** and understands nothing it forwards: phone and daemon encrypt end to end with a secret
 * that never reaches this server (the pairing code travels in the QR code's `#fragment`). What the relay
 * does see is metadata: which relay id is online, when, how many bytes, and from which address.
 *
 * Trust on first use: the first daemon to present a relay id and a token owns that id; only the same token
 * may take it over later. Only a hash of the token is kept.
 */

export type RelayOptions = {
  port?: number;
  host?: string;
  /** Where relay ids and token hashes are kept; without it they live in memory. */
  statePath?: string;
  /** How many relay ids this server will register. */
  maxRelays?: number;
  /** Phones connected to one relay id at once. */
  maxChannels?: number;
  /** New phone connections per address per minute. */
  phonePerMinute?: number;
  /** Static files for the phone's loader (a later slice); `/` answers 404 without it. */
  log?: (line: string) => void;
};

export type RelayServer = { url: string; port: number; online(): number; stop(): Promise<void> };

/** The part of a `ws` socket the relay uses (the package is a dependency of @fastify/websocket, not ours). */
interface WebSocket {
  readyState: number;
  bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  on(event: "message", listener: (raw: Buffer) => void): void;
  on(event: "close" | "pong", listener: () => void): void;
}

const ID = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_PAYLOAD = 2 * 1024 * 1024;
const MAX_BUFFERED = 8 * 1024 * 1024;
const AUTH_MS = 5_000;
const PING_MS = 30_000;

type Online = { socket: WebSocket; channels: Map<string, WebSocket> };

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

export async function startRelay(opts: RelayOptions = {}): Promise<RelayServer> {
  const log = opts.log ?? (() => {});
  const maxRelays = opts.maxRelays ?? 100;
  const maxChannels = opts.maxChannels ?? 32;
  const phonePerMinute = opts.phonePerMinute ?? 60;
  const known = loadState(opts.statePath);
  const online = new Map<string, Online>();
  const recent = new Map<string, number[]>();
  let nextChannel = 1;

  const app: FastifyInstance = Fastify({ logger: false });
  await app.register(websocket, { options: { maxPayload: MAX_PAYLOAD } });

  const allowed = (ip: string): boolean => {
    const now = Date.now();
    const times = (recent.get(ip) ?? []).filter((t) => now - t < 60_000);
    if (times.length >= phonePerMinute) {
      recent.set(ip, times);
      return false;
    }
    times.push(now);
    recent.set(ip, times);
    return true;
  };

  app.get("/healthz", async () => ({ ok: true, online: online.size }));

  // The daemon: authenticates in its first message, then carries frames for every phone.
  app.get("/d", { websocket: true }, (socket) => {
    let relay: string | undefined;
    const timer = setTimeout(() => socket.close(4401, "auth timeout"), AUTH_MS);
    keepAlive(socket);
    socket.on("message", (raw: Buffer) => {
      const m = parse(raw);
      if (!m) return socket.close(4400, "bad message");
      if (!relay) {
        clearTimeout(timer);
        const id = typeof m.relay === "string" ? m.relay : "";
        const token = typeof m.token === "string" ? m.token : "";
        if (m.t !== "auth" || !ID.test(id) || token.length < 16 || token.length > 256) return socket.close(4400, "bad auth");
        const stored = known.get(id);
        if (stored) {
          if (!sameHash(stored, hash(token))) return socket.close(4403, "wrong token");
        } else {
          if (known.size >= maxRelays) return socket.close(4403, "relay full");
          known.set(id, hash(token));
          saveState(opts.statePath, known);
          log(`registered ${id.slice(0, 6)}…`);
        }
        const previous = online.get(id);
        if (previous) previous.socket.close(4409, "replaced");
        relay = id;
        online.set(id, { socket, channels: new Map() });
        log(`daemon online ${id.slice(0, 6)}…`);
        return socket.send(JSON.stringify({ t: "ready" }));
      }
      const entry = online.get(relay);
      if (!entry || entry.socket !== socket) return;
      const phone = typeof m.c === "string" ? entry.channels.get(m.c) : undefined;
      if (!phone) return;
      if (m.t === "data" && typeof m.d === "string") {
        if (phone.bufferedAmount > MAX_BUFFERED) return phone.close(4429, "slow");
        phone.send(JSON.stringify({ t: "data", d: m.d }));
      } else if (m.t === "close") {
        phone.close(1000, "closed by the daemon");
      }
    });
    socket.on("close", () => {
      clearTimeout(timer);
      if (!relay) return;
      const entry = online.get(relay);
      if (entry?.socket !== socket) return;
      online.delete(relay);
      for (const phone of entry.channels.values()) phone.close(4404, "the daemon went offline");
      log(`daemon offline ${relay.slice(0, 6)}…`);
    });
  });

  // A phone: one socket is one channel to the daemon of the relay id in the path.
  app.get("/p/:id", { websocket: true }, (socket, req) => {
    const id = (req.params as { id: string }).id;
    const entry = ID.test(id) ? online.get(id) : undefined;
    if (!entry) return socket.close(4404, "offline");
    if (!allowed(req.ip)) return socket.close(4429, "too many connections");
    if (entry.channels.size >= maxChannels) return socket.close(4429, "busy");
    keepAlive(socket);
    const c = String(nextChannel++);
    entry.channels.set(c, socket);
    entry.socket.send(JSON.stringify({ t: "open", c }));
    socket.on("message", (raw: Buffer) => {
      const m = parse(raw);
      if (!m || m.t !== "data" || typeof m.d !== "string") return socket.close(4400, "bad message");
      if (entry.socket.bufferedAmount > MAX_BUFFERED) return socket.close(4429, "slow");
      entry.socket.send(JSON.stringify({ t: "data", c, d: m.d }));
    });
    socket.on("close", () => {
      if (entry.channels.get(c) !== socket) return;
      entry.channels.delete(c);
      if (entry.socket.readyState === 1) entry.socket.send(JSON.stringify({ t: "close", c }));
    });
  });

  await app.listen({ port: opts.port ?? 8787, host: opts.host ?? "127.0.0.1" });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 8787);
  return {
    url: `http://${opts.host ?? "127.0.0.1"}:${port}`,
    port,
    online: () => online.size,
    stop: async () => {
      for (const entry of online.values()) {
        for (const phone of entry.channels.values()) phone.close(1001, "relay stopping");
        entry.socket.close(1001, "relay stopping");
      }
      await app.close();
    },
  };
}

function parse(raw: Buffer): Record<string, unknown> | undefined {
  try {
    const m = JSON.parse(raw.toString("utf8")) as unknown;
    return typeof m === "object" && m !== null && !Array.isArray(m) ? (m as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function keepAlive(socket: WebSocket): void {
  let alive = true;
  socket.on("pong", () => (alive = true));
  const timer = setInterval(() => {
    if (!alive) return socket.terminate();
    alive = false;
    socket.ping();
  }, PING_MS);
  timer.unref();
  socket.on("close", () => clearInterval(timer));
}

const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function loadState(path: string | undefined): Map<string, string> {
  if (!path || !existsSync(path)) return new Map();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { relays?: Record<string, string> };
    return new Map(Object.entries(raw.relays ?? {}));
  } catch {
    return new Map();
  }
}

function saveState(path: string | undefined, known: Map<string, string>): void {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify({ relays: Object.fromEntries(known) }), { mode: 0o600 });
  renameSync(tmp, path);
}
