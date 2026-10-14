import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isTerminalRun, type RunDetail, type RunView, type VectrEvent } from "@vectr/contracts";
import { vectrHome } from "@vectr/daemon/config";
import { ApiClient, CliError, daemonInfo, EXIT } from "./client.ts";
import { formatEvent, formatRunDetail, formatRunList } from "./format.ts";

const USAGE = `vectr — VECTR command line (Phase 0)

Usage:
  vectr daemon start|stop|status
  vectr run [--repo <path>] [--adapter <id>] [--model <id>] [--budget <usd>] [--allow <cmd>]... [--follow] <prompt...>
  vectr run list
  vectr run show <run-id>
  vectr run resume <run-id> [--follow]   continue a paused run (e.g. after a quota reset)
  vectr logs <run-id> [-f|--follow] [--raw]
  vectr cancel <run-id>

Adapters: claude-code (default), gemini-cli, antigravity, codex, native.
  native needs --model <provider>/<model>, e.g. ollama/qwen2.5:7b or openrouter/<model>:free.

Global options:
  --json      machine-readable output
  -h, --help  show this help

Exit codes: 0 ok · 1 error · 2 usage · 3 daemon not running · 4 run ended failed/cancelled
`;

const home = vectrHome();

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      repo: { type: "string" },
      budget: { type: "string" },
      allow: { type: "string", multiple: true },
      model: { type: "string" },
      adapter: { type: "string", short: "a" },
      follow: { type: "boolean", short: "f", default: false },
      raw: { type: "boolean", default: false },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return values.help ? EXIT.ok : EXIT.usage;
  }
  const json = values.json;

  switch (command) {
    case "daemon":
      return daemonCommand(rest[0], json);
    case "run": {
      if (rest[0] === "list" && rest.length === 1) return runList(json);
      if (rest[0] === "show") return runShow(required(rest[1], "run id"), json);
      if (rest[0] === "resume" && rest.length <= 2) {
        const api = new ApiClient(home);
        const run = await api.request<RunView>("POST", `/api/v1/runs/${required(rest[1], "run id")}/resume`);
        if (json && !values.follow) return print(run, json);
        if (!json) console.log(`run ${run.id} ${run.status}`);
        return values.follow ? follow(api, run.id, json) : EXIT.ok;
      }
      const prompt = rest.join(" ").trim();
      if (!prompt) throw new CliError("missing prompt", EXIT.usage);
      const budget = values.budget !== undefined ? Number(values.budget) : undefined;
      if (budget !== undefined && !(budget > 0)) throw new CliError("--budget must be a positive number", EXIT.usage);
      const api = new ApiClient(home);
      const run = await api.request<RunView>("POST", "/api/v1/runs", {
        repo_path: values.repo ?? process.cwd(),
        prompt,
        ...(budget !== undefined ? { budget } : {}),
        ...(values.allow?.length ? { allow_commands: values.allow } : {}),
        ...(values.model ? { model: values.model } : {}),
        ...(values.adapter ? { adapter: values.adapter } : {}),
      });
      if (json && !values.follow) return print(run, json);
      if (!json) console.log(`run ${run.id} created (${run.status})`);
      return values.follow ? follow(api, run.id, json) : EXIT.ok;
    }
    case "logs": {
      const id = required(rest[0], "run id");
      const api = new ApiClient(home);
      if (values.raw) {
        process.stdout.write(await api.request<string>("GET", `/api/v1/runs/${id}/logs`));
        return EXIT.ok;
      }
      return values.follow ? follow(api, id, json) : printEvents(api, id, json);
    }
    case "cancel": {
      const run = await new ApiClient(home).request<RunView>("POST", `/api/v1/runs/${required(rest[0], "run id")}/cancel`);
      return print(json ? run : `run ${run.id} ${run.status}`, json);
    }
    default:
      throw new CliError(`unknown command: ${command}\n\n${USAGE}`, EXIT.usage);
  }
}

function required(value: string | undefined, what: string): string {
  if (!value) throw new CliError(`missing ${what}`, EXIT.usage);
  return value;
}

function print(value: unknown, json: boolean): number {
  console.log(json || typeof value !== "string" ? JSON.stringify(value, null, 2) : value);
  return EXIT.ok;
}

async function runList(json: boolean): Promise<number> {
  const runs = await new ApiClient(home).request<RunView[]>("GET", "/api/v1/runs");
  return print(json ? runs : formatRunList(runs), json);
}

async function runShow(id: string, json: boolean): Promise<number> {
  const run = await new ApiClient(home).request<RunDetail>("GET", `/api/v1/runs/${id}`);
  return print(json ? run : formatRunDetail(run), json);
}

async function printEvents(api: ApiClient, id: string, json: boolean): Promise<number> {
  const events = await api.request<VectrEvent[]>("GET", `/api/v1/runs/${id}/events`);
  for (const event of events) console.log(json ? JSON.stringify(event) : formatEvent(event));
  return EXIT.ok;
}

/** Prints past events, then streams new ones until the run ends. */
async function follow(api: ApiClient, id: string, json: boolean): Promise<number> {
  let lastSeq = 0;
  let historyLoaded = false;
  const pending: VectrEvent[] = [];
  const show = (event: VectrEvent) => {
    if (event.seq <= lastSeq) return;
    lastSeq = event.seq;
    console.log(json ? JSON.stringify(event) : formatEvent(event));
  };
  const ws = api.stream([`run:${id}`]);
  const ended = new Promise<number>((resolve, reject) => {
    ws.addEventListener("message", async (msg) => {
      const data = JSON.parse(String(msg.data)) as { kind: string; event?: VectrEvent };
      if (data.kind === "subscribed") {
        // Live events that arrive while history loads are buffered, then everything prints in seq order.
        for (const event of await api.request<VectrEvent[]>("GET", `/api/v1/runs/${id}/events`)) show(event);
        historyLoaded = true;
        for (const event of pending.sort((a, b) => a.seq - b.seq)) show(event);
        pending.length = 0;
      } else if (data.kind === "event" && data.event) {
        if (!historyLoaded) {
          pending.push(data.event);
          return;
        }
        show(data.event);
      } else {
        return;
      }
      const run = await api.request<RunView>("GET", `/api/v1/runs/${id}`);
      if (isTerminalRun(run.status) || run.status === "budget_exceeded") {
        ws.close();
        resolve(run.status === "done" ? EXIT.ok : EXIT.runFailed);
      }
    });
    ws.addEventListener("error", () => reject(new CliError("stream connection failed", EXIT.daemonDown)));
    ws.addEventListener("close", () => reject(new CliError("stream closed by vectrd", EXIT.daemonDown)));
  });
  return ended;
}

async function daemonCommand(sub: string | undefined, json: boolean): Promise<number> {
  const info = daemonInfo(home);
  const alive = info ? isAlive(info.pid) : false;
  switch (sub) {
    case "status": {
      if (!info || !alive) {
        print(json ? { running: false } : "vectrd is not running", json);
        return EXIT.daemonDown;
      }
      const health = await new ApiClient(home).request<{ running_tasks: number }>("GET", "/api/v1/health");
      return print(
        json ? { running: true, ...info, ...health } : `vectrd running (pid ${info.pid}, ${info.url}, ${health.running_tasks} task(s) running)`,
        json,
      );
    }
    case "start": {
      if (info && alive) return print(json ? { running: true, ...info } : `vectrd already running (pid ${info.pid})`, json);
      mkdirSync(home, { recursive: true, mode: 0o700 });
      const daemonMain = fileURLToPath(import.meta.resolve("@vectr/daemon/main"));
      const out = openSync(join(home, "vectrd.log"), "a");
      const child = spawn(process.execPath, [daemonMain], { detached: true, stdio: ["ignore", out, out], env: process.env });
      child.unref();
      for (let i = 0; i < 50; i++) {
        await sleep(100);
        const started = daemonInfo(home);
        if (started && started.pid === child.pid) {
          return print(json ? { running: true, ...started } : `vectrd started (pid ${started.pid}, ${started.url})`, json);
        }
      }
      throw new CliError(`vectrd did not start; see ${join(home, "vectrd.log")}`);
    }
    case "stop": {
      if (!info || !alive) return print(json ? { running: false } : "vectrd is not running", json);
      process.kill(info.pid, "SIGTERM");
      for (let i = 0; i < 100 && isAlive(info.pid); i++) await sleep(100);
      if (isAlive(info.pid)) throw new CliError(`vectrd (pid ${info.pid}) did not stop`);
      return print(json ? { running: false } : "vectrd stopped", json);
    }
    default:
      throw new CliError("usage: vectr daemon start|stop|status", EXIT.usage);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof CliError) {
      console.error(`vectr: ${err.message}`);
      process.exit(err.exitCode);
    }
    if (err instanceof TypeError && "code" in err && String(err.code).startsWith("ERR_PARSE_ARGS")) {
      console.error(`vectr: ${err.message}`);
      process.exit(EXIT.usage);
    }
    console.error(err);
    process.exit(EXIT.error);
  },
);
