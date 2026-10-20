import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddProjectResult, DevicePairing, DeviceSession, SessionDetail, SessionsListing } from "@navarch/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { fakeClaudeSession } from "../../../packages/adapters/claude-code/test/fake.ts";
import { makeRepo, tempHome } from "../../../packages/runner/test/helpers.ts";
import { Config } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";

const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop().catch(() => {});
});

async function start(sessions: Record<string, unknown> | null = { enabled: true }) {
  const fake = fakeClaudeSession();
  const home = tempHome();
  const daemon = new Daemon({
    home,
    config: Config.parse({
      daemon: { port: 0, remote: { url: "https://pc.tail1234.ts.net", tailscale_command: "/nonexistent/tailscale" } },
      routing: { enabled: false },
      inbox: { poll_minutes: 0 },
      ...(sessions ? { sessions } : {}),
    }),
    adapters: { "claude-code": fake.options },
  });
  await daemon.start();
  daemons.push(daemon);
  const call = async <T>(bearer: string, method: string, path: string, body?: unknown) => {
    const res = await fetch(daemon.url + path, { method, headers: { authorization: `Bearer ${bearer}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
  };
  const desktop = readFileSync(join(home, "token"), "utf8").trim();
  const pairing = (await call<DevicePairing>(desktop, "POST", "/api/v1/devices/pairings")).body;
  const paired = await fetch(daemon.url + "/api/v1/devices/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: pairing.code, name: "Pixel 9" }) });
  const session = (await paired.json()) as DeviceSession;
  const api = <T>(m: string, p: string, b?: unknown) => call<T>(desktop, m, p, b);
  const phone = <T>(m: string, p: string, b?: unknown) => call<T>(session.access_token, m, p, b);
  const repo = makeRepo();
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], { cwd: repo });
  const project = (await api<AddProjectResult>("POST", "/api/v1/projects", { path: repo })).body;
  const until = async (id: string, done: (s: SessionDetail) => boolean) => {
    const end = Date.now() + 10_000;
    for (;;) {
      const s = (await api<SessionDetail>("GET", `/api/v1/sessions/${id}`)).body;
      if (done(s)) return s;
      if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(s)}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  return { daemon, fake, api, phone, repo, project, until, device: session.device.id };
}

describe("live sessions (ADR 0074)", () => {
  it("is off until the PC's config turns it on, and a phone cannot turn it on", async () => {
    const { api, phone, project } = await start(null);
    expect((await api<SessionsListing>("GET", "/api/v1/sessions")).body).toEqual({ enabled: false, sessions: [] });
    for (const call of [api, phone]) {
      const res = await call<{ error: string }>("POST", "/api/v1/sessions", { project_id: project.id });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("disabled");
    }
  });

  it("opens in the project's folder, streams the answer and records the turn", async () => {
    const { api, daemon, fake, project, repo, until } = await start();
    const opened = await api<SessionDetail>("POST", "/api/v1/sessions", { project_id: project.id });
    expect(opened.status).toBe(201);
    expect(opened.body).toMatchObject({ project_name: project.name, path: repo, permission_mode: "default", status: "idle" });
    const id = opened.body.id;
    await api("POST", `/api/v1/sessions/${id}/messages`, { text: "hello there" });
    const done = await until(id, (s) => s.items.some((i) => i.kind === "assistant") && s.status === "idle");
    expect(done.items.map((i) => [i.kind, i.text])).toEqual([["user", "hello there"], ["assistant", "Working on it"]]);
    expect(done.cost_usd).toBeCloseTo(0.01);
    const seen = fake.seen();
    expect(seen[0]).toMatchObject({ cwd: repo });
    expect((seen[0]!.args as string[]).join(" ")).toMatch(/--permission-prompt-tool stdio --permission-mode default .*--max-budget-usd 5.00 --session-id /);
    expect(daemon.store.events().filter((e) => e.type.startsWith("session.")).map((e) => e.type)).toEqual(["session.opened", "session.message", "session.reply"]);
    // Only what is new comes back after a seq.
    expect((await api<SessionDetail>("GET", `/api/v1/sessions/${id}?after=${done.seq - 1}`)).body.items).toHaveLength(1);
  });

  it("holds a permission question until the user answers, as the phone", async () => {
    const { phone, daemon, project, repo, until, device } = await start();
    const id = (await phone<SessionDetail>("POST", "/api/v1/sessions", { project_id: project.id })).body.id;
    await phone("POST", `/api/v1/sessions/${id}/messages`, { text: "please write a file" });
    const waiting = await until(id, (s) => s.status === "waiting");
    const ask = waiting.items.find((i) => i.kind === "permission")!;
    expect(ask).toMatchObject({ tool: "Write", status: "pending" });
    expect(waiting.pending).toBe(1);
    expect(existsSync(join(repo, "hello.txt"))).toBe(false);

    await phone("POST", `/api/v1/sessions/${id}/permissions/${ask.request_id}`, { decision: "allow" });
    const done = await until(id, (s) => s.status === "idle");
    expect(existsSync(join(repo, "hello.txt"))).toBe(true);
    expect(done.items.find((i) => i.kind === "permission")?.status).toBe("allowed");
    expect(done.items.at(-1)).toMatchObject({ kind: "assistant", text: "Wrote hello.txt." });
    const decision = daemon.store.events().find((e) => e.type === "session.permission")!;
    expect(decision).toMatchObject({ actor: { kind: "user", via: "mobile", device_id: device }, payload: { tool: "Write", decision: "allow" } });
    // An answer is single use.
    expect((await phone("POST", `/api/v1/sessions/${id}/permissions/${ask.request_id}`, { decision: "allow" })).status).toBe(404);
  });

  it("tells the agent when the user refuses", async () => {
    const { api, project, repo, until } = await start();
    const id = (await api<SessionDetail>("POST", "/api/v1/sessions", { project_id: project.id })).body.id;
    await api("POST", `/api/v1/sessions/${id}/messages`, { text: "write it" });
    const ask = (await until(id, (s) => s.status === "waiting")).items.find((i) => i.kind === "permission")!;
    await api("POST", `/api/v1/sessions/${id}/permissions/${ask.request_id}`, { decision: "deny", message: "not now" });
    const done = await until(id, (s) => s.status === "idle");
    expect(existsSync(join(repo, "hello.txt"))).toBe(false);
    expect(done.items.at(-1)?.text).toBe("Refused: not now");
    expect(done.items.find((i) => i.kind === "permission")?.status).toBe("denied");
  });

  it("passes images to the agent, caps open sessions, and closes them", async () => {
    const { api, daemon, fake, project, until } = await start({ enabled: true, max_open: 1 });
    const id = (await api<SessionDetail>("POST", "/api/v1/sessions", { project_id: project.id })).body.id;
    const png = Buffer.from("not really a png").toString("base64");
    await api("POST", `/api/v1/sessions/${id}/messages`, { text: "look", images: [{ media_type: "image/png", data: png }] });
    const done = await until(id, (s) => s.items.some((i) => i.kind === "assistant"));
    expect(done.items.at(-1)?.text).toBe("Working on it (saw 1 image)");
    expect(fake.seen().find((s) => s.user === "look")).toMatchObject({ images: 1 });
    // The image itself is not stored in the log, only counted.
    expect(daemon.store.events().find((e) => e.type === "session.message")?.payload).toMatchObject({ text: "look", images: 1 });

    expect((await api("POST", "/api/v1/sessions", { project_id: project.id })).status).toBe(409);
    const closed = await api<SessionDetail>("DELETE", `/api/v1/sessions/${id}`);
    expect(closed.body).toMatchObject({ status: "closed", closed_reason: "closed by the user" });
    expect((await api("POST", `/api/v1/sessions/${id}/messages`, { text: "again" })).status).toBe(409);
    expect((await api("POST", "/api/v1/sessions", { project_id: project.id })).status).toBe(201);
  });

  it("refuses a Claude Code on an API key, unknown projects and bad messages", async () => {
    const { api, project, until } = await start();
    expect((await api("POST", "/api/v1/sessions", { project_id: "prj_nope" })).status).toBe(404);
    const id = (await api<SessionDetail>("POST", "/api/v1/sessions", { project_id: project.id })).body.id;
    expect((await api("POST", `/api/v1/sessions/${id}/messages`, { text: "" })).status).toBe(400);
    expect((await api("POST", `/api/v1/sessions/${id}/messages`, { text: "x", images: [{ media_type: "image/svg+xml", data: "AAAA" }] })).status).toBe(400);
    await api("POST", `/api/v1/sessions/${id}/messages`, { text: "apikey please" });
    const closed = await until(id, (s) => s.status === "closed");
    expect(closed.closed_reason).toMatch(/API key/);
  });

  it("can reopen an earlier conversation of the same project", async () => {
    const { api, fake, project, until } = await start();
    const first = (await api<SessionDetail>("POST", "/api/v1/sessions", { project_id: project.id })).body;
    await api("DELETE", `/api/v1/sessions/${first.id}`);
    const again = await api<SessionDetail>("POST", "/api/v1/sessions", { project_id: project.id, resume: first.id });
    expect(again.status).toBe(201);
    await api("POST", `/api/v1/sessions/${again.body.id}/messages`, { text: "continue" });
    await until(again.body.id, (s) => s.items.some((i) => i.kind === "assistant"));
    const calls = fake.seen().filter((s) => s.args);
    expect((calls.at(-1)!.args as string[]).join(" ")).toContain(`--resume ${first.claude_session_id}`);
  });
});
