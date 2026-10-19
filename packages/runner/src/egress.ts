import { createServer, type IncomingMessage, type Server } from "node:http";
import { lookup } from "node:dns/promises";
import { connect, isIP, type Socket } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The egress allowlist of the hardened level (spec §6.5.1 L3, ADR 0069). An agent's container has no
 * network interface at all (`--network=none`); its only way out is a unix socket, mounted into it, that
 * leads here. This is an HTTP CONNECT proxy that tunnels TLS to a short list of hosts (the agent's model
 * provider) and refuses everything else. It never sees the traffic, only the host and port requested.
 *
 * Two rules keep the list honest. Only port 443 is tunnelled, and the address a name resolves to must be
 * public: otherwise an allowed name that points at the operator's LAN or `169.254.169.254` would be a way in.
 */

export type EgressOptions = {
  /** Host names that may be reached; `*.example.com` also allows its subdomains (not `example.com` itself). */
  allow: string[];
  /** Tests reach a loopback server; production never sets these. */
  allowPrivate?: boolean;
  ports?: number[];
  /** Resolves a name; tests replace it. */
  resolve?: (host: string) => Promise<string[]>;
};

export type EgressProxy = {
  /** The unix socket to mount into the container. */
  socketPath: string;
  /** Hosts the agent asked for and was refused, with how many times. */
  denied(): Record<string, number>;
  allowed(): number;
  close(): Promise<void>;
};

export function hostAllowed(host: string, allow: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return allow.some((entry) => {
    const a = entry.toLowerCase();
    return a.startsWith("*.") ? h.endsWith(a.slice(1)) && h.length > a.length - 1 : h === a;
  });
}

/** True for loopback, private, link-local, unique-local, CGNAT, multicast and the unspecified address. */
export function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return privateAddress(mapped[1]!);
  return v6 === "::" || v6 === "::1" || v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb") || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("ff");
}

export async function startEgressProxy(opts: EgressOptions): Promise<EgressProxy> {
  const dir = mkdtempSync(join(tmpdir(), "navarch-egress-"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const socketPath = join(dir, "egress.sock");
  const denied: Record<string, number> = {};
  let allowed = 0;
  const open = new Set<Socket>();
  const resolve = opts.resolve ?? (async (host: string) => (await lookup(host, { all: true })).map((a) => a.address));
  const ports = opts.ports ?? [443];
  const deny = (host: string) => {
    const key = host.slice(0, 200);
    if (Object.keys(denied).length < 50 || key in denied) denied[key] = (denied[key] ?? 0) + 1;
  };

  const server: Server = createServer((_req, res) => {
    // Plain HTTP is not tunnelled: model APIs are HTTPS, and a request that is not a CONNECT is not one of them.
    res.writeHead(403, { "content-type": "text/plain" }).end("navarch egress: only HTTPS to allowed hosts\n");
  });
  server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
    open.add(client);
    client.on("close", () => open.delete(client));
    client.on("error", () => {});
    const refuse = (code: number, why: string, host: string) => {
      deny(host || "(none)");
      client.end(`HTTP/1.1 ${code} ${why}\r\nconnection: close\r\n\r\n`);
    };
    const m = /^([^:\s]+|\[[0-9a-fA-F:.]+\]):(\d{1,5})$/.exec(req.url ?? "");
    if (!m) return refuse(400, "Bad Request", "");
    const host = m[1]!.replace(/^\[|\]$/g, "");
    const port = Number(m[2]);
    if (!ports.includes(port) || !hostAllowed(host, opts.allow)) return refuse(403, "Forbidden", `${host}:${port}`);
    void (async () => {
      let addresses: string[];
      try {
        addresses = isIP(host) ? [host] : await resolve(host);
      } catch {
        return refuse(502, "Bad Gateway", host);
      }
      const address = addresses.find((a) => opts.allowPrivate || !privateAddress(a));
      // One private answer among public ones is not trusted either: the name decides nothing, the address does.
      if (!address || (!opts.allowPrivate && addresses.some(privateAddress))) return refuse(403, "Forbidden", `${host} (private address)`);
      const upstream = connect({ host: address, port });
      open.add(upstream);
      upstream.on("close", () => open.delete(upstream));
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
      upstream.once("connect", () => {
        allowed++;
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      client.on("close", () => upstream.destroy());
    })();
  });
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(socketPath, () => ok());
  });
  return {
    socketPath,
    denied: () => ({ ...denied }),
    allowed: () => allowed,
    close: async () => {
      for (const s of open) s.destroy();
      await new Promise<void>((done) => server.close(() => done()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
