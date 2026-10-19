import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DevicePairing, DeviceSession, RunView } from "@navarch/contracts";
import { RelayClient, utf8, random } from "@navarch/relay-protocol";
import { startRelay, type RelayServer } from "../../relay/src/index.ts";
import { afterEach, describe, expect, it } from "vitest";
import { fakeClaude } from "../../../packages/adapters/claude-code/test/fake.ts";
import { tempHome } from "../../../packages/runner/test/helpers.ts";
import { Config } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";
import { safePath } from "../src/relay/connector.ts";

const daemons: Daemon[] = [];
const relays: RelayServer[] = [];
const clients: RelayClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const d of daemons.splice(0)) await d.stop().catch(() => {});
  for (const r of relays.splice(0)) await r.stop().catch(() => {});
});

async function setup(relayPort = 0) {
  const relay = await startRelay({ port: relayPort });
  relays.push(relay);
  const home = tempHome();
  const daemon = new Daemon({
    home,
    config: Config.parse({ daemon: { port: 0, remote: { mode: "relay", relay_url: relay.url } }, routing: { enabled: false }, inbox: { poll_minutes: 0 } }),
    adapters: { "claude-code": fakeClaude("edit").options },
  });
  await daemon.start();
  daemons.push(daemon);
  const token = readFileSync(join(home, "token"), "utf8").trim();
  await waitFor(() => daemon.relay?.connected === true);
  const local = async <T>(method: string, path: string, body?: unknown) => {
    const res = await fetch(daemon.url + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
  };
  const relayId = new URL(daemon.relay!.phoneUrl).pathname.split("/")[2]!;
  const phone = async (deviceId: string, secret: Uint8Array, ms = 5_000) => {
    const client = await RelayClient.connect(new WebSocket(`${relay.url.replace("http", "ws")}/p/${relayId}`), deviceId, secret, ms);
    clients.push(client);
    return client;
  };
  /** Pairs a phone the way the loader will: the code from the QR code is the secret of a pairing channel. */
  const enroll = async (name = "Pixel 9") => {
    const pairing = (await local<DevicePairing>("POST", "/api/v1/devices/pairings")).body;
    const client = await phone("pairing", utf8(pairing.code));
    const done = await client.enroll(pairing.code, name);
    return { pairing, session: done.session as DeviceSession, secret: done.secret };
  };
  return { relay, daemon, local, token, phone, enroll, relayId };
}

async function waitFor(check: () => boolean, ms = 8_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const json = (r: { body: Uint8Array }) => JSON.parse(new TextDecoder().decode(r.body));

describe("the relay connector (ADR 0066)", () => {
  it("shows the relay's address as the pairing URL, and the status in relay mode", async () => {
    const { daemon, local, relay, relayId } = await setup();
    const pairing = await local<DevicePairing>("POST", "/api/v1/devices/pairings");
    expect(pairing.body.url).toBe(`${relay.url}/r/${relayId}/#pair=${pairing.body.code}`);
    expect((await local<{ mode: string; running: boolean; url: string }>("GET", "/api/v1/remote")).body).toMatchObject({ mode: "relay", running: true, url: `${relay.url}/r/${relayId}` });
    expect(relay.online()).toBe(1);
    expect(daemon.relay?.connected).toBe(true);
  });

  it("pairs a phone through the relay and then serves it the API, with the rules of a paired device", async () => {
    const { phone, enroll } = await setup();
    const { session, secret } = await enroll();
    expect(session.device.name).toBe("Pixel 9");

    const device = await phone(session.device.id, secret);
    const auth = { authorization: `Bearer ${session.access_token}` };
    const runs = await device.fetch("GET", "/api/v1/runs", { headers: auth });
    expect(runs.status).toBe(200);
    expect(json(runs)).toEqual([]);
    // The daemon's own rules for a device still apply.
    expect((await device.fetch("GET", "/api/v1/secrets/openrouter%2Fapi_key", { headers: auth })).status).toBe(403);
    expect((await device.fetch("GET", "/api/v1/runs")).status).toBe(401);
    const me = await device.fetch("GET", "/api/v1/devices/me", { headers: auth });
    expect(json(me)).toMatchObject({ id: session.device.id });
  });

  it("never gives the local token's powers to a request that came through the relay", async () => {
    const { phone, enroll, token } = await setup();
    const { session, secret } = await enroll();
    const device = await phone(session.device.id, secret);
    const res = await device.fetch("GET", "/api/v1/runs", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
  });

  it("starts a run from a prompt, as the phone, and carries a POST body", async () => {
    const { phone, enroll, local, daemon } = await setup();
    const { session, secret } = await enroll();
    const repo = (await import("../../../packages/runner/test/helpers.ts")).makeRepo();
    const device = await phone(session.device.id, secret);
    // The phone may only use a repository that earlier runs used.
    await local("POST", "/api/v1/runs", { repo_path: repo, prompt: "earlier" });
    const made = await device.fetch("POST", "/api/v1/runs", {
      headers: { authorization: `Bearer ${session.access_token}`, "content-type": "application/json" },
      body: utf8(JSON.stringify({ repo_path: repo, prompt: "from the phone" })),
    });
    expect(made.status).toBe(201);
    const run = json(made) as RunView;
    expect(daemon.store.events().find((e) => e.type === "run.created" && e.run_id === run.id)?.actor).toEqual({ kind: "user", via: "mobile", device_id: session.device.id });
  });

  it("streams events to the phone", async () => {
    const { phone, enroll } = await setup();
    const { session, secret } = await enroll();
    const device = await phone(session.device.id, secret);
    const got: string[] = [];
    const stream = await device.subscribe("/api/v1/stream", { authorization: `Bearer ${session.access_token}` }, (d) => got.push(d), () => {});
    stream.send(JSON.stringify({ subscribe: ["runs"] }));
    await waitFor(() => got.some((d) => d.includes("subscribed")));
    stream.close();
  });

  it("spends a pairing code once, and refuses a phone that does not know a secret", async () => {
    const { phone, enroll } = await setup();
    const { pairing } = await enroll();
    await expect(phone("pairing", utf8(pairing.code), 800)).rejects.toThrow();
    await expect(phone("dev_unknown", random(32), 800)).rejects.toThrow();
    await expect(phone("pairing", random(32), 800)).rejects.toThrow();
  });

  it("cuts off a revoked device: its open channel closes and it cannot connect again", async () => {
    const { phone, enroll, local } = await setup();
    const { session, secret } = await enroll();
    const device = await phone(session.device.id, secret);
    expect((await device.fetch("GET", "/api/v1/runs", { headers: { authorization: `Bearer ${session.access_token}` } })).status).toBe(200);
    await local("DELETE", `/api/v1/devices/${session.device.id}`);
    await expect(device.fetch("GET", "/api/v1/runs", { headers: { authorization: `Bearer ${session.access_token}` } })).rejects.toThrow();
    await expect(phone(session.device.id, secret, 800)).rejects.toThrow();
  });

  it("refuses paths that are not the daemon's own, and headers a phone may not set", async () => {
    const { phone, enroll } = await setup();
    const { session, secret } = await enroll();
    const device = await phone(session.device.id, secret);
    const auth = { authorization: `Bearer ${session.access_token}` };
    for (const path of ["//evil.example/x", "http://evil.example/", "/api/../etc/passwd", "/api/v1/%2e%2e/x", "relative", "/a\nb"]) {
      await expect(device.fetch("GET", path, { headers: auth }), path).rejects.toThrow(/refused/);
    }
    await expect(device.fetch("TRACE", "/api/v1/runs", { headers: auth })).rejects.toThrow(/refused/);
    // The marker header is the connector's own: a phone's attempt to set or drop it changes nothing.
    const res = await device.fetch("GET", "/api/v1/runs", { headers: { ...auth, "x-navarch-relay": "0", cookie: "a=b" } });
    expect(res.status).toBe(200);
  });

  it("reconnects when the relay comes back", async () => {
    const { relay, daemon, enroll } = await setup();
    const port = relay.port;
    await relay.stop();
    await waitFor(() => daemon.relay?.connected === false);
    const again = await startRelay({ port });
    relays.push(again);
    await waitFor(() => daemon.relay?.connected === true, 10_000);
    const { session } = await enroll();
    expect(session.device.name).toBe("Pixel 9");
  });

  it("keeps the same identity across restarts", async () => {
    const { relayId, daemon } = await setup();
    const { loadRelayIdentity } = await import("../src/relay/identity.ts");
    expect(loadRelayIdentity(daemon.home).relayId).toBe(relayId);
    expect(loadRelayIdentity(daemon.home).deviceSecret("dev_1")).toEqual(loadRelayIdentity(daemon.home).deviceSecret("dev_1"));
    expect(loadRelayIdentity(daemon.home).deviceSecret("dev_1")).not.toEqual(loadRelayIdentity(daemon.home).deviceSecret("dev_2"));
  });
});

describe("paths", () => {
  it("accepts the daemon's routes and refuses anything that could leave them", () => {
    for (const ok of ["/", "/api/v1/runs?limit=5", "/assets/index-abc.js", "/sw.js"]) expect(safePath(ok), ok).toBe(true);
    for (const bad of ["", "//x", "/..", "/a/../b", "/a/./b", "/%2E%2e/b", "/.%2e/b", "/a%zz", "/a\\b", "/a\u0000b", "/" + "a".repeat(3000), "http://x/"]) expect(safePath(bad), bad).toBe(false);
  });
});
