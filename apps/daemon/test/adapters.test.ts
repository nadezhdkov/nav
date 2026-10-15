import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunDetail, RunView, NavarchEvent } from "@navarch/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { fakeModelServer, type FakeServer } from "../../../packages/adapters/native/test/fake-server.ts";
import { makeRepo, tempHome } from "../../../packages/runner/test/helpers.ts";
import { Config } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn().catch(() => {});
});

async function start(server: FakeServer, config: Record<string, unknown> = {}) {
  const home = tempHome();
  const daemon = new Daemon({
    home,
    config: Config.parse({ daemon: { port: 0 }, routing: { enabled: false }, ...config }),
    adapters: { native: { providers: { fake: { baseUrl: server.baseUrl } } } },
  });
  await daemon.start();
  cleanup.push(() => daemon.stop());
  const token = readFileSync(join(home, "token"), "utf8").trim();
  return async <T>(method: string, path: string, body?: unknown) => {
    const res = await fetch(daemon.url + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  const end = Date.now() + 15_000;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("adapter selection", () => {
  it("runs a task with the native adapter and a chosen model", async () => {
    const server = await fakeModelServer([
      { tool_calls: [{ name: "write_file", args: { path: "docs/NOTE.md", content: "note\n" } }] },
      { content: "Added docs/NOTE.md." },
    ]);
    cleanup.push(() => server.close());
    const api = await start(server);

    const created = await api<RunView>("POST", "/api/v1/runs", {
      repo_path: makeRepo(),
      prompt: "add a note",
      adapter: "native",
      model: "fake/tiny",
    });
    expect(created.status).toBe(201);
    const run = await until(() => api<RunDetail>("GET", `/api/v1/runs/${created.body.id}`), (r) => r.body.status === "done");
    expect(run.body.tasks[0]).toMatchObject({ adapter: "native", status: "succeeded", summary: "Added docs/NOTE.md." });
    expect(run.body.artifacts[0]?.summary).toContain("docs/NOTE.md");

    const events = await api<NavarchEvent[]>("GET", `/api/v1/runs/${created.body.id}/events`);
    const call = events.body.find((e) => e.type === "model.call.completed");
    expect(call?.payload).toMatchObject({ model: "fake/tiny", cost: 0 });
    expect(server.requests[0]?.model).toBe("tiny");
  });

  it("uses default_adapter and rejects disabled adapters", async () => {
    const server = await fakeModelServer([{ content: "nothing to do" }]);
    cleanup.push(() => server.close());
    const api = await start(server, { default_adapter: "native", adapters: { codex: { enabled: false }, native: { model: "fake/tiny" } } });

    const ok = await api<RunView>("POST", "/api/v1/runs", { repo_path: makeRepo(), prompt: "x" });
    const run = await until(() => api<RunDetail>("GET", `/api/v1/runs/${ok.body.id}`), (r) => r.body.status === "done");
    expect(run.body.tasks[0]?.adapter).toBe("native");

    const rejected = await api<{ error: string; message: string }>("POST", "/api/v1/runs", { repo_path: makeRepo(), prompt: "x", adapter: "codex" });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe("unknown_adapter");
  });
});
