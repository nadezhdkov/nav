import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isTerminalRun, type ApprovalView, type RunDetail, type RunView, type NavarchEvent } from "@navarch/contracts";
import { homeFiles, navarchHome } from "@navarch/daemon/config";
import { ApiClient, CliError, daemonInfo, EXIT } from "./client.ts";
import { formatApprovals, formatEvent, formatRunDetail, formatRunList } from "./format.ts";

const USAGE = `navarch — Navarch command line

Usage:
  navarch daemon start|stop|status
  navarch run [--repo <path>] [--adapter <id>] [--model <id>] [--budget <usd>] [--allow <cmd>]... [--setup <cmd>]... [--flow <name>] [--follow] <prompt...>
                                         flow \`task\`: implement, then verify and fix until the checks pass
  navarch run --issue <owner/repo#N> [--repo <clone>] [same options] [--follow] [extra instructions...]
                                         flow \`fix-issue\`: triage, plan (approved below level 3), implement,
                                         verify and fix, review, then open a draft PR
  navarch run list
  navarch run show <run-id>
  navarch run resume <run-id> [--follow]   continue a paused run (e.g. after a quota reset)
  navarch logs <run-id> [-f|--follow] [--raw]
  navarch cancel <run-id>
  navarch approvals [--all]                pending approvals (e.g. opening a PR below autonomy level 3)
  navarch approve <approval-id> [--reason <text>]
  navarch reject <approval-id> [--reason <text>]
  navarch secret set <name>                store a secret from stdin, e.g. github/token (a fine-grained PAT)
  navarch secret status <name>

Adapters: claude-code (default), gemini-cli, antigravity, codex, native.
  native needs --model <provider>/<model>, e.g. ollama/qwen2.5:7b or openrouter/<model>:free.

Global options:
  --json      machine-readable output
  -h, --help  show this help

Exit codes: 0 ok · 1 error · 2 usage · 3 daemon not running · 4 run ended failed/cancelled
`;

const home = navarchHome();

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
      setup: { type: "string", multiple: true },
      model: { type: "string" },
      adapter: { type: "string", short: "a" },
      follow: { type: "boolean", short: "f", default: false },
      raw: { type: "boolean", default: false },
      issue: { type: "string" },
      flow: { type: "string" },
      reason: { type: "string" },
      all: { type: "boolean", default: false },
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
      if (!prompt && !values.issue) throw new CliError("missing prompt (or --issue owner/repo#N)", EXIT.usage);
      const budget = values.budget !== undefined ? Number(values.budget) : undefined;
      if (budget !== undefined && !(budget > 0)) throw new CliError("--budget must be a positive number", EXIT.usage);
      const api = new ApiClient(home);
      const run = await api.request<RunView>("POST", "/api/v1/runs", {
        repo_path: values.repo ?? process.cwd(),
        ...(prompt ? { prompt } : {}),
        ...(values.issue ? { issue: values.issue } : {}),
        ...(budget !== undefined ? { budget } : {}),
        ...(values.allow?.length ? { allow_commands: values.allow } : {}),
        ...(values.setup?.length ? { setup_commands: values.setup } : {}),
        ...(values.model ? { model: values.model } : {}),
        ...(values.adapter ? { adapter: values.adapter } : {}),
        ...(values.flow ? { flow: values.flow } : {}),
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
    case "approvals": {
      const path = values.all ? "/api/v1/approvals" : "/api/v1/approvals?status=pending";
      const approvals = await new ApiClient(home).request<ApprovalView[]>("GET", path);
      return print(json ? approvals : formatApprovals(approvals), json);
    }
    case "approve":
    case "reject": {
      const id = required(rest[0], "approval id");
      const decided = await new ApiClient(home).request<ApprovalView>("POST", `/api/v1/approvals/${id}`, {
        decision: command,
        ...(values.reason ? { reason: values.reason } : {}),
      });
      const next = decided.status === "approved" ? `; follow it with: navarch logs ${decided.run_id} -f` : "";
      return print(json ? decided : `${decided.id} ${decided.status} (run ${decided.run_id})${next}`, json);
    }
    case "secret": {
      const name = required(rest[1], "secret name");
      const api = new ApiClient(home);
      const path = `/api/v1/secrets/${encodeURIComponent(name)}`;
      if (rest[0] === "status") {
        const status = await api.request<{ name: string; set: boolean }>("GET", path);
        return print(json ? status : `${status.name}: ${status.set ? "set" : "not set"}`, json);
      }
      if (rest[0] !== "set") throw new CliError("usage: navarch secret set|status <name>", EXIT.usage);
      const value = await readSecret(`value for ${name} (input hidden): `);
      if (!value) throw new CliError("empty value; nothing stored", EXIT.usage);
      await api.request("PUT", path, { value });
      return print(json ? { name, set: true } : `${name} stored in the keychain`, json);
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
  const events = await api.request<NavarchEvent[]>("GET", `/api/v1/runs/${id}/events`);
  for (const event of events) console.log(json ? JSON.stringify(event) : formatEvent(event));
  return EXIT.ok;
}

/** Prints past events, then streams new ones until the run ends. */
async function follow(api: ApiClient, id: string, json: boolean): Promise<number> {
  let lastSeq = 0;
  let historyLoaded = false;
  const pending: NavarchEvent[] = [];
  const show = (event: NavarchEvent) => {
    if (event.seq <= lastSeq) return;
    lastSeq = event.seq;
    console.log(json ? JSON.stringify(event) : formatEvent(event));
  };
  const ws = api.stream([`run:${id}`]);
  const ended = new Promise<number>((resolve, reject) => {
    ws.addEventListener("message", async (msg) => {
      const data = JSON.parse(String(msg.data)) as { kind: string; event?: NavarchEvent };
      if (data.kind === "subscribed") {
        // Live events that arrive while history loads are buffered, then everything prints in seq order.
        for (const event of await api.request<NavarchEvent[]>("GET", `/api/v1/runs/${id}/events`)) show(event);
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
      // A run can wait for a human at any node (plan, editing at level 1, PR): check on connect and on each request.
      if (!isTerminalRun(run.status) && (data.kind === "subscribed" || data.event?.type === "approval.requested")) {
        const pending = (await api.request<ApprovalView[]>("GET", "/api/v1/approvals?status=pending")).find((x) => x.run_id === id);
        if (pending) {
          // Following ends here: the run waits for a human, which may take hours.
          ws.close();
          if (!json) console.log(`\nwaiting for approval: navarch approve ${pending.id}  (or navarch reject ${pending.id})`);
          resolve(EXIT.ok);
          return;
        }
      }
      if (isTerminalRun(run.status) || run.status === "budget_exceeded") {
        ws.close();
        resolve(run.status === "done" ? EXIT.ok : EXIT.runFailed);
      }
    });
    ws.addEventListener("error", () => reject(new CliError("stream connection failed", EXIT.daemonDown)));
    ws.addEventListener("close", () => reject(new CliError("stream closed by navarchd", EXIT.daemonDown)));
  });
  return ended;
}

async function daemonCommand(sub: string | undefined, json: boolean): Promise<number> {
  const info = daemonInfo(home);
  const alive = info ? isAlive(info.pid) : false;
  switch (sub) {
    case "status": {
      if (!info || !alive) {
        print(json ? { running: false } : "navarchd is not running", json);
        return EXIT.daemonDown;
      }
      const health = await new ApiClient(home).request<{ running_tasks: number }>("GET", "/api/v1/health");
      return print(
        json ? { running: true, ...info, ...health } : `navarchd running (pid ${info.pid}, ${info.url}, ${health.running_tasks} task(s) running)`,
        json,
      );
    }
    case "start": {
      if (info && alive) return print(json ? { running: true, ...info } : `navarchd already running (pid ${info.pid})`, json);
      mkdirSync(home, { recursive: true, mode: 0o700 });
      const daemonMain = fileURLToPath(import.meta.resolve("@navarch/daemon/main"));
      const out = openSync(homeFiles(home).daemonLog, "a");
      const child = spawn(process.execPath, [daemonMain], { detached: true, stdio: ["ignore", out, out], env: process.env });
      child.unref();
      for (let i = 0; i < 50; i++) {
        await sleep(100);
        const started = daemonInfo(home);
        if (started && started.pid === child.pid) {
          return print(json ? { running: true, ...started } : `navarchd started (pid ${started.pid}, ${started.url})`, json);
        }
      }
      throw new CliError(`navarchd did not start; see ${homeFiles(home).daemonLog}`);
    }
    case "stop": {
      if (!info || !alive) return print(json ? { running: false } : "navarchd is not running", json);
      process.kill(info.pid, "SIGTERM");
      for (let i = 0; i < 100 && isAlive(info.pid); i++) await sleep(100);
      if (isAlive(info.pid)) throw new CliError(`navarchd (pid ${info.pid}) did not stop`);
      return print(json ? { running: false } : "navarchd stopped", json);
    }
    default:
      throw new CliError("usage: navarch daemon start|stop|status", EXIT.usage);
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

/** Reads a secret from piped stdin, or from the terminal without echoing it. */
async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let data = "";
    for await (const chunk of stdin) data += chunk;
    return data.trim();
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = "";
      stdin.on("data", (chunk: string) => {
        for (const ch of chunk) {
          if (ch === "\r" || ch === "\n") return resolve(value.trim());
          if (ch === "\u0003") return reject(new CliError("cancelled", EXIT.usage));
          if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
          else value += ch;
        }
      });
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    process.stderr.write("\n");
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof CliError) {
      console.error(`navarch: ${err.message}`);
      process.exit(err.exitCode);
    }
    if (err instanceof TypeError && "code" in err && String(err.code).startsWith("ERR_PARSE_ARGS")) {
      console.error(`navarch: ${err.message}`);
      process.exit(EXIT.usage);
    }
    console.error(err);
    process.exit(EXIT.error);
  },
);
