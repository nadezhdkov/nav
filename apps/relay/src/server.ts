import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import rateLimit from "@fastify/rate-limit";
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
  /** Requests per address per minute for the loader's files (a phone loads four per visit). */
  fileRequestsPerMinute?: number;
  /** Webhook requests per address per minute. */
  hookRequestsPerMinute?: number;
  /** Largest webhook body forwarded, in bytes. */
  maxHookBytes?: number;
  /** How long a webhook waits for the daemon's answer, in ms. */
  hookTimeoutMs?: number;
  /** Where the built loader page and service worker are (`make relay-build`); defaults to `apps/relay/dist`. */
  phoneDir?: string;
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

/** The loader page may run its own script and talk to this relay, nothing else. */
const PHONE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** The headers of a GitHub delivery the daemon needs; the rest is dropped. */
const HOOK_HEADERS = ["x-github-event", "x-github-delivery", "x-hub-signature-256", "content-type"];
const ID = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_PAYLOAD = 2 * 1024 * 1024;
const MAX_BUFFERED = 8 * 1024 * 1024;
const AUTH_MS = 5_000;
const PING_MS = 30_000;

type Online = { socket: WebSocket; channels: Map<string, WebSocket>; hooks: Map<string, (status: number, message: string) => void> };

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
  let nextHook = 1;

  const app: FastifyInstance = Fastify({ logger: false });
  await app.register(websocket, { options: { maxPayload: MAX_PAYLOAD } });
  // Off everywhere but the routes that read files: they opt in with `config.rateLimit`.
  await app.register(rateLimit, { global: false });
  const files = { config: { rateLimit: { max: opts.fileRequestsPerMinute ?? 120, timeWindow: "1 minute" } } };

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

  // The phone's loader (ADR 0067): a page that pairs and registers a service worker. These files are the
  // only code the relay supplies; the app itself comes from the daemon through the encrypted tunnel.
  const phoneDir = opts.phoneDir ?? resolve(import.meta.dirname, "../dist");
  const serve = (file: string, type: string, extra: Record<string, string> = {}) => async (_req: unknown, reply: import("fastify").FastifyReply) => {
    const path = resolve(phoneDir, file);
    if (!existsSync(path)) return reply.code(503).type("text/plain").send("The phone loader is not built on this relay: run `make relay-build`.");
    return reply
      .header("cache-control", "no-cache")
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "no-referrer")
      .header("content-security-policy", PHONE_CSP)
      .headers(extra)
      .type(type)
      .send(readFileSync(path));
  };
  app.get("/favicon.ico", async (_req, reply) => reply.code(204).send());
  app.get("/r/:id", async (req, reply) => reply.redirect(`/r/${(req.params as { id: string }).id}/`));
  app.get("/r/:id/", files, serve("index.html", "text/html; charset=utf-8"));
  app.get("/r/:id/loader.js", files, serve("loader.js", "text/javascript; charset=utf-8"));
  app.get("/r/:id/loader.css", files, serve("loader.css", "text/css; charset=utf-8"));
  app.get("/r/:id/sw.js", files, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    return serve("sw.js", "text/javascript; charset=utf-8", { "service-worker-allowed": `/r/${id}/` })(req, reply);
  });
  // Any other address under the relay id, before the service worker is there to answer it: the loader page.
  app.get("/r/:id/*", files, serve("index.html", "text/html; charset=utf-8"));

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
        online.set(id, { socket, channels: new Map(), hooks: new Map() });
        log(`daemon online ${id.slice(0, 6)}…`);
        return socket.send(JSON.stringify({ t: "ready" }));
      }
      const entry = online.get(relay);
      if (!entry || entry.socket !== socket) return;
      if (m.t === "hookres") {
        const done = typeof m.h === "string" ? entry.hooks.get(m.h) : undefined;
        if (done) done(Number.isInteger(m.status) ? Number(m.status) : 502, typeof m.message === "string" ? m.message.slice(0, 200) : "");
        return;
      }
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
      for (const done of [...entry.hooks.values()]) done(503, "the daemon went offline");
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

  // GitHub webhooks (ADR 0068): the body is passed to the daemon untouched, because only the daemon holds the
  // secret that signs it. The relay stores nothing; an offline daemon answers 503 and GitHub can redeliver.
  const maxHook = opts.maxHookBytes ?? 1024 * 1024;
  const hookTimeout = opts.hookTimeoutMs ?? 8_000;
  const hookLimit = { config: { rateLimit: { max: opts.hookRequestsPerMinute ?? 120, timeWindow: "1 minute" } } };
  app.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: maxHook }, (_req, body, done) => done(null, body));
  app.post("/w/:id", { ...hookLimit, bodyLimit: maxHook }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const entry = ID.test(id) ? online.get(id) : undefined;
    if (!entry || entry.socket.readyState !== 1) return reply.code(503).send({ message: "the daemon is offline" });
    if (entry.hooks.size >= 16) return reply.code(429).send({ message: "busy" });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (entry.socket.bufferedAmount > MAX_BUFFERED) return reply.code(503).send({ message: "the daemon is slow" });
    const h = String(nextHook++);
    const headers: Record<string, string> = {};
    for (const name of HOOK_HEADERS) {
      const v = req.headers[name];
      if (typeof v === "string") headers[name] = v.slice(0, 200);
    }
    const answer = await new Promise<{ status: number; message: string }>((resolve) => {
      const timer = setTimeout(() => finish(504, "the daemon did not answer"), hookTimeout);
      const finish = (status: number, message: string) => {
        clearTimeout(timer);
        entry.hooks.delete(h);
        resolve({ status, message });
      };
      entry.hooks.set(h, finish);
      entry.socket.send(JSON.stringify({ t: "hook", h, headers, body: body.toString("base64url") }));
    });
    const status = answer.status >= 200 && answer.status < 600 ? answer.status : 502;
    return reply.code(status).send({ message: answer.message });
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
