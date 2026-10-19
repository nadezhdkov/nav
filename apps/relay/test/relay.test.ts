import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startRelay, type RelayOptions, type RelayServer } from "../src/index.ts";

const relays: RelayServer[] = [];
afterEach(async () => {
  for (const r of relays.splice(0)) await r.stop().catch(() => {});
});

async function relay(opts: RelayOptions = {}): Promise<RelayServer> {
  const r = await startRelay({ port: 0, ...opts });
  relays.push(r);
  return r;
}

/** A WebSocket with the messages it gets queued, and the close code it ends with. */
type Probe = { ws: WebSocket; next(): Promise<Record<string, unknown>>; closed: Promise<number> };

function probe(url: string): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const queue: Record<string, unknown>[] = [];
    let wake: (() => void) | undefined;
    const closed = new Promise<number>((done) => ws.addEventListener("close", (e) => done(e.code)));
    ws.addEventListener("message", (e) => {
      queue.push(JSON.parse(String(e.data)));
      wake?.();
    });
    ws.addEventListener("error", () => reject(new Error("connection failed")));
    ws.addEventListener("open", () =>
      resolve({
        ws,
        closed,
        next: async () => {
          while (!queue.length) await new Promise<void>((r) => (wake = r));
          return queue.shift()!;
        },
      }),
    );
  });
}

const ws = (r: RelayServer) => r.url.replace("http", "ws");
const ID = "relay_id_0123456789abcdef";
const TOKEN = "token_0123456789abcdef0123";

async function daemon(r: RelayServer, id = ID, token = TOKEN): Promise<Probe> {
  const d = await probe(`${ws(r)}/d`);
  d.ws.send(JSON.stringify({ t: "auth", relay: id, token }));
  return d;
}

describe("the relay (ADR 0066)", () => {
  it("copies frames between a phone and the daemon, one channel per phone", async () => {
    const r = await relay();
    const d = await daemon(r);
    expect(await d.next()).toEqual({ t: "ready" });
    const phone = await probe(`${ws(r)}/p/${ID}`);
    const open = await d.next();
    expect(open.t).toBe("open");
    phone.ws.send(JSON.stringify({ t: "data", d: "aGVsbG8" }));
    expect(await d.next()).toEqual({ t: "data", c: open.c, d: "aGVsbG8" });
    d.ws.send(JSON.stringify({ t: "data", c: open.c, d: "d29ybGQ" }));
    expect(await phone.next()).toEqual({ t: "data", d: "d29ybGQ" });

    // A second phone is a second channel: it never sees the first one's frames.
    const other = await probe(`${ws(r)}/p/${ID}`);
    const open2 = await d.next();
    expect(open2.c).not.toBe(open.c);
    d.ws.send(JSON.stringify({ t: "data", c: open2.c, d: "b3RoZXI" }));
    expect(await other.next()).toEqual({ t: "data", d: "b3RoZXI" });

    phone.ws.close();
    expect(await d.next()).toEqual({ t: "close", c: open.c });
  });

  it("ends a phone's channel when the daemon says so, and all of them when the daemon goes away", async () => {
    const r = await relay();
    const d = await daemon(r);
    await d.next();
    const a = await probe(`${ws(r)}/p/${ID}`);
    const open = await d.next();
    d.ws.send(JSON.stringify({ t: "close", c: open.c }));
    expect(await a.closed).toBe(1000);
    const b = await probe(`${ws(r)}/p/${ID}`);
    await d.next();
    d.ws.close();
    expect(await b.closed).toBe(4404);
  });

  it("answers 'offline' to a phone when the daemon is not connected", async () => {
    const r = await relay();
    expect(await (await probe(`${ws(r)}/p/${ID}`)).closed).toBe(4404);
    expect(await (await probe(`${ws(r)}/p/short`)).closed).toBe(4404);
  });

  it("gives a relay id to the first daemon that asks and only to the same token afterwards, across restarts", async () => {
    const state = join(mkdtempSync(join(tmpdir(), "navarch-relay-test-")), "state.json");
    let r = await relay({ statePath: state });
    await (await daemon(r)).next();
    expect(readFileSync(state, "utf8")).not.toContain(TOKEN);
    await r.stop();

    r = await relay({ statePath: state });
    expect(await (await daemon(r, ID, "another_token_0123456789")).closed).toBe(4403);
    expect(await (await daemon(r)).next()).toEqual({ t: "ready" });
  });

  it("replaces a daemon that connects again with the right token", async () => {
    const r = await relay();
    const first = await daemon(r);
    await first.next();
    const second = await daemon(r);
    expect(await second.next()).toEqual({ t: "ready" });
    expect(await first.closed).toBe(4409);
  });

  it("refuses a malformed or missing authentication", async () => {
    const r = await relay();
    const bad = await probe(`${ws(r)}/d`);
    bad.ws.send(JSON.stringify({ t: "auth", relay: "x", token: "y" }));
    expect(await bad.closed).toBe(4400);
    const garbage = await probe(`${ws(r)}/d`);
    garbage.ws.send("not json");
    expect(await garbage.closed).toBe(4400);
  });

  it("stops registering relays at the limit, and limits phones per address", async () => {
    const r = await relay({ maxRelays: 1, phonePerMinute: 2 });
    await (await daemon(r)).next();
    expect(await (await daemon(r, "second_relay_id_0123456789", TOKEN)).closed).toBe(4403);
    await probe(`${ws(r)}/p/${ID}`);
    await probe(`${ws(r)}/p/${ID}`);
    expect(await (await probe(`${ws(r)}/p/${ID}`)).closed).toBe(4429);
  });

  it("limits the phones of one relay and refuses anything but data frames from them", async () => {
    const r = await relay({ maxChannels: 1 });
    await (await daemon(r)).next();
    const a = await probe(`${ws(r)}/p/${ID}`);
    expect(await (await probe(`${ws(r)}/p/${ID}`)).closed).toBe(4429);
    a.ws.send(JSON.stringify({ t: "open", c: "7" }));
    expect(await a.closed).toBe(4400);
  });

  it("answers the health check without naming who is online", async () => {
    const r = await relay();
    await (await daemon(r)).next();
    const res = await fetch(`${r.url}/healthz`);
    expect(await res.json()).toEqual({ ok: true, online: 1 });
  });
});
