import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddProjectResult, DevicePairing, DeviceSession, ProjectFilesView, ProjectFileView } from "@navarch/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { fakeClaude } from "../../../packages/adapters/claude-code/test/fake.ts";
import { fakeGitHub, type FakeGitHub } from "../../../packages/github/test/fake-github.ts";
import { makeRepo, tempHome } from "../../../packages/runner/test/helpers.ts";
import { Config } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";
import { conciergeTools, type ToolDeps } from "../src/concierge/tools.ts";
import { workspaceRoot } from "../src/inbox/workspace.ts";
import { Vault } from "../src/vault/vault.ts";

const daemons: Daemon[] = [];
const servers: FakeGitHub[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop().catch(() => {});
  for (const s of servers.splice(0)) await s.close();
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function start(withRoot: boolean) {
  const gh = await fakeGitHub();
  servers.push(gh);
  const gitUrl = mkdtempSync(join(tmpdir(), "navarch-remote-"));
  const source = makeRepo();
  gh.onCreateRepo = (full) => {
    const [owner, name] = full.split("/") as [string, string];
    mkdirSync(join(gitUrl, owner), { recursive: true });
    execFileSync("git", ["clone", "-q", "--bare", source, join(gitUrl, owner, `${name}.git`)]);
  };
  const root = mkdtempSync(join(tmpdir(), "navarch-workspace-"));
  const home = tempHome();
  const daemon = new Daemon({
    home,
    config: Config.parse({
      daemon: { port: 0, remote: { url: "https://pc.tail1234.ts.net", tailscale_command: "/nonexistent/tailscale" } },
      routing: { enabled: false },
      github: { api_url: gh.apiUrl, git_url: gitUrl },
      inbox: { poll_minutes: 0 },
      ...(withRoot ? { workspace: { root } } : {}),
    }),
    adapters: { "claude-code": fakeClaude("edit").options },
    vault: new Vault({ env: { NAVARCH_SECRET_GITHUB_TOKEN: gh.token } }),
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
  return { daemon, home, root, gh, phone: <T>(m: string, p: string, b?: unknown) => call<T>(session.access_token, m, p, b), desktop: <T>(m: string, p: string, b?: unknown) => call<T>(desktop, m, p, b) };
}

describe("workspace root (ADR 0073)", () => {
  it("expands ~/ and keeps absolute paths; unset stays unset", () => {
    expect(workspaceRoot("~/Documents/projects", "/home/a")).toBe("/home/a/Documents/projects");
    expect(workspaceRoot("/srv/code/", "/home/a")).toBe("/srv/code");
    expect(workspaceRoot(undefined)).toBeUndefined();
    expect(() => Config.parse({ workspace: { root: "projects" } })).toThrow();
  });

  it("creates and clones new repositories under the root, else in the Navarch home", async () => {
    const withRoot = await start(true);
    const made = await withRoot.phone<AddProjectResult>("POST", "/api/v1/github/repos/create", { name: "my-game" });
    expect(made.body.path).toBe(join(withRoot.root, "my-game"));
    expect(existsSync(join(withRoot.root, "my-game", ".git"))).toBe(true);
    const without = await start(false);
    const other = await without.desktop<AddProjectResult>("POST", "/api/v1/github/repos/create", { name: "my-game" });
    expect(other.body.path).toBe(join(without.home, "repos", "nadezhdkov", "my-game"));
  });
});

describe("project files for @ mentions (ADR 0073)", () => {
  async function project() {
    const ctx = await start(false);
    const repo = makeRepo();
    mkdirSync(join(repo, "docs"));
    writeFileSync(join(repo, "docs", "plan.md"), "# Plan\n");
    writeFileSync(join(repo, ".gitignore"), ".env\n");
    writeFileSync(join(repo, ".env"), "SECRET=1\n");
    writeFileSync(join(repo, "blob.bin"), Buffer.from([0, 1, 2]));
    symlinkSync("/etc/hostname", join(repo, "escape.txt"));
    git(repo, "remote", "add", "origin", "https://github.com/acme/widgets.git");
    git(repo, "add", ".");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "-m", "docs");
    const added = await ctx.desktop<AddProjectResult>("POST", "/api/v1/projects", { path: repo });
    return { ...ctx, id: added.body.id };
  }

  it("lists folders then files git knows, filtered, and never ignored or hidden ones", async () => {
    const { phone, id } = await project();
    const all = (await phone<ProjectFilesView>("GET", `/api/v1/projects/${id}/files`)).body.entries.map((e) => `${e.kind}:${e.path}`);
    expect(all).toContain("dir:docs/");
    expect(all).toContain("file:docs/plan.md");
    expect(all.join(" ")).not.toMatch(/\.env|\.git\//);
    expect(all.indexOf("dir:docs/")).toBeLessThan(all.indexOf("file:docs/plan.md"));
    const narrowed = (await phone<ProjectFilesView>("GET", `/api/v1/projects/${id}/files?prefix=docs/&q=pla&kind=file`)).body.entries;
    expect(narrowed).toEqual([{ path: "docs/plan.md", kind: "file" }]);
  });

  it("reads a text file git knows and nothing else", async () => {
    const { phone, id } = await project();
    expect((await phone<ProjectFileView>("GET", `/api/v1/projects/${id}/file?path=docs/plan.md`)).body).toEqual({ path: "docs/plan.md", content: "# Plan\n" });
    for (const path of [".env", "../../etc/passwd", "/etc/passwd", ".git/config", "blob.bin", "missing.md"]) {
      expect((await phone("GET", `/api/v1/projects/${id}/file?path=${encodeURIComponent(path)}`)).status, path).toBe(404);
    }
    // A tracked symlink pointing outside the project is not followed.
    expect((await phone("GET", `/api/v1/projects/${id}/file?path=escape.txt`)).status).toBe(404);
    expect((await phone("GET", `/api/v1/projects/${id}/file`)).status).toBe(400);
  });
});

describe("create_repo in the chat (ADR 0073)", () => {
  it("proposes a private repository by default and creates it as the operator", async () => {
    const calls: unknown[] = [];
    const tools = conciergeTools({
      actor: () => ({ kind: "user", via: "mobile", device_id: "dev_1" }),
      createRepo: async (req: unknown) => {
        calls.push(req);
        return { repo: "nadezhdkov/my-game", path: "/p/my-game" } as never;
      },
    } as unknown as ToolDeps);
    const tool = tools.find((t) => t.name === "create_repo")!;
    expect(tool.kind).toBe("act");
    expect(tool.kind === "act" && tool.summarize?.({ name: "my-game", description: "A game" })).toMatch(/create the private GitHub repository my-game \("A game"\)/);
    const result = await tool.run({ name: "my-game" });
    expect(calls).toEqual([{ name: "my-game", private: true }]);
    expect(tool.kind === "act" && tool.describe?.(result)).toMatch(/nadezhdkov\/my-game created.*\/p\/my-game/);
    await tool.run({ name: "open-one", public: true });
    expect(calls[1]).toEqual({ name: "open-one", private: false });
    await expect(tool.run({ name: "bad name/x" })).rejects.toThrow(/name/);
  });
});
