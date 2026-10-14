import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export const EXIT = { ok: 0, error: 1, usage: 2, daemonDown: 3, runFailed: 4 } as const;

export type DaemonInfo = { pid: number; url: string };

export function daemonInfo(home: string): DaemonInfo | undefined {
  const file = join(home, "vectrd.json");
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as DaemonInfo;
  } catch {
    return undefined;
  }
}

/** HTTP client for the Core API; the CLI holds no business logic (spec P2). */
export class ApiClient {
  readonly url: string;
  private readonly token: string;

  constructor(home: string) {
    const info = daemonInfo(home);
    if (!info) throw new CliError("vectrd is not running (start it with `vectr daemon start`)", EXIT.daemonDown);
    const tokenFile = join(home, "token");
    if (!existsSync(tokenFile)) throw new CliError(`missing ${tokenFile}`, EXIT.daemonDown);
    this.url = info.url;
    this.token = readFileSync(tokenFile, "utf8").trim();
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url + path, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          "x-vectr-client": "cli",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new CliError(`cannot reach vectrd at ${this.url}`, EXIT.daemonDown);
    }
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { message: string }).message;
      } catch {
        // plain-text error body
      }
      throw new CliError(`${res.status}: ${message}`);
    }
    const type = res.headers.get("content-type") ?? "";
    return (type.includes("application/json") ? JSON.parse(text) : text) as T;
  }

  stream(topics: string[]): WebSocket {
    const ws = new WebSocket(`${this.url.replace(/^http/, "ws")}/api/v1/stream?token=${encodeURIComponent(this.token)}`);
    ws.addEventListener("open", () => ws.send(JSON.stringify({ subscribe: topics })));
    return ws;
  }
}
