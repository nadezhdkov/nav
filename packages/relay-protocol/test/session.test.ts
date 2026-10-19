import { describe, expect, it } from "vitest";
import { accept, decodeMessage, encodeMessage, fromB64u, initiate, random, text, toB64u, utf8, type Session } from "../src/index.ts";

const secret = random(32);

async function pair(): Promise<{ phone: Session; daemon: Session }> {
  const p = await initiate(secret, "dev_1");
  const a = await accept(p.hello, (id) => (id === "dev_1" ? [secret] : []));
  if (!a) throw new Error("not accepted");
  return { phone: await p.finish(a.welcome), daemon: a.session };
}

describe("the handshake", () => {
  it("gives both sides a working session, with the device the phone named", async () => {
    const p = await initiate(secret, "dev_1");
    const a = await accept(p.hello, () => [secret]);
    expect(a?.deviceId).toBe("dev_1");
    const phone = await p.finish(a!.welcome);
    expect(text(await a!.session.open(await phone.seal(utf8("hello daemon"))))).toBe("hello daemon");
    expect(text(await phone.open(await a!.session.seal(utf8("hello phone"))))).toBe("hello phone");
  });

  it("refuses a phone that does not know the secret, without computing anything from its key", async () => {
    const p = await initiate(random(32), "dev_1");
    expect(await accept(p.hello, () => [secret])).toBeUndefined();
    expect(await accept(p.hello, () => [])).toBeUndefined();
  });

  it("tries each candidate secret and says which one matched", async () => {
    const p = await initiate(secret, "pairing");
    const a = await accept(p.hello, () => [random(32), secret, random(32)]);
    expect(a?.secret).toEqual(secret);
  });

  it("makes the phone refuse a daemon that does not know the secret", async () => {
    const p = await initiate(secret, "dev_1");
    const impostor = await accept((await initiate(secret, "dev_1")).hello, () => [secret]);
    // A WELCOME made for another handshake does not match this phone's nonce and key.
    await expect(p.finish(impostor!.welcome)).rejects.toThrow(/did not prove/);
  });

  it("refuses garbage and oversized hellos", async () => {
    expect(await accept(utf8("nope"), () => [secret])).toBeUndefined();
    expect(await accept(new Uint8Array([1, ...utf8("{".repeat(9000))]), () => [secret])).toBeUndefined();
    expect(await accept(new Uint8Array([1, ...utf8(JSON.stringify({ v: 2, device: "d", ep: "", np: "", mac: "" }))]), () => [secret])).toBeUndefined();
  });
});

describe("the session", () => {
  it("does not let a frame be replayed, reordered or reflected back", async () => {
    const { phone, daemon } = await pair();
    const first = await phone.seal(utf8("one"));
    const second = await phone.seal(utf8("two"));
    expect(text(await daemon.open(second))).toBe("two");
    await expect(daemon.open(first)).rejects.toThrow(/replayed|out-of-order/);
    await expect(daemon.open(second)).rejects.toThrow(/replayed|out-of-order/);
    // A frame the phone sent, shown to the phone as if from the daemon, does not authenticate.
    await expect(phone.open(await phone.seal(utf8("echo")))).rejects.toThrow(/authenticate/);
  });

  it("detects a changed byte, and a frame from another session", async () => {
    const { phone, daemon } = await pair();
    const frame = await phone.seal(utf8("secret words"));
    const bad = frame.slice();
    bad[bad.length - 1]! ^= 1;
    await expect(daemon.open(bad)).rejects.toThrow(/authenticate/);
    const other = await pair();
    await expect(other.daemon.open(frame)).rejects.toThrow(/authenticate/);
    // The failed attempts did not use up the counter: the real frame still opens.
    expect(text(await daemon.open(frame))).toBe("secret words");
  });

  it("does not show its plaintext in what it sends", async () => {
    const { phone } = await pair();
    const frame = await phone.seal(utf8("GET /api/v1/runs Bearer nvd_token"));
    expect(toB64u(frame)).not.toContain("api");
    expect(text(frame.subarray(9).slice(0, 4).map((b) => b & 0x7f))).not.toContain("GET");
  });
});

describe("messages", () => {
  it("round-trip and refuse what is not a message", () => {
    const m = { k: "req", id: 3, method: "GET", path: "/api/v1/runs", headers: { authorization: "Bearer x" } } as const;
    expect(decodeMessage(encodeMessage(m))).toEqual(m);
    expect(() => decodeMessage(utf8("{}"))).toThrow();
    expect(() => decodeMessage(utf8(JSON.stringify({ k: "req", id: 1, method: 5, path: "/" })))).toThrow();
    expect(() => decodeMessage(utf8(JSON.stringify({ k: "wat", id: 1 })))).toThrow();
    expect(() => decodeMessage(utf8(JSON.stringify({ k: "done", id: "1" })))).toThrow();
  });

  it("base64url is strict", () => {
    expect(fromB64u(toB64u(random(100)))).toHaveLength(100);
    expect(() => fromB64u("a+b/")).toThrow();
  });
});
