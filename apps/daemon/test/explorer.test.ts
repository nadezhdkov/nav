import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeSymbol, ProjectView, RepoMap, SearchHit, TraceabilityView } from "@navarch/contracts";
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

  it("serves the traceability matrices of the clone's specs (ADR 0054)", async () => {
    const { api, project } = await setup();
    const empty = await api<TraceabilityView>("GET", `/api/v1/projects/${project.id}/traceability`);
    expect(empty.body).toMatchObject({ has_specs: false, code_spec: [], totals: { source_files: 1, cited_files: 0 } });

    const repo = project.path;
    mkdirSync(join(repo, ".navarch", "specs"), { recursive: true });
    writeFileSync(join(repo, "app.test.ts"), "import { greet } from './app.ts';\n");
    writeFileSync(join(repo, ".navarch", "specs", "greeting.md"), "# Greeting\n\n## Claims\n\n- 🟢 **says-hi** greet says hi — `app.ts:2`\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    const view = await api<TraceabilityView>("GET", `/api/v1/projects/${project.id}/traceability`);
    expect(view.status).toBe(200);
    expect(view.body.code_spec).toEqual([{ file: "app.ts", claims: [{ component: "greeting", claim: "says-hi", confidence: "confirmed", line: 2 }], tests: [{ file: "app.test.ts", via: "name" }] }]);
    expect(view.body.totals).toMatchObject({ cited_share: 1, tested_share: 1 });
    expect((await api("GET", "/api/v1/projects/prj_missing/traceability")).status).toBe(404);
  });

  it("rejects a missing query or kind and unknown projects", async () => {
    const { api, project } = await setup();
    expect((await api("GET", `/api/v1/projects/${project.id}/symbols`)).status).toBe(400);
    expect((await api("GET", `/api/v1/projects/${project.id}/symbols?q=x&kind=nope`)).status).toBe(400);
    expect((await api("GET", `/api/v1/projects/${project.id}/search`)).status).toBe(400);
    expect((await api("GET", "/api/v1/projects/prj_missing/map")).status).toBe(404);
  });
});
