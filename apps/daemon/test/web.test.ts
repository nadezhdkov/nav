import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunDetail, RunView } from "@navarch/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { fakeClaude } from "../../../packages/adapters/claude-code/test/fake.ts";
import { makeRepo, tempHome } from "../../../packages/runner/test/helpers.ts";
import { Config } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";

/** The Web UI's static files and token handoff (ADR 0017). */

const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop().catch(() => {});
});

function webBuild(): string {
  const dir = mkdtempSync(join(tmpdir(), "navarch-web-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Navarch</title><div id=app></div>");
  writeFileSync(join(dir, "assets", "app.js"), "console.log('hi')");
  return dir;
}

async function start(web_dir: string) {
  const home = tempHome();
  const config = Config.parse({ daemon: { port: 0, web_dir }, routing: { enabled: false } });
  const daemon = new Daemon({ home, config, adapters: { "claude-code": fakeClaude("edit").options } });
  await daemon.start();
  daemons.push(daemon);
  return { daemon, token: readFileSync(join(home, "token"), "utf8").trim() };
}

describe("Web UI serving", () => {
  it("serves the SPA and its assets without a token, with a strict CSP", async () => {
    const { daemon } = await start(webBuild());
    const index = await fetch(`${daemon.url}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("<title>Navarch</title>");
    const csp = index.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-eval");
    expect(index.headers.get("x-content-type-options")).toBe("nosniff");
    expect(index.headers.get("referrer-policy")).toBe("no-referrer");

    const asset = await fetch(`${daemon.url}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
  });

  it("falls back to index.html for client routes, but not for the API or missing assets", async () => {
    const { daemon } = await start(webBuild());
    const route = await fetch(`${daemon.url}/runs/run_123`);
    expect(route.status).toBe(200);
    expect(route.headers.get("content-type")).toContain("text/html");

    const api = await fetch(`${daemon.url}/api/v1/nope`);
    expect(api.status).toBe(401);
    const missing = await fetch(`${daemon.url}/assets/missing.js`);
    expect(missing.status).toBe(404);
  });

  it("serves files added after start (a rebuild) without a restart", async () => {
    const dir = webBuild();
    const { daemon } = await start(dir);
    writeFileSync(join(dir, "assets", "new-hash.js"), "console.log('rebuilt')");
    const res = await fetch(`${daemon.url}/assets/new-hash.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect((await fetch(`${daemon.url}/`)).headers.get("cache-control")).toBe("no-cache");
  });

  it("still requires the token for every API route", async () => {
    const { daemon, token } = await start(webBuild());
    expect((await fetch(`${daemon.url}/api/v1/runs`)).status).toBe(401);
    expect((await fetch(`${daemon.url}/api/v1/runs`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await fetch(`${daemon.url}/api/v1/unknown`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
  });

  it("explains how to build the UI when the build is missing", async () => {
    const { daemon } = await start(join(tmpdir(), "navarch-no-such-build"));
    const res = await fetch(`${daemon.url}/`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("make web-build");
  });

  it("returns the run's Flow copy in the run detail", async () => {
    const { daemon, token } = await start(webBuild());
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const created = (await (
      await fetch(`${daemon.url}/api/v1/runs`, { method: "POST", headers, body: JSON.stringify({ repo_path: makeRepo(), prompt: "add hello.txt" }) })
    ).json()) as RunView;
    const detail = (await (await fetch(`${daemon.url}/api/v1/runs/${created.id}`, { headers })).json()) as RunDetail;
    expect(detail.flow_definition?.definition.metadata.name).toBe("task");
    expect(detail.flow_definition?.definition.edges.length).toBeGreaterThan(0);
  });
});

describe("Web UI sign-in codes", () => {
  it("trades a single-use code for the token, once", async () => {
    const { daemon, token } = await start(webBuild());
    const unauth = await fetch(`${daemon.url}/api/v1/web/codes`, { method: "POST" });
    expect(unauth.status).toBe(401);

    const res = await fetch(`${daemon.url}/api/v1/web/codes`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(201);
    const { code } = (await res.json()) as { code: string; expires_at: string };
    expect(code).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(code).not.toContain(token);

    const exchange = (c: string) =>
      fetch(`${daemon.url}/api/v1/web/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: c }) });
    const first = await exchange(code);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ token });
    expect((await exchange(code)).status).toBe(401);
    expect((await exchange("not-a-code")).status).toBe(401);
  });
});
