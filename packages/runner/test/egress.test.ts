import { request } from "node:http";
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { hostAllowed, privateAddress, startEgressProxy, type EgressProxy } from "../src/egress.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c().catch(() => {});
});

/** A server that answers "hello" to whatever connects, standing in for a provider's API. */
async function target(): Promise<number> {
  const server: Server = createServer((s) => s.end("hello"));
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  closers.push(() => new Promise((ok) => server.close(() => ok())));
  return (server.address() as { port: number }).port;
}

async function proxy(opts: Parameters<typeof startEgressProxy>[0]): Promise<EgressProxy> {
  const p = await startEgressProxy(opts);
  closers.push(() => p.close());
  return p;
}

/** Sends a CONNECT over the proxy's unix socket and returns the status line and what the tunnel carried. */
function connect(p: EgressProxy, authority: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: p.socketPath, method: "CONNECT", path: authority });
    req.on("connect", (res, socket, head) => {
      let body = head.toString();
      socket.on("data", (d) => (body += d));
      socket.on("close", () => resolve({ status: res.statusCode ?? 0, body }));
      socket.on("error", () => resolve({ status: res.statusCode ?? 0, body }));
      if (res.statusCode !== 200) socket.destroy();
      else socket.write("hi");
    });
    req.on("response", (res) => resolve({ status: res.statusCode ?? 0, body: "" }));
    req.on("error", reject);
    req.end();
  });
}

describe("hostAllowed", () => {
  it("matches exact names and subdomains of a wildcard, never the bare domain, and ignores case and a final dot", () => {
    expect(hostAllowed("api.anthropic.com", ["api.anthropic.com"])).toBe(true);
    expect(hostAllowed("API.Anthropic.com.", ["api.anthropic.com"])).toBe(true);
    expect(hostAllowed("evil.api.anthropic.com", ["api.anthropic.com"])).toBe(false);
    expect(hostAllowed("a.example.com", ["*.example.com"])).toBe(true);
    expect(hostAllowed("example.com", ["*.example.com"])).toBe(false);
    expect(hostAllowed("badexample.com", ["*.example.com"])).toBe(false);
    expect(hostAllowed("api.anthropic.com", [])).toBe(false);
  });
});

describe("privateAddress", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fd00::1", "::ffff:10.0.0.1"])("%s is private", (ip) => {
    expect(privateAddress(ip)).toBe(true);
  });
  it.each(["8.8.8.8", "160.79.104.10", "172.32.0.1", "100.128.0.1", "2606:4700::1111"])("%s is public", (ip) => {
    expect(privateAddress(ip)).toBe(false);
  });
});

describe("the egress proxy", () => {
  it("tunnels to an allowed host on the allowed port", async () => {
    const port = await target();
    const p = await proxy({ allow: ["api.example.test"], ports: [port], resolve: async () => ["127.0.0.1"], allowPrivate: true });
    const res = await connect(p, `api.example.test:${port}`);
    expect(res).toEqual({ status: 200, body: "hello" });
    expect(p.allowed()).toBe(1);
    expect(p.denied()).toEqual({});
  });

  it("refuses a host that is not on the list, a port that is not allowed and anything but CONNECT, and counts them", async () => {
    const p = await proxy({ allow: ["api.example.test"], resolve: async () => ["8.8.8.8"] });
    expect((await connect(p, "evil.test:443")).status).toBe(403);
    expect((await connect(p, "api.example.test:22")).status).toBe(403);
    expect((await connect(p, "noport")).status).toBe(400);
    const plain = await new Promise<number>((ok, fail) => {
      const req = request({ socketPath: p.socketPath, method: "GET", path: "http://api.example.test/" }, (res) => ok(res.statusCode ?? 0));
      req.on("error", fail);
      req.end();
    });
    expect(plain).toBe(403);
    expect(p.denied()).toMatchObject({ "evil.test:443": 1, "api.example.test:22": 1 });
    expect(p.allowed()).toBe(0);
  });

  it("refuses an allowed name that resolves to a private address, even next to a public one", async () => {
    const a = await proxy({ allow: ["api.example.test"], resolve: async () => ["169.254.169.254"] });
    expect((await connect(a, "api.example.test:443")).status).toBe(403);
    const b = await proxy({ allow: ["api.example.test"], resolve: async () => ["8.8.8.8", "10.0.0.5"] });
    expect((await connect(b, "api.example.test:443")).status).toBe(403);
  });

  it("answers 502 when the name does not resolve, and an IP literal is checked like a name", async () => {
    const a = await proxy({ allow: ["api.example.test"], resolve: async () => Promise.reject(new Error("ENOTFOUND")) });
    expect((await connect(a, "api.example.test:443")).status).toBe(502);
    expect((await connect(a, "127.0.0.1:443")).status).toBe(403);
    const b = await proxy({ allow: ["127.0.0.1"] });
    expect((await connect(b, "127.0.0.1:443")).status).toBe(403);
  });

  it("removes its socket when closed", async () => {
    const p = await startEgressProxy({ allow: [] });
    const { existsSync } = await import("node:fs");
    expect(existsSync(p.socketPath)).toBe(true);
    await p.close();
    expect(existsSync(p.socketPath)).toBe(false);
  });
});
