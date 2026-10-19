import { concat, fromB64u, text, toB64u, utf8 } from "./bytes.ts";
import { bodyBytes, decodeMessage, encodeMessage, MAX_IN_FLIGHT, type Headers, type Message } from "./messages.ts";
import { initiate, type Session } from "./session.ts";

/** The part of a WebSocket the client needs, which both the browser's and Node's have. */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code?: number }) => void): void;
  addEventListener(type: "open" | "error", listener: () => void): void;
}

/** The relay (or the daemon, through it) ended the connection; `code` is the WebSocket close code (4404: the daemon is offline). */
export class RelayClosed extends Error {
  readonly code: number | undefined;

  constructor(code: number | undefined) {
    super(code === 4404 ? "the daemon is offline" : "the relay closed the connection");
    this.code = code;
  }
}

export type Response = { status: number; headers: Headers; body: Uint8Array };
export type Stream = { send(data: string): void; close(): void };

type Waiting = { status?: number; headers?: Headers; chunks: Uint8Array[]; resolve: (r: Response) => void; reject: (e: Error) => void } | { enrolled: (v: { session: unknown; secret: Uint8Array }) => void; reject: (e: Error) => void };
type Subscription = { onMessage: (data: string) => void; onEnd: () => void; opened?: (s: Stream) => void; reject?: (e: Error) => void };

const OPEN = 1;

/**
 * The phone's side of the relay (ADR 0066): connects to a relay socket, runs the handshake, and then offers
 * `fetch` and `subscribe` against the daemon. Used by the tests and by the phone's loader.
 */
export class RelayClient {
  private readonly socket: SocketLike;
  private readonly session: Session;
  private nextId = 1;
  private readonly waiting = new Map<number, Waiting>();
  private readonly streams = new Map<number, Subscription>();
  private incoming: Promise<void> = Promise.resolve();
  private outgoing: Promise<void> = Promise.resolve();
  private closed = false;
  /** A page asks for dozens of files at once; the daemon takes a few at a time, so the rest wait their turn here. */
  private slots = MAX_IN_FLIGHT - 2;
  private readonly queue: (() => void)[] = [];
  onclose: (() => void) | undefined;

  private constructor(socket: SocketLike, session: Session) {
    this.socket = socket;
    this.session = session;
    socket.addEventListener("message", (e) => this.receive(e.data));
    // Frames already received are decrypted one at a time; a close that follows the last answer must not
    // fail the request that answer completes, so the queue drains first.
    socket.addEventListener("close", () => void this.incoming.then(() => this.shutdown()));
    socket.addEventListener("error", () => void this.incoming.then(() => this.shutdown()));
  }

  /** Connects over `socket` and authenticates with `secret` as `deviceId`; rejects if the daemon does not answer. */
  static async connect(socket: SocketLike, deviceId: string, secret: Uint8Array, timeoutMs = 10_000): Promise<RelayClient> {
    // Everything that can happen to the socket is listened for before the first await, so a relay that
    // answers "offline" while the handshake keys are still being made is not missed, close code included.
    const opening = new Promise<void>((resolve, reject) => {
      if (socket.readyState === OPEN) resolve();
      // 2 and 3: closing or already closed, so no `open` is coming.
      else if (socket.readyState === 2 || socket.readyState === 3) reject(new RelayClosed(undefined));
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error("could not reach the relay")));
      socket.addEventListener("close", (e) => reject(new RelayClosed(e.code)));
    });
    const welcome = new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the daemon did not answer")), timeoutMs);
      socket.addEventListener("message", (e) => {
        try {
          const m = JSON.parse(String(e.data)) as { t?: string; d?: string };
          if (m.t === "data" && typeof m.d === "string") {
            clearTimeout(timer);
            resolve(fromB64u(m.d));
          }
        } catch {
          /* not for us */
        }
      });
      socket.addEventListener("close", (e) => {
        clearTimeout(timer);
        reject(new RelayClosed(e.code));
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("could not reach the relay"));
      });
    });
    // Handled here too, so a failure before we get to wait for it is never reported as unhandled.
    opening.catch(() => {});
    welcome.catch(() => {});
    const pending = await initiate(secret, deviceId);
    await opening;
    socket.send(JSON.stringify({ t: "data", d: toB64u(pending.hello) }));
    // The first message was consumed above; later ones go to the session once it exists.
    const session = await pending.finish(await welcome);
    return new RelayClient(socket, session);
  }

  async fetch(method: string, path: string, init: { headers?: Headers; body?: Uint8Array } = {}): Promise<Response> {
    if (this.slots > 0) this.slots--;
    else await new Promise<void>((turn) => this.queue.push(turn));
    try {
      return await new Promise<Response>((resolve, reject) => {
        const id = this.nextId++;
        this.waiting.set(id, { chunks: [], resolve, reject });
        this.send({ k: "req", id, method, path, ...(init.headers ? { headers: init.headers } : {}), ...(init.body?.length ? { body: toB64u(init.body) } : {}) }).catch((e) => this.fail(id, e));
      });
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.slots++;
    }
  }

  /** Pairing: exchanges the pairing code for a device session and the device's relay secret. */
  enroll(code: string, name: string): Promise<{ session: unknown; secret: Uint8Array }> {
    return new Promise((enrolled, reject) => {
      const id = this.nextId++;
      this.waiting.set(id, { enrolled, reject });
      this.send({ k: "enroll", id, code, name }).catch((e) => this.fail(id, e));
    });
  }

  subscribe(path: string, headers: Headers, onMessage: (data: string) => void, onEnd: () => void): Promise<Stream> {
    return new Promise((opened, reject) => {
      const id = this.nextId++;
      this.streams.set(id, { onMessage, onEnd, opened: (s) => opened(s), reject });
      this.send({ k: "sub", id, path, headers }).catch((e) => this.fail(id, e));
    });
  }

  close(): void {
    this.socket.close(1000);
    this.shutdown();
  }

  private fail(id: number, e: Error): void {
    const w = this.waiting.get(id);
    this.waiting.delete(id);
    w?.reject(e);
    const s = this.streams.get(id);
    this.streams.delete(id);
    s?.reject?.(e);
  }

  private send(m: Message): Promise<void> {
    const next = this.outgoing.then(async () => {
      if (this.closed) throw new Error("the connection is closed");
      this.socket.send(JSON.stringify({ t: "data", d: toB64u(await this.session.seal(encodeMessage(m))) }));
    });
    this.outgoing = next.catch(() => {});
    return next;
  }

  private receive(raw: unknown): void {
    this.incoming = this.incoming.then(async () => {
      try {
        const m = JSON.parse(String(raw)) as { t?: string; d?: string };
        if (m.t !== "data" || typeof m.d !== "string") return;
        this.handle(decodeMessage(await this.session.open(fromB64u(m.d))));
      } catch {
        // A frame that does not authenticate or parse means the session cannot be trusted any more.
        this.close();
      }
    });
  }

  private handle(m: Message): void {
    const w = this.waiting.get(m.id);
    const s = this.streams.get(m.id);
    switch (m.k) {
      case "res":
        if (w && "chunks" in w) {
          w.status = m.status;
          w.headers = m.headers;
        }
        break;
      case "chunk":
        if (w && "chunks" in w) w.chunks.push(fromB64u(m.d));
        break;
      case "done":
        if (w && "chunks" in w) {
          this.waiting.delete(m.id);
          w.resolve({ status: w.status ?? 502, headers: w.headers ?? {}, body: concat(...w.chunks) });
        }
        break;
      case "err":
        this.fail(m.id, new Error(m.message));
        break;
      case "enrolled":
        if (w && "enrolled" in w) {
          this.waiting.delete(m.id);
          w.enrolled({ session: m.session, secret: fromB64u(m.secret) });
        }
        break;
      case "subok":
        if (s?.opened) {
          const id = m.id;
          s.opened({ send: (d) => void this.send({ k: "send", id, d }).catch(() => {}), close: () => void this.send({ k: "end", id }).catch(() => {}) });
          delete s.opened;
        }
        break;
      case "msg":
        s?.onMessage(m.d);
        break;
      case "end":
        if (s) {
          this.streams.delete(m.id);
          s.onEnd();
        }
        break;
    }
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    for (const id of [...this.waiting.keys()]) this.fail(id, new Error("the connection closed"));
    // Requests still waiting for a turn go on, and fail at once because the connection is closed.
    for (const turn of this.queue.splice(0)) turn();
    for (const [id, s] of [...this.streams]) {
      this.streams.delete(id);
      s.reject?.(new Error("the connection closed"));
      s.onEnd();
    }
    this.onclose?.();
  }
}

/** Convenience for tests and callers that want text. */
export const bodyText = (r: Response): string => text(r.body);
export { bodyBytes, utf8 };
