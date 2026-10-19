import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContainerIsolation } from "@navarch/contracts";
import { agentContainerArgs } from "../src/agent-container.ts";
import { startEgressProxy } from "../src/egress.ts";

/**
 * Against the real Docker, opt-in (`NAVARCH_TEST_DOCKER=1`): a hardened agent container of an image that has
 * Node (`NAVARCH_TEST_DOCKER_NODE_IMAGE`, default node:22-bookworm-slim, already pulled). The "agent" is a
 * script that probes what it can reach, so it needs no agent CLI and no account.
 */
describe.skipIf(!process.env.NAVARCH_TEST_DOCKER)("a hardened agent container on the real Docker", () => {
  const runtime = process.env.NAVARCH_TEST_DOCKER_RUNTIME ?? "/usr/bin/docker";
  const image = process.env.NAVARCH_TEST_DOCKER_NODE_IMAGE ?? "node:22-bookworm-slim";
  const isolation: ContainerIsolation = { kind: "container", image, network: "none", memory: "1g", cpus: 1, pids_limit: 256, hardened: { agent_image: image, egress_allow: [] } };

  it("has no network, a read-only root, a read-only worktree for a read-only profile and no secrets, and reaches only the allowed host through the proxy", { timeout: 120_000 }, async () => {
    // A "provider" on the host's loopback: reachable only through the proxy, since the container has no interface.
    const provider = createServer((s) => s.end("from-provider"));
    await new Promise<void>((ok) => provider.listen(0, "127.0.0.1", ok));
    const port = (provider.address() as { port: number }).port;
    const proxy = await startEgressProxy({ allow: ["provider.test"], ports: [port], resolve: async () => ["127.0.0.1"], allowPrivate: true });
    const root = mkdtempSync(join(tmpdir(), "navarch-hardened-"));
    chmodSync(root, 0o755);
    const worktree = join(root, "wt");
    const home = join(root, "home");
    for (const d of [worktree, home]) mkdirSync(d, { mode: 0o777 });
    chmodSync(worktree, 0o777);
    chmodSync(home, 0o777);
    process.env.NAVARCH_TEST_LEAK = "secret-value";
    const script = `
      const fs = require("node:fs"), net = require("node:net"), os = require("node:os");
      const out = {};
      out.interfaces = Object.keys(os.networkInterfaces()).filter((n) => n !== "lo");
      out.leak = process.env.NAVARCH_TEST_LEAK || null;
      out.uid = process.getuid();
      try { fs.writeFileSync("/etc/navarch", "x"); out.root = "writable"; } catch { out.root = "read-only"; }
      try { fs.writeFileSync("${worktree}/x.txt", "x"); out.worktree = "writable"; } catch { out.worktree = "read-only"; }
      try { fs.writeFileSync(process.env.HOME + "/ok.txt", "x"); out.home = "writable"; } catch { out.home = "read-only"; }
      const direct = net.connect({ host: "1.1.1.1", port: 443, timeout: 2000 });
      let moved = false;
      const next = () => { if (!moved) { moved = true; step(); } };
      direct.on("error", (e) => { out.direct = e.code; next(); });
      direct.on("timeout", () => { out.direct = "timeout"; direct.destroy(); next(); });
      function step() {
        const s = net.connect(3128, "127.0.0.1", () => s.write("CONNECT provider.test:${port} HTTP/1.1\\r\\n\\r\\n"));
        let got = ""; s.on("data", (d) => (got += d));
        s.on("close", () => { out.allowed = got.includes("from-provider"); const t = net.connect(3128, "127.0.0.1", () => t.write("CONNECT evil.test:443 HTTP/1.1\\r\\n\\r\\n")); let r = ""; t.on("data", (d) => (r += d)); t.on("close", () => { out.denied = r.split("\\r\\n")[0]; console.log(JSON.stringify(out)); }); });
      }`;
    const args = agentContainerArgs({
      runtime, isolation, name: `navarch-test-hardened-${process.pid}`, worktree, readOnly: true,
      user: { uid: process.getuid!(), gid: process.getgid!() }, home,
      socketDir: dirname(proxy.socketPath), socketName: basename(proxy.socketPath),
      command: "node", args: ["-e", script], env: {},
    });
    // Async on purpose: the proxy runs in this process, and a blocked event loop could not answer the container.
    const run = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(runtime, args, { timeout: 100_000 });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    delete process.env.NAVARCH_TEST_LEAK;
    await proxy.close();
    provider.close();
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout.trim().split("\n").at(-1)!);
    expect(out).toMatchObject({ interfaces: [], leak: null, root: "read-only", worktree: "read-only", home: "writable", allowed: true });
    expect(out.uid).toBe(process.getuid!());
    expect(["ENETUNREACH", "EAI_AGAIN", "EHOSTUNREACH", "ECONNREFUSED", "timeout"]).toContain(out.direct);
    expect(out.denied).toContain("403");
    expect(existsSync(join(worktree, "x.txt"))).toBe(false);
  });
});
