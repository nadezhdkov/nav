/** Small byte helpers that work the same in Node and in a browser (no `Buffer`). */

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const utf8 = (text: string): Uint8Array => encoder.encode(text);
export const text = (bytes: Uint8Array): string => decoder.decode(bytes);

export function toB64u(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromB64u(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  const bin = atob(s.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Each part prefixed by its 4-byte length, so two different lists never give the same bytes. */
export function framed(...parts: (string | Uint8Array)[]): Uint8Array {
  return concat(
    ...parts.map((p) => {
      const b = typeof p === "string" ? utf8(p) : p;
      const len = new Uint8Array(4);
      new DataView(len.buffer).setUint32(0, b.length);
      return concat(len, b);
    }),
  );
}
