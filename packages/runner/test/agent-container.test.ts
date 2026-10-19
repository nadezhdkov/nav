import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ContainerIsolation } from "@navarch/contracts";
import { agentContainerArgs, ENTRY_PATH, forwardedEnv, seedHome, type AgentContainer } from "../src/agent-container.ts";
import { startEgressProxy, type EgressProxy } from "../src/egress.ts";

const isolation: ContainerIsolation = {
  kind: "container", image: "node:22-bookworm-slim", network: "none", memory: "4g", cpus: 2, pids_limit: 1024,
  hardened: { agent_image: "navarch-agent:test", egress_allow: [] },
};
const base: AgentContainer = {
  runtime: "docker", isolation, name: "navarch-t1-1-agent-1", worktree: "/w/run/impl", gitDir: "/r/.git", readOnly: false,
  user: { uid: 1000, gid: 1000 }, home: "/n/agent-homes/t1", socketDir: "/tmp/navarch-egress-x", socketName: "egress.sock",
  command: "/usr/local/bin/claude", args: ["-p", "--model", "sonnet"], env: { ANTHROPIC_API_KEY: "sk-test" },
};

describe("agentContainerArgs", () => {
  const args = agentContainerArgs(base);
  const has = (flag: string) => args.includes(flag);

  it("has no network interface and no privileges", () => {
    for (const flag of ["--network=none", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--read-only", "--interactive", "--rm", "--init"]) expect(has(flag)).toBe(true);
    expect(args).toContain("--user=1000:1000");
    expect(args.some((a) => a.startsWith("--network=") && a !== "--network=none")).toBe(false);
    expect(args.some((a) => a === "--privileged" || a.startsWith("--device") || a.startsWith("--cap-add"))).toBe(false);
  });

  it("mounts the worktree, the git directory read-only, the agent's home, the socket and the entry script, and nothing else", () => {
    const mounts = args.filter((a) => a.startsWith("--volume="));
    expect(mounts).toEqual([
      "--volume=/w/run/impl:/w/run/impl:rw",
      "--volume=/n/agent-homes/t1:/n/agent-homes/t1:rw",
      "--volume=/tmp/navarch-egress-x:/run/navarch:rw",
      `--volume=${ENTRY_PATH}:/opt/navarch/agent-entry.mjs:ro`,
      "--volume=/r/.git:/r/.git:ro",
    ]);
  });

  it("mounts the worktree read-only for a profile that may not edit", () => {
    expect(agentContainerArgs({ ...base, readOnly: true })).toContain("--volume=/w/run/impl:/w/run/impl:ro");
  });

  it("starts the agent through the entry script, with the command reduced to its name, after the image", () => {
    const i = args.indexOf("navarch-agent:test");
    expect(args.slice(i)).toEqual(["navarch-agent:test", "node", "/opt/navarch/agent-entry.mjs", "/run/navarch/egress.sock", "--", "claude", "-p", "--model", "sonnet"]);
  });

  it("gives it the proxy, a home of its own, the key it was passed, and nothing else", () => {
    const env = Object.fromEntries(args.filter((a) => a.startsWith("--env=")).map((a) => a.slice(6).split(/=(.*)/s, 2) as [string, string]));
    expect(env).toMatchObject({ HOME: "/n/agent-homes/t1", HTTPS_PROXY: "http://127.0.0.1:3128", NO_PROXY: "", NODE_USE_ENV_PROXY: "1", ANTHROPIC_API_KEY: "sk-test", NAVARCH_SANDBOX: "hardened" });
    expect(Object.keys(env).sort()).toEqual(expect.arrayContaining(["CI", "GIT_OPTIONAL_LOCKS"]));
    expect(JSON.stringify(env)).not.toMatch(/GITHUB|TOKEN|PATH/);
  });

  it("names a stronger runtime when asked, and refuses a non-hardened isolation", () => {
    const gvisor = agentContainerArgs({ ...base, isolation: { ...isolation, hardened: { ...isolation.hardened!, oci_runtime: "runsc" } } });
    expect(gvisor).toContain("--runtime=runsc");
    expect(() => agentContainerArgs({ ...base, isolation: { ...isolation, hardened: undefined } })).toThrow();
  });
});

describe("forwardedEnv", () => {
  it("passes provider keys only", () => {
    expect(forwardedEnv({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", GITHUB_TOKEN: "g", PATH: "/bin", HOME: "/home/x", SSH_AUTH_SOCK: "/s" })).toEqual({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" });
  });
});

describe("seedHome", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "navarch-seed-"));

  it("copies the agent's login into its home, and copies a refreshed login back", () => {
    const op = dir();
    const task = join(dir(), "home");
    mkdirSync(join(op, ".claude"));
    writeFileSync(join(op, ".claude/.credentials.json"), '{"token":"old"}');
    writeFileSync(join(op, ".claude.json"), "{}");
    writeFileSync(join(op, ".bashrc"), "export SECRET=1");
    const seeded = seedHome("claude-code", op, task);
    expect(readFileSync(join(task, ".claude/.credentials.json"), "utf8")).toBe('{"token":"old"}');
    expect(existsSync(join(task, ".bashrc"))).toBe(false);
    seeded.sync();
    expect(readFileSync(join(op, ".claude/.credentials.json"), "utf8")).toBe('{"token":"old"}');
    writeFileSync(join(task, ".claude/.credentials.json"), '{"token":"new"}');
    const later = new Date(Date.now() + 5_000);
    utimesSync(join(task, ".claude/.credentials.json"), later, later);
    seeded.sync();
    expect(readFileSync(join(op, ".claude/.credentials.json"), "utf8")).toBe('{"token":"new"}');
  });

  it("does not copy back a damaged file, and an adapter without known login files copies nothing", () => {
    const op = dir();
    const task = join(dir(), "home");
    mkdirSync(join(op, ".codex"));
    writeFileSync(join(op, ".codex/auth.json"), '{"ok":true}');
    const seeded = seedHome("codex", op, task);
    writeFileSync(join(task, ".codex/auth.json"), "{ broken");
    const later = new Date(Date.now() + 5_000);
    utimesSync(join(task, ".codex/auth.json"), later, later);
    seeded.sync();
    expect(readFileSync(join(op, ".codex/auth.json"), "utf8")).toBe('{"ok":true}');
    const none = join(dir(), "home");
    seedHome("grok", op, none);
    expect(statSync(none).isDirectory()).toBe(true);
    expect(existsSync(join(none, ".codex"))).toBe(false);
  });
});

describe("agent-entry.mjs", () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) await c().catch(() => {});
  });

  /** Runs the entry script as the container would, with the host's node, and returns its exit code and output. */
  function entry(proxy: EgressProxy, command: string[], port: number): Promise<{ code: number | null; out: string; err: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [ENTRY_PATH, proxy.socketPath, "--", ...command], { env: { ...process.env, NAVARCH_PROXY_PORT: String(port) } });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => resolve({ code, out, err }));
    });
  }

  it("lets the agent reach an allowed host through the proxy on its own loopback, and passes its exit code on", async () => {
    const { createServer } = await import("node:net");
    const upstream = createServer((s) => s.end("from-provider"));
    await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
    closers.push(() => new Promise((ok) => upstream.close(() => ok())));
    const target = (upstream.address() as { port: number }).port;
    const proxy = await startEgressProxy({ allow: ["provider.test"], ports: [target], resolve: async () => ["127.0.0.1"], allowPrivate: true });
    closers.push(() => proxy.close());
    const port = 20000 + Math.floor(Math.random() * 20000);
    const script = `
      const net = require("node:net");
      const s = net.connect(${port}, "127.0.0.1", () => s.write("CONNECT provider.test:${target} HTTP/1.1\\r\\nhost: x\\r\\n\\r\\n"));
      let got = ""; s.on("data", (d) => (got += d)); s.on("close", () => { console.log(got.includes("from-provider") ? "tunnel-ok" : "no-tunnel:" + got); process.exit(7); });`;
    const r = await entry(proxy, [process.execPath, "-e", script], port);
    expect(r.out.trim()).toBe("tunnel-ok");
    expect(r.code).toBe(7);
    expect(proxy.allowed()).toBe(1);
  });

  it("exits 127 when the command does not exist, and 64 without arguments", async () => {
    const proxy = await startEgressProxy({ allow: [] });
    closers.push(() => proxy.close());
    const port = 20000 + Math.floor(Math.random() * 20000);
    const missing = await entry(proxy, ["definitely-not-a-command-xyz"], port);
    expect(missing.code).toBe(127);
    expect(missing.err).toContain("cannot run");
    const bare = await new Promise<number | null>((ok) => spawn(process.execPath, [ENTRY_PATH]).on("close", ok));
    expect(bare).toBe(64);
  });
});
