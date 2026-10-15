import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RemoteStatus } from "@navarch/contracts";

const run = promisify(execFile);

/**
 * Reads the Tailscale setup without changing it (ADR 0020): whether the CLI is there and logged
 * in, the machine's tailnet HTTPS name, and whether `tailscale serve` proxies to the daemon.
 */
export async function tailscaleStatus(port: number, command = "tailscale"): Promise<RemoteStatus> {
  const setup = `tailscale serve --bg ${port}`;
  let status: { BackendState?: string; Self?: { DNSName?: string } };
  try {
    status = JSON.parse((await run(command, ["status", "--json"], { timeout: 5_000 })).stdout);
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT" || (err as { code?: unknown }).code === 127;
    return { mode: "tailscale", installed: !missing, running: false, url: null, serving: false, setup_command: setup };
  }
  const running = status.BackendState === "Running";
  const name = status.Self?.DNSName?.replace(/\.$/, "");
  const url = running && name ? `https://${name}` : null;
  let serving = false;
  if (running) {
    try {
      const serve = (await run(command, ["serve", "status", "--json"], { timeout: 5_000 })).stdout;
      serving = proxiesTo(JSON.parse(serve || "{}"), port);
    } catch {
      serving = false;
    }
  }
  return { mode: "tailscale", installed: true, running, url, serving, setup_command: setup };
}

/** True when some `tailscale serve` HTTPS handler proxies to this port on loopback. */
export function proxiesTo(config: unknown, port: number): boolean {
  const web = (config as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> }).Web ?? {};
  const target = new RegExp(`^(https?://)?(127\\.0\\.0\\.1|localhost):${port}/?$`);
  return Object.values(web).some((site) => Object.values(site.Handlers ?? {}).some((h) => typeof h.Proxy === "string" && target.test(h.Proxy)));
}
