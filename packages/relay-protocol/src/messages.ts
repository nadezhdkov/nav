import { fromB64u, text, utf8 } from "./bytes.ts";

/**
 * What phone and daemon say to each other inside the encrypted session. A request is answered by a
 * header message, any number of body chunks and a closing message, so a large file never needs one huge
 * frame. `sub` opens a live stream (the event stream) and `msg` carries what it sends.
 */

export type Headers = Record<string, string>;

export type Message =
  | { k: "req"; id: number; method: string; path: string; headers?: Headers; body?: string }
  | { k: "res"; id: number; status: number; headers: Headers }
  | { k: "chunk"; id: number; d: string }
  | { k: "done"; id: number }
  | { k: "err"; id: number; message: string }
  | { k: "sub"; id: number; path: string; headers?: Headers }
  | { k: "subok"; id: number }
  | { k: "msg"; id: number; d: string }
  | { k: "send"; id: number; d: string }
  | { k: "end"; id: number }
  | { k: "enroll"; id: number; code: string; name: string }
  | { k: "enrolled"; id: number; session: unknown; secret: string };

/** Largest piece of a body in one message, before base64. */
export const CHUNK_BYTES = 192 * 1024;
/** Largest request body a phone may send. */
export const MAX_REQUEST_BODY = 256 * 1024;
/** Largest response the daemon sends back over the relay. */
export const MAX_RESPONSE_BODY = 8 * 1024 * 1024;
export const MAX_IN_FLIGHT = 16;
export const MAX_STREAMS = 2;

const KINDS = new Set(["req", "res", "chunk", "done", "err", "sub", "subok", "msg", "send", "end", "enroll", "enrolled"]);

export const encodeMessage = (m: Message): Uint8Array => utf8(JSON.stringify(m));

/** Parses and shape-checks a message; throws on anything else. */
export function decodeMessage(bytes: Uint8Array): Message {
  const m = JSON.parse(text(bytes)) as Record<string, unknown>;
  if (typeof m !== "object" || m === null || typeof m.k !== "string" || !KINDS.has(m.k) || !Number.isSafeInteger(m.id)) throw new Error("bad message");
  const str = (v: unknown) => typeof v === "string";
  switch (m.k) {
    case "req":
      if (!str(m.method) || !str(m.path) || (m.body !== undefined && !str(m.body))) throw new Error("bad request");
      break;
    case "sub":
      if (!str(m.path)) throw new Error("bad subscription");
      break;
    case "chunk":
    case "msg":
    case "send":
      if (!str(m.d)) throw new Error("bad data");
      break;
    case "res":
      if (!Number.isInteger(m.status) || typeof m.headers !== "object") throw new Error("bad response");
      break;
    case "enroll":
      if (!str(m.code) || !str(m.name)) throw new Error("bad enrollment");
      break;
    case "enrolled":
      if (!str(m.secret)) throw new Error("bad enrollment answer");
      break;
  }
  return m as unknown as Message;
}

export const bodyBytes = (b64: string | undefined): Uint8Array => (b64 ? fromB64u(b64) : new Uint8Array(0));
