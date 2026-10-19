/**
 * The part of CBOR (RFC 8949) WebAuthn needs: it reads an attestation object and a COSE key. Maps
 * come back as `Map`, byte strings as `Buffer`; indefinite lengths, tags and floats are refused.
 */
export function decodeCbor(input: Uint8Array): { value: unknown; end: number } {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  let pos = 0;
  const MAX_DEPTH = 8;

  const need = (n: number): void => {
    if (pos + n > buf.length) throw new Error("CBOR: unexpected end");
  };
  const length = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) {
      need(1);
      return buf[pos++]!;
    }
    if (info === 25) {
      need(2);
      const v = buf.readUInt16BE(pos);
      pos += 2;
      return v;
    }
    if (info === 26) {
      need(4);
      const v = buf.readUInt32BE(pos);
      pos += 4;
      return v;
    }
    throw new Error("CBOR: unsupported length");
  };
  const item = (depth: number): unknown => {
    if (depth > MAX_DEPTH) throw new Error("CBOR: nested too deep");
    need(1);
    const head = buf[pos++]!;
    const major = head >> 5;
    const info = head & 31;
    switch (major) {
      case 0:
        return length(info);
      case 1:
        return -1 - length(info);
      case 2: {
        const n = length(info);
        need(n);
        const out = Buffer.from(buf.subarray(pos, pos + n));
        pos += n;
        return out;
      }
      case 3: {
        const n = length(info);
        need(n);
        const out = buf.toString("utf8", pos, pos + n);
        pos += n;
        return out;
      }
      case 4: {
        const n = length(info);
        if (n > 1024) throw new Error("CBOR: array too long");
        const out: unknown[] = [];
        for (let i = 0; i < n; i++) out.push(item(depth + 1));
        return out;
      }
      case 5: {
        const n = length(info);
        if (n > 1024) throw new Error("CBOR: map too long");
        const out = new Map<unknown, unknown>();
        for (let i = 0; i < n; i++) out.set(item(depth + 1), item(depth + 1));
        return out;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        throw new Error("CBOR: unsupported simple value");
      default:
        throw new Error("CBOR: unsupported type");
    }
  };
  const value = item(0);
  return { value, end: pos };
}
