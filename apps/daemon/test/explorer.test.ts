import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeSymbol, ProjectView, RepoMap, SearchHit } from "@navarch/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { makeRepo, tempHome } from "../../../packages/runner/test/helpers.ts";
import { Config } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";
import { Vault } from "../src/vault/vault.ts";

const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop().catch(() => {});
});

async function setup() {
  const repo = makeRepo();
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], { cwd: repo });
  writeFileSync(join(repo, "app.ts"), "export function greet(name: string) {\n  return `hi ${name}`;\n}\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  const home = tempHome();
  const daemon = new Daemon({
    home,
    config: Config.parse({ daemon: { port: 0 }, routing: { enabled: false }, inbox: { poll_minutes: 0 } }),
    adapters: {},
    vault: new Vault({ env: {} }),
  });
  await daemon.start();
  daemons.push(daemon);
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const api = async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(daemon.url + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
  };
  const project = (await api<ProjectView>("POST", "/api/v1/projects", { path: repo })).body;
  return { api, project };
}

describe("repository exploration routes (ADR 0042)", () => {
  it("maps, finds symbols and searches text in a project's clone", async () => {
    const { api, project } = await setup();
    const map = await api<RepoMap>("GET", `/api/v1/projects/${project.id}/map`);
    expect(map.status).toBe(200);
    expect(map.body.languages[0]?.lang).toBe("typescript");

    const symbols = await api<CodeSymbol[]>("GET", `/api/v1/projects/${project.id}/symbols?q=greet`);
    expect(symbols.body).toEqual([{ name: "greet", kind: "function", lang: "typescript", file: "app.ts", line: 1, exported: true }]);

    const hits = await api<SearchHit[]>("GET", `/api/v1/projects/${project.id}/search?q=hi%20`);
    expect(hits.body).toEqual([{ file: "app.ts", line: 2, text: "return `hi ${name}`;" }]);
  });

  it("rejects a missing query or kind and unknown projects", async () => {
    const { api, project } = await setup();
    expect((await api("GET", `/api/v1/projects/${project.id}/symbols`)).status).toBe(400);
    expect((await api("GET", `/api/v1/projects/${project.id}/symbols?q=x&kind=nope`)).status).toBe(400);
    expect((await api("GET", `/api/v1/projects/${project.id}/search`)).status).toBe(400);
    expect((await api("GET", "/api/v1/projects/prj_missing/map")).status).toBe(404);
  });
});
