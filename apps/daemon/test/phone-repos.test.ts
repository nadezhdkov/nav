import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddProjectResult, DevicePairing, DeviceSession, GitHubRepoView } from "@navarch/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { fakeClaude } from "../../../packages/adapters/claude-code/test/fake.ts";
import { fakeGitHub, type FakeGitHub } from "../../../packages/github/test/fake-github.ts";
import { makeRepo, tempHome } from "../../../packages/runner/test/helpers.ts";
import { Config } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";
import { Vault } from "../src/vault/vault.ts";

const daemons: Daemon[] = [];
const servers: FakeGitHub[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop().catch(() => {});
  for (const s of servers.splice(0)) await s.close();
});

/** A fake GitHub whose new repositories get a bare git remote, and a daemon a phone can pair with. */
async function start() {
  const gh = await fakeGitHub();
  servers.push(gh);
  gh.userRepos = [{ full_name: "acme/widgets", private: true }];
  const gitUrl = mkdtempSync(join(tmpdir(), "navarch-remote-"));
  const source = makeRepo();
  const bare = (fullName: string) => {
    const [owner, name] = fullName.split("/") as [string, string];
    mkdirSync(join(gitUrl, owner), { recursive: true });
    execFileSync("git", ["clone", "-q", "--bare", source, join(gitUrl, owner, `${name}.git`)]);
  };
  bare("acme/widgets");
  gh.onCreateRepo = bare;
  const home = tempHome();
  const daemon = new Daemon({
    home,
    config: Config.parse({
      daemon: { port: 0, remote: { url: "https://pc.tail1234.ts.net", tailscale_command: "/nonexistent/tailscale" } },
      routing: { enabled: false },
      github: { api_url: gh.apiUrl, git_url: gitUrl },
      inbox: { poll_minutes: 0 },
    }),
    adapters: { "claude-code": fakeClaude("edit").options },
    vault: new Vault({ env: { NAVARCH_SECRET_GITHUB_TOKEN: gh.token } }),
  });
  await daemon.start();
  daemons.push(daemon);
  const call = async <T>(bearer: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(daemon.url + path, {
      method,
      headers: { authorization: `Bearer ${bearer}`, ...headers, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
  };
  const desktop = readFileSync(join(home, "token"), "utf8").trim();
  const pairing = (await call<DevicePairing>(desktop, "POST", "/api/v1/devices/pairings")).body;
  const paired = await fetch(daemon.url + "/api/v1/devices/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: pairing.code, name: "Pixel 9" }) });
  const session = (await paired.json()) as DeviceSession;
  const phone = <T>(method: string, path: string, body?: unknown) => call<T>(session.access_token, method, path, body);
  return { daemon, gh, home, phone, desktop: <T>(method: string, path: string, body?: unknown) => call<T>(desktop, method, path, body), device: session.device.id };
}

describe("repositories from a paired phone (ADR 0071)", () => {
  it("lists and clones a GitHub repository, as the device", async () => {
    const { phone, home, daemon, device } = await start();
    const listed = await phone<GitHubRepoView[]>("GET", "/api/v1/github/repos");
    expect(listed.status).toBe(200);
    expect(listed.body.map((r) => r.repo)).toEqual(["acme/widgets"]);
    const cloned = await phone<AddProjectResult>("POST", "/api/v1/github/repos/clone", { repo: "acme/widgets" });
    expect(cloned.status).toBe(201);
    expect(existsSync(join(home, "repos", "acme", "widgets", ".git"))).toBe(true);
    const added = daemon.store.events().find((e) => e.type === "project.added");
    expect(added?.actor).toEqual({ kind: "user", via: "mobile", device_id: device });
    // It is a project now, so the phone can start a run in it.
    expect((await phone("POST", "/api/v1/runs", { repo_path: join(home, "repos", "acme", "widgets"), prompt: "add hello.txt" })).status).toBe(201);
  });

  it("creates a private repository on the account, clones it and registers it", async () => {
    const { phone, home, daemon, gh, device } = await start();
    const created = await phone<AddProjectResult>("POST", "/api/v1/github/repos/create", { name: "my-game", description: "A new game" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ repo: "nadezhdkov/my-game", path: join(home, "repos", "nadezhdkov", "my-game") });
    expect(existsSync(join(home, "repos", "nadezhdkov", "my-game", ".git"))).toBe(true);
    expect(gh.userRepos[0]).toMatchObject({ full_name: "nadezhdkov/my-game", private: true, description: "A new game" });
    const event = daemon.store.events().find((e) => e.type === "github.repo.created");
    expect(event).toMatchObject({ actor: { kind: "user", via: "mobile", device_id: device }, payload: { repo: "nadezhdkov/my-game", private: true } });
  });

  it("refuses bad names and a name GitHub already has", async () => {
    const { phone, desktop } = await start();
    for (const name of ["", "a/b", "..", "x.git", "has space"]) {
      expect((await phone("POST", "/api/v1/github/repos/create", { name })).status).toBe(400);
    }
    expect((await desktop("POST", "/api/v1/github/repos/create", { name: "taken" })).status).toBe(201);
    const again = await phone<{ message: string }>("POST", "/api/v1/github/repos/create", { name: "taken" });
    expect(again.status).toBe(502);
    expect(again.body.message).toMatch(/already exists/);
  });

  it("keeps the other desktop-only routes closed to the phone", async () => {
    const { phone } = await start();
    expect((await phone("POST", "/api/v1/projects", { path: "/tmp/x" })).status).toBe(403);
  });
});
