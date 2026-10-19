import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DevicePairing } from "@navarch/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { fakeClaude } from "../../../packages/adapters/claude-code/test/fake.ts";
import { tempHome } from "../../../packages/runner/test/helpers.ts";
import { pairWithCode, respond, rewriteCss, rewriteHtml, rewriteManifest, Tunnel, TunnelError, type Creds } from "../../relay/phone/core.ts";
import { startRelay, type RelayServer } from "../../relay/src/index.ts";
import { Config } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";

const daemons: Daemon[] = [];
const relays: RelayServer[] = [];
const tunnels: Tunnel[] = [];
afterEach(async () => {
  for (const t of tunnels.splice(0)) t.close();
  for (const d of daemons.splice(0)) await d.stop().catch(() => {});
  for (const r of relays.splice(0)) await r.stop().catch(() => {});
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3, 255, 254]);

/** A built app the daemon can serve: a page with absolute links, a stylesheet, a manifest and a binary. */
function webDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "navarch-web-test-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="/favicon.svg"><link rel="manifest" href="/manifest.webmanifest"><script type="module" src="/assets/app.js"></script></head><body><a href="//other.example/x">x</a></body></html>`);
  writeFileSync(join(dir, "assets", "app.js"), "console.log('app')");
  writeFileSync(join(dir, "assets", "app.css"), "@font-face{src:url(/assets/font.woff2)}.a{background:url('/assets/pic.png')}.b{background:url(data:image/png;base64,AAAA)}");
  writeFileSync(join(dir, "assets", "pic.png"), PNG);
  writeFileSync(join(dir, "manifest.webmanifest"), JSON.stringify({ name: "Navarch", id: "/home", start_url: "/home", scope: "/", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] }));
  return dir;
}

function phoneDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "navarch-phone-test-"));
  for (const [name, text] of Object.entries({ "index.html": "<!doctype html><title>loader</title>", "loader.js": "// loader", "loader.css": "body{}", "sw.js": "// worker" })) writeFileSync(join(dir, name), text);
  return dir;
}

async function setup(opts: { withPhone?: boolean } = {}) {
  const relay = await startRelay({ port: 0, ...(opts.withPhone === false ? { phoneDir: join(tmpdir(), "navarch-no-such-dir") } : { phoneDir: phoneDir() }) });
  relays.push(relay);
  const home = tempHome();
  const daemon = new Daemon({
    home,
    config: Config.parse({ daemon: { port: 0, web_dir: webDir(), remote: { mode: "relay", relay_url: relay.url } }, routing: { enabled: false }, inbox: { poll_minutes: 0 } }),
    adapters: { "claude-code": fakeClaude("edit").options },
  });
  await daemon.start();
  daemons.push(daemon);
  const token = readFileSync(join(home, "token"), "utf8").trim();
  for (let i = 0; i < 200 && !daemon.relay?.connected; i++) await new Promise((r) => setTimeout(r, 25));
  const relayId = new URL(daemon.relay!.phoneUrl).pathname.split("/")[2]!;
  const scope = `/r/${relayId}`;
  const wsUrl = `${relay.url.replace("http", "ws")}/p/${relayId}`;
  const pairing = async () => {
    const res = await fetch(`${daemon.url}/api/v1/devices/pairings`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    return (await res.json()) as DevicePairing;
  };
  /** Pairs a phone the way the loader page does, and gives it a tunnel like the service worker's. */
  const phone = async () => {
    const { code } = await pairing();
    const done = await pairWithCode(new WebSocket(wsUrl), code, "Pixel 9");
    let creds: Creds | undefined = done.creds;
    const tunnel = new Tunnel({ relayId, creds: async () => creds, socket: () => new WebSocket(wsUrl) });
    tunnels.push(tunnel);
    const session = done.session as { access_token: string; device: { id: string } };
    return { tunnel, session, creds: done.creds, forget: () => (creds = undefined), get: (path: string, headers: Record<string, string> = {}) => respond(new Request(`http://relay.test${scope}${path}`, { headers }), scope, tunnel) };
  };
  const local = (path: string, init: RequestInit = {}) => fetch(daemon.url + path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  return { relay, daemon, relayId, scope, wsUrl, phone, pairing, local };
}

describe("the phone's side of the relay (ADR 0067)", () => {
  it("pairs with the code from the QR link and then opens the app from the daemon, with its links under the relay path", async () => {
    const { phone, scope } = await setup();
    const p = await phone();
    const page = await p.get("/", { accept: "text/html" });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    // The daemon's own security headers reach the page.
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    const html = await page.text();
    expect(html).toContain(`<meta name="navarch-base" content="${scope}">`);
    expect(html).toContain(`src="${scope}/assets/app.js"`);
    expect(html).toContain(`href="${scope}/manifest.webmanifest"`);
    expect(html).toContain('href="//other.example/x"');

    expect(await (await p.get("/assets/app.js")).text()).toBe("console.log('app')");
    const css = await (await p.get("/assets/app.css")).text();
    expect(css).toContain(`url(${scope}/assets/font.woff2)`);
    expect(css).toContain(`url('${scope}/assets/pic.png')`);
    expect(css).toContain("url(data:image/png;base64,AAAA)");
    const manifest = JSON.parse(await (await p.get("/manifest.webmanifest")).text());
    expect(manifest).toMatchObject({ id: `${scope}/home`, start_url: `${scope}/home`, scope: `${scope}/`, icons: [{ src: `${scope}/icons/icon-192.png` }] });
  });

  it("hands binary files over untouched", async () => {
    const { phone } = await setup();
    const p = await phone();
    const res = await p.get("/assets/pic.png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  it("calls the API with the app's own bearer token, and the local token still does not work", async () => {
    const { phone, local, scope } = await setup();
    const p = await phone();
    const auth = { authorization: `Bearer ${p.session.access_token}` };
    const runs = await p.get("/api/v1/runs", auth);
    expect(runs.status).toBe(200);
    expect(await runs.json()).toEqual([]);
    expect((await p.get("/api/v1/runs")).status).toBe(401);
    // The local token, sent through the relay, is refused (the connector marks every call it forwards).
    expect((await p.get("/api/v1/runs", { authorization: `Bearer ${(await local("/api/v1/health")).headers.get("x-none") ?? "wrong"}` })).status).toBe(401);
    // A POST carries its body: the refresh token trades for a new session.
    const refreshed = await respond(
      new Request(`http://relay.test${scope}/api/v1/devices/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refresh_token: (p.session as unknown as { refresh_token: string }).refresh_token }) }),
      scope,
      p.tunnel,
    );
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toMatchObject({ device: { id: p.session.device.id } });
  });

  it("answers a burst of requests, as a page does when it loads", async () => {
    const { phone } = await setup();
    const p = await phone();
    const results = await Promise.all(Array.from({ length: 60 }, () => p.get("/assets/app.js")));
    expect(results.map((r) => r.status)).toEqual(Array(60).fill(200));
  });

  it("says 503 when the computer is offline, and the app reads that as unreachable", async () => {
    const { phone, daemon } = await setup();
    const p = await phone();
    expect((await p.get("/api/v1/runs", { authorization: `Bearer ${p.session.access_token}` })).status).toBe(200);
    await daemon.relay!.stop();
    p.tunnel.close();
    const api = await p.get("/api/v1/runs", { authorization: `Bearer ${p.session.access_token}` });
    expect(api.status).toBe(503);
    expect(await api.json()).toMatchObject({ error: "offline" });
    const page = await p.get("/", { accept: "text/html" });
    expect(page.status).toBe(503);
    expect(await page.text()).toContain("cannot be reached");
  });

  it("is refused once the device is revoked, and when the phone has no credentials", async () => {
    const { phone, local } = await setup();
    const p = await phone();
    await local(`/api/v1/devices/${p.session.device.id}`, { method: "DELETE" });
    p.tunnel.close();
    const res = await p.get("/api/v1/runs", { authorization: `Bearer ${p.session.access_token}` });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "refused" });
    p.forget();
    expect(await (await p.get("/", { accept: "text/html" })).text()).toContain("no longer paired");
  });

  it("explains a pairing code that was used or has expired, and an offline computer", async () => {
    const { phone, pairing, wsUrl, daemon } = await setup();
    await phone();
    const spent = await pairing();
    await pairWithCode(new WebSocket(wsUrl), spent.code, "one");
    await expect(pairWithCode(new WebSocket(wsUrl), spent.code, "two")).rejects.toThrow(TunnelError);
    await daemon.relay!.stop();
    await expect(pairWithCode(new WebSocket(wsUrl), (await pairing()).code, "three")).rejects.toMatchObject({ reason: "offline" });
  });
});

describe("the loader the relay serves", () => {
  it("serves the page, its parts and the worker, and falls back to the page for any address under the relay id", async () => {
    const { relay, relayId } = await setup();
    const get = (path: string) => fetch(`${relay.url}${path}`, { redirect: "manual" });
    const index = await get(`/r/${relayId}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("loader");
    expect(index.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(index.headers.get("referrer-policy")).toBe("no-referrer");
    expect((await get(`/r/${relayId}`)).status).toBe(302);
    expect(await (await get(`/r/${relayId}/loader.js`)).text()).toBe("// loader");
    const sw = await get(`/r/${relayId}/sw.js`);
    expect(sw.headers.get("service-worker-allowed")).toBe(`/r/${relayId}/`);
    expect(sw.headers.get("content-type")).toContain("javascript");
    expect(await (await get(`/r/${relayId}/runs/run_1`)).text()).toContain("loader");
    expect((await get("/favicon.ico")).status).toBe(204);
  });

  it("says so when the loader was not built", async () => {
    const { relay, relayId } = await setup({ withPhone: false });
    const res = await fetch(`${relay.url}/r/${relayId}/`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("relay-build");
  });
});

describe("rewrites", () => {
  const scope = "/r/abcdefghijklmnopqrstuv";

  it("keep links the page already makes to other hosts or protocol-relative addresses", () => {
    const html = rewriteHtml('<head><link href="https://cdn.example/x.css"><img src="//cdn/x.png"><img src="relative.png"><a href="/home">', scope);
    expect(html).toContain('href="https://cdn.example/x.css"');
    expect(html).toContain('src="//cdn/x.png"');
    expect(html).toContain('src="relative.png"');
    expect(html).toContain(`href="${scope}/home"`);
    expect(html.match(/navarch-base/g)).toHaveLength(1);
  });

  it("move only absolute urls in a stylesheet and a manifest", () => {
    expect(rewriteCss("a{background:url(/x.png)}b{background:url( https://h/x.png )}", scope)).toBe(`a{background:url(${scope}/x.png)}b{background:url( https://h/x.png )}`);
    expect(JSON.parse(rewriteManifest(JSON.stringify({ start_url: "https://h/x", icons: [{ src: "/i.png" }, { src: "j.png" }] }), scope))).toMatchObject({ start_url: "https://h/x", icons: [{ src: `${scope}/i.png` }, { src: "j.png" }], scope: `${scope}/` });
  });
});
