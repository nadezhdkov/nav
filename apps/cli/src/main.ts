import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync } from "node:fs";
import { basename, join, resolve as resolvePath } from "node:path";
import { checkoutRoot, installProblem, readTail, startFailureHint } from "./deps.ts";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  isTerminalRun,
  type ApprovalView,
  type GitHubRepoView,
  type ConciergeTurn,
  type DeviceView,
  type RemoteStatus,
  type RunDetail,
  type RunMessage,
  type RunView,
  type NavarchEvent,
  type StopResult,
  type InboxItemDetail,
  type InboxView,
  type CodeSymbol,
  type ProjectView,
  type RepoMap,
  type TraceabilityView,
  type SearchHit,
  type AddProjectResult,
  type StartInboxResult,
  type SyncInboxResult,
  type AwayView,
  type CiFailureView,
  type MorningSummary,
  SetAwayRequest,
  type BudgetView,
  type SetBudgetRequest,
  type UsageView,
  type MetricsView,
  type SpecRunView,
  type PrinciplesView,
  type PrincipleView,
  type FlowDetail,
  type FlowSummary,
  type ValidateFlowResponse,
} from "@navarch/contracts";
import { homeFiles, navarchHome } from "@navarch/daemon/config";
import { serveStdio } from "@navarch/mcp-server";
import { wantsColor } from "./banner.ts";
import { chat } from "./chat.ts";
import { ApiClient, CliError, daemonInfo, EXIT } from "./client.ts";
import { printSafeLine, stripControls } from "./safe.ts";
import { formatApprovals, formatAway, formatBudgets, formatCiFailures, formatSummary, formatDevices, formatEvent, formatHits, formatRepoMap, formatSymbols, formatTraceability, formatFlows, formatGitHubRepos, formatInbox, formatProblems, formatPrinciples, formatProjects, formatRemote, formatRunDetail, formatRunList, formatSpecs, formatSync, formatUsage, formatMetrics } from "./format.ts";
import { openInBrowser, webUrl } from "./web.ts";

const USAGE = `navarch — Navarch command line

Usage:
  navarch                                  talk to the concierge (same as \`navarch chat\`, in a terminal)
  navarch chat                             ask in plain language; actions are proposed and need your yes
  navarch ask <question...>                one question to the concierge; proposals are shown, not run
  navarch web [--print]                    open the Web UI (runs, live graph, approvals) in the browser
  navarch daemon start|stop|status
  navarch run [--repo <path>] [--adapter <id>] [--model <id>] [--budget <usd>] [--allow <cmd>]... [--setup <cmd>]... [--attach <file>]... [--flow <name>] [--param <name=value>]... [--follow] <prompt...>
                                         flow \`task\`: implement, then verify and fix until the checks pass;
                                         \`--flow compete --budget <usd>\`: several agents compete, a judge picks
  navarch run --issue <owner/repo#N> [--repo <clone>] [same options] [--follow] [extra instructions...]
                                         flow \`fix-issue\`: triage, plan (approved below level 3), implement,
                                         verify and fix, review, then open a draft PR
  navarch run --pr <owner/repo#N> [--flow review-pr|ci-fix] [--repo <clone>] [same options] [--follow] [extra instructions...]
                                         flow \`review-pr\`: review the pull request and post it as comments;
                                         \`--flow ci-fix\`: fix its failing checks in a draft PR to its branch,
                                         or comment the diagnosis of a flaky or CI failure
  navarch run list
  navarch run show <run-id>
  navarch run resume <run-id> [--follow]   continue a paused run, or retry the failed task of a failed run
  navarch logs <run-id> [-f|--follow] [--raw]
  navarch cancel <run-id>
  navarch pause <run-id>                   pause a run: running agents stop and nothing starts until resumed
  navarch stop --all                       kill switch: pause every active run (nothing is cancelled)
  navarch say <run-id> [--task <task-id>] [--now] <text...>
                                         tell a run's agents something: in the next agent turn, or --now
                                         interrupt that running task and resume it with your message
  navarch approvals [--all]                pending approvals (e.g. opening a PR below autonomy level 3)
  navarch approve <approval-id> [--pick <choice>] [--reason <text>]
                                         --pick: another of the offered choices (e.g. a competitor)
  navarch reject <approval-id> [--reason <text>]
  navarch secret set <name>                store a secret from stdin, e.g. github/token (a fine-grained PAT)
  navarch secret status <name>
  navarch remote status                    Tailscale and the phone's URL (\`tailscale serve\` must proxy to the daemon)
  navarch devices                          paired phones (pair one from the Web UI: Settings → Devices)
  navarch devices revoke <device-id>       sign a phone out
  navarch project add <clone> [--github <owner/name>] [--name <name>]
                                         watch a repository's issues in the Inbox (origin read from the clone)
  navarch project clone <owner/name>       clone a GitHub repository the token reaches into the Navarch home and add it
  navarch project list | remove <project-id>
  navarch repos [--refresh]                GitHub repositories the token reaches (own, collaborator, organizations)
  navarch principles [add <rule> [--run <run>] | remove <id> | accept <proposal> | dismiss <proposal>] [--project <project-id>]
                                         rules for the project; agents may propose some, you accept or dismiss them
  navarch map | symbols <name> | where <text> [--project <project-id>]
  navarch trace [--project <project-id>]   traceability of the specs: code ↔ spec, spec ↔ test, files no claim covers
  navarch mcp [--project <project-id>]    (Navarch as an MCP server on stdio, read-only tools for one project)
                                         explore the project of the current directory: languages and entry points,
                                         where a symbol is defined, where a text appears
  navarch sync [--project <project-id>]    read new and changed issues now (also polled every 15 min)
  navarch inbox [--all] [--project <project-id>]
                                         triaged issues: kind, complexity, area, duplicate, action, estimate
  navarch inbox start <item-id>... [--flow <name>] [--budget <usd>]
                                         start one issue run per item in its project's clone
  navarch inbox dismiss <item-id> [--reason <text>] | restore <item-id>
  navarch ci [--all]                       CI failures noticed on open pull requests (polled with the Inbox)
  navarch ci fix <failure-id> [--budget <usd>]
                                         start a ci-fix run on the pull request
  navarch ci dismiss <failure-id>
  navarch away [status]                    Away mode: whether an approver agent decides approvals for you, and what it did
  navarch away on [--for <4h|90m|none>] [--delegate plan,pr,start] [--max-complexity <1-5|none>] [--max-revisions <0-3>] [--yes]
  navarch away off
  navarch budget [show]                    billed use against the run, project-day and monthly limits
  navarch budget set --monthly <usd|none> | --project <id> --daily <usd|none> | --run <id> <usd>
                                         change a limit; raising one releases tasks waiting on it
  navarch usage [--days <n>] [--profile <name>]
                                         spend today and this month, tokens, success and cost per model
  navarch summary [--now]                  the morning summary: new issues, CI failures, stalled PRs, suggested runs (--now syncs and makes one)
  navarch specs                            specs written by reverse-spec runs and their share of confirmed (🟢) claims
  navarch metrics [--days <n>]             cost by day, project, profile and model; success rates, accepted PRs, rework
  navarch flow list                        built-in Flows and the Flows published in Flow Studio (Web UI → Flows)
  navarch flow show <name> [--version <n>] [--draft]
                                         print a Flow's YAML: the latest published version by default
  navarch flow validate <file>             check a Flow YAML file against this daemon (profiles, adapters, Flows)

Adapters: claude-code, gemini-cli, antigravity, codex, copilot, opencode, kilo, grok, native.
  Without --adapter or --model the Model Router picks one per agent task (routing in config.yaml);
  either option pins the whole run. native needs --model <provider>/<model>, e.g. ollama/qwen2.5:7b or openrouter/<model>:free.

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
      attach: { type: "string", multiple: true },
      param: { type: "string", multiple: true },
      pick: { type: "string" },
      model: { type: "string" },
      adapter: { type: "string", short: "a" },
      follow: { type: "boolean", short: "f", default: false },
      raw: { type: "boolean", default: false },
      issue: { type: "string" },
      pr: { type: "string" },
      flow: { type: "string" },
      reason: { type: "string" },
      all: { type: "boolean", default: false },
      refresh: { type: "boolean", default: false },
      print: { type: "boolean", default: false },
      task: { type: "string" },
      now: { type: "boolean", default: false },
      github: { type: "string" },
      name: { type: "string" },
      project: { type: "string" },
      monthly: { type: "string" },
      daily: { type: "string" },
      run: { type: "string" },
      days: { type: "string" },
      version: { type: "string" },
      draft: { type: "boolean", default: false },
      profile: { type: "string" },
      for: { type: "string" },
      delegate: { type: "string" },
      "max-complexity": { type: "string" },
      "max-revisions": { type: "string" },
      yes: { type: "boolean", default: false },
    },
  });
  const [command, ...rest] = positionals;
  if (!command && !values.help && process.stdin.isTTY && process.stdout.isTTY) {
    return chat(new ApiClient(home), chatIo());
  }
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return values.help ? EXIT.ok : EXIT.usage;
  }
  const json = values.json;

  switch (command) {
    case "chat":
      return chat(new ApiClient(home), chatIo());
    case "ask": {
      const text = rest.join(" ").trim();
      if (!text) throw new CliError("missing question", EXIT.usage);
      const api = new ApiClient(home);
      const { id } = await api.request<{ id: string }>("POST", "/api/v1/concierge/conversations", { cwd: process.cwd() });
      const turn = await api.request<ConciergeTurn>("POST", `/api/v1/concierge/conversations/${id}/messages`, { text });
      if (json) return print(turn, json);
      console.log(stripControls(turn.reply));
      for (const p of turn.proposals) console.log(`\nProposed (not run): ${p.summary}\nUse \`navarch chat\` to confirm actions.`);
      return EXIT.ok;
    }
    case "web": {
      const url = await webUrl(new ApiClient(home));
      if (json) return print({ url }, json);
      if (!values.print && (await openInBrowser(url))) {
        console.log("Opened the Web UI in your browser (the sign-in link works once, for 60 s).");
        return EXIT.ok;
      }
      console.log(`Open within 60 s (works once): ${url}`);
      return EXIT.ok;
    }
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
      if (!prompt && !values.issue && !values.pr) throw new CliError("missing prompt (or --issue owner/repo#N, or --pr owner/repo#N)", EXIT.usage);
      if (values.issue && values.pr) throw new CliError("give --issue or --pr, not both", EXIT.usage);
      const budget = values.budget !== undefined ? Number(values.budget) : undefined;
      if (budget !== undefined && !(budget > 0)) throw new CliError("--budget must be a positive number", EXIT.usage);
      const api = new ApiClient(home);
      const run = await api.request<RunView>("POST", "/api/v1/runs", {
        repo_path: values.repo ?? process.cwd(),
        ...(prompt ? { prompt } : {}),
        ...(values.issue ? { issue: values.issue } : {}),
        ...(values.pr ? { pull_request: values.pr } : {}),
        ...(budget !== undefined ? { budget } : {}),
        ...(values.allow?.length ? { allow_commands: values.allow } : {}),
        ...(values.setup?.length ? { setup_commands: values.setup } : {}),
        ...(values.model ? { model: values.model } : {}),
        ...(values.adapter ? { adapter: values.adapter } : {}),
        ...(values.flow ? { flow: values.flow } : {}),
        ...(values.attach?.length ? { attachments: values.attach.map(readAttachment) } : {}),
        ...(values.param?.length ? { params: Object.fromEntries(values.param.map(readParam)) } : {}),
      });
      if (json && !values.follow) return print(run, json);
      if (!json) console.log(`run ${run.name} (${run.id}) created (${run.status})`);
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
    case "pause": {
      const run = await new ApiClient(home).request<RunView>("POST", `/api/v1/runs/${required(rest[0], "run id")}/pause`);
      return print(json ? run : `run ${run.id} paused; continue with: navarch run resume ${run.id}`, json);
    }
    case "stop": {
      if (!values.all) throw new CliError("usage: navarch stop --all (pauses every active run)", EXIT.usage);
      const result = await new ApiClient(home).request<StopResult>("POST", "/api/v1/stop");
      const text = result.paused.length
        ? `paused ${result.paused.length} run(s): ${result.paused.join(", ")}\nresume each with: navarch run resume <run-id>`
        : "no active run to pause";
      return print(json ? result : text, json);
    }
    case "remote": {
      if (rest[0] !== "status") throw new CliError("usage: navarch remote status", EXIT.usage);
      const status = await new ApiClient(home).request<RemoteStatus>("GET", "/api/v1/remote");
      return print(json ? status : formatRemote(status), json);
    }
    case "devices": {
      const api = new ApiClient(home);
      if (rest[0] === "revoke") {
        const device = await api.request<DeviceView>("DELETE", `/api/v1/devices/${encodeURIComponent(required(rest[1], "device id"))}`);
        return print(json ? device : `${device.name} (${device.id}) revoked`, json);
      }
      if (rest[0] !== undefined) throw new CliError("usage: navarch devices [revoke <device-id>]", EXIT.usage);
      const devices = await api.request<DeviceView[]>("GET", "/api/v1/devices");
      return print(json ? devices : formatDevices(devices), json);
    }
    case "project": {
      const api = new ApiClient(home);
      if (rest[0] === "add") {
        const project = await api.request<AddProjectResult>("POST", "/api/v1/projects", {
          path: resolvePath(required(rest[1], "path of a clone")),
          ...(values.github ? { github: values.github } : {}),
          ...(values.name ? { name: values.name } : {}),
        });
        if (!json) for (const w of project.warnings ?? []) console.error(`warning: ${w}`);
        return print(json ? project : `project ${project.id}: ${project.repo} (${project.path}); sync now with: navarch sync`, json);
      }
      if (rest[0] === "clone") {
        const project = await api.request<AddProjectResult>("POST", "/api/v1/github/repos/clone", { repo: required(rest[1], "owner/name") });
        if (!json) for (const w of project.warnings ?? []) console.error(`warning: ${w}`);
        return print(json ? project : `project ${project.id}: ${project.repo} (${project.path}); start a run with: navarch run --repo ${project.path} <prompt>`, json);
      }
      if (rest[0] === "remove") {
        const id = required(rest[1], "project id");
        await api.request("DELETE", `/api/v1/projects/${encodeURIComponent(id)}`);
        return print(json ? { id, removed: true } : `project ${id} removed; its runs stay`, json);
      }
      if (rest[0] !== "list" && rest[0] !== undefined) throw new CliError("usage: navarch project add|clone|list|remove", EXIT.usage);
      const projects = await api.request<ProjectView[]>("GET", "/api/v1/projects");
      return print(json ? projects : formatProjects(projects), json);
    }
    case "repos": {
      const api = new ApiClient(home);
      const repos = await api.request<GitHubRepoView[]>("GET", `/api/v1/github/repos${values.refresh ? "?refresh=1" : ""}`);
      return print(json ? repos : formatGitHubRepos(repos), json);
    }
    case "away": {
      const api = new ApiClient(home);
      if (rest[0] === "off") {
        const view = await api.request<AwayView>("PUT", "/api/v1/away", { enabled: false });
        return print(json ? view : formatAway(view), json);
      }
      if (rest[0] === "on") {
        const body = awayRequest(values);
        if (!values.yes) {
          process.stderr.write(`${AWAY_WARNING}\n`);
          if (!process.stdin.isTTY) throw new CliError("Away mode needs your explicit yes: rerun with --yes after reading the warning above", EXIT.usage);
          if (!(await confirm("Turn Away mode on? [y/N] "))) return EXIT.error;
        }
        const view = await api.request<AwayView>("PUT", "/api/v1/away", body);
        return print(json ? view : formatAway(view), json);
      }
      if (rest[0] !== "status" && rest[0] !== undefined) throw new CliError("usage: navarch away [status] | on [...] | off", EXIT.usage);
      const view = await api.request<AwayView>("GET", "/api/v1/away");
      return print(json ? view : formatAway(view), json);
    }
    case "budget": {
      const api = new ApiClient(home);
      if (rest[0] === "set") {
        const body = budgetRequest(values, rest.slice(1));
        const budgets = await api.request<BudgetView[]>("PUT", "/api/v1/budgets", body);
        return print(json ? budgets : formatBudgets(budgets), json);
      }
      if (rest[0] !== "show" && rest[0] !== undefined) throw new CliError("usage: navarch budget [show] | set ...", EXIT.usage);
      const budgets = await api.request<BudgetView[]>("GET", "/api/v1/budgets");
      return print(json ? budgets : formatBudgets(budgets), json);
    }
    case "flow": {
      const api = new ApiClient(home);
      if (rest[0] === "list" || rest[0] === undefined) {
        const flows = await api.request<FlowSummary[]>("GET", "/api/v1/flows");
        return print(json ? flows : formatFlows(flows), json);
      }
      if (rest[0] === "show") {
        const name = required(rest[1], "flow name");
        if (values.version !== undefined) {
          const v = await api.request<{ yaml: string }>("GET", `/api/v1/flows/${encodeURIComponent(name)}/versions/${encodeURIComponent(values.version)}`);
          return print(json ? v : v.yaml.trimEnd(), json);
        }
        const flow = await api.request<FlowDetail>("GET", `/api/v1/flows/${encodeURIComponent(name)}`);
        const yaml = values.draft ? flow.draft_yaml : (flow.published_yaml ?? flow.draft_yaml);
        if (yaml === null) throw new CliError(values.draft ? `flow ${name} has no draft` : `flow ${name} has nothing published`, EXIT.error);
        return print(json ? flow : yaml.trimEnd(), json);
      }
      if (rest[0] === "validate") {
        const file = required(rest[1], "file");
        const result = await api.request<ValidateFlowResponse>("POST", "/api/v1/flows/validate", { yaml: readFileSync(resolvePath(file), "utf8") });
        print(json ? result : formatProblems(file, result.problems), json);
        return result.problems.some((p) => p.severity === "error") ? EXIT.error : EXIT.ok;
      }
      throw new CliError("usage: navarch flow list | show <name> [--version <n>] [--draft] | validate <file>", EXIT.usage);
    }
    case "usage": {
      const query = new URLSearchParams({ ...(values.days ? { days: values.days } : {}), ...(values.profile ? { profile: values.profile } : {}) }).toString();
      const usage = await new ApiClient(home).request<UsageView>("GET", `/api/v1/usage${query ? `?${query}` : ""}`);
      return print(json ? usage : formatUsage(usage), json);
    }
    case "metrics": {
      const metrics = await new ApiClient(home).request<MetricsView>("GET", `/api/v1/metrics${values.days ? `?days=${encodeURIComponent(values.days)}` : ""}`);
      return print(json ? metrics : formatMetrics(metrics), json);
    }
    case "principles": {
      const api = new ApiClient(home);
      const project = await exploredProject(api, values.project);
      const base = `/api/v1/projects/${encodeURIComponent(project)}/principles`;
      if (rest[0] === "add") {
        const text = required(rest.slice(1).join(" ") || undefined, "the rule, in one line");
        const added = await api.request<PrincipleView>("POST", base, { text, ...(values.run ? { run_id: values.run } : {}) });
        return print(json ? added : `added ${added.id}: ${added.text}`, json);
      }
      if (rest[0] === "remove") {
        await api.request("DELETE", `${base}/${encodeURIComponent(required(rest[1], "a rule id (see `navarch principles`)"))}`);
        return print(json ? { removed: rest[1] } : `removed ${rest[1]}`, json);
      }
      if (rest[0] === "accept" || rest[0] === "dismiss") {
        const id = required(rest[1], "a proposal id (see `navarch principles`)");
        const res = await api.request<PrincipleView | undefined>("POST", `${base}/proposals/${encodeURIComponent(id)}/${rest[0]}`);
        return print(json ? (res ?? { dismissed: id }) : res ? `accepted as ${res.id}: ${res.text}` : `dismissed ${id}`, json);
      }
      if (rest.length) throw new CliError("usage: navarch principles [--project <id>] [add <rule> [--run <id>] | remove <id> | accept <proposal> | dismiss <proposal>]", EXIT.usage);
      const view = await api.request<PrinciplesView>("GET", base);
      return print(json ? view : formatPrinciples(view), json);
    }
    case "specs": {
      const specs = await new ApiClient(home).request<SpecRunView[]>("GET", "/api/v1/specs");
      return print(json ? specs : formatSpecs(specs), json);
    }
    case "map":
    case "symbols":
    case "where": {
      const api = new ApiClient(home);
      const project = await exploredProject(api, values.project);
      const base = `/api/v1/projects/${encodeURIComponent(project)}`;
      if (command === "map") {
        const map = await api.request<RepoMap>("GET", `${base}/map`);
        return print(json ? map : formatRepoMap(map), json);
      }
      const query = required(rest.join(" ") || undefined, command === "symbols" ? "a symbol name" : "a text to search");
      if (command === "symbols") {
        const symbols = await api.request<CodeSymbol[]>("GET", `${base}/symbols?q=${encodeURIComponent(query)}`);
        return print(json ? symbols : formatSymbols(symbols), json);
      }
      const hits = await api.request<SearchHit[]>("GET", `${base}/search?q=${encodeURIComponent(query)}`);
      return print(json ? hits : formatHits(hits), json);
    }
    case "trace": {
      const api = new ApiClient(home);
      const project = await exploredProject(api, values.project);
      const view = await api.request<TraceabilityView>("GET", `/api/v1/projects/${encodeURIComponent(project)}/traceability`);
      return print(json ? view : formatTraceability(view), json);
    }
    case "mcp": {
      // Navarch as an MCP server on stdio for one project (ADR 0046); stdout carries only protocol messages.
      const api = new ApiClient(home);
      const base = `/api/v1/projects/${encodeURIComponent(await exploredProject(api, values.project))}`;
      await serveStdio({ get: (path) => api.request("GET", base + path) }, process.stdin, (line) => process.stdout.write(`${line}\n`));
      return EXIT.ok;
    }
    case "sync": {
      const result = await new ApiClient(home).request<SyncInboxResult>("POST", "/api/v1/inbox/sync", values.project ? { project_id: values.project } : {});
      print(json ? result : formatSync(result.results), json);
      return result.results.some((r) => r.error) ? EXIT.error : EXIT.ok;
    }
    case "inbox": {
      const api = new ApiClient(home);
      if (rest[0] === "start") {
        const ids = rest.slice(1);
        if (!ids.length) throw new CliError("usage: navarch inbox start <item-id>...", EXIT.usage);
        const budget = values.budget === undefined ? undefined : Number(values.budget);
        const result = await api.request<StartInboxResult>("POST", "/api/v1/inbox/start", {
          item_ids: ids,
          ...(values.flow ? { flow: values.flow } : {}),
          ...(budget ? { budget } : {}),
        });
        const text = [
          ...result.runs.map((r) => `${r.item_id}: run ${r.run_id} started; follow it with: navarch logs ${r.run_id} -f`),
          ...result.errors.map((e) => `${e.item_id}: not started: ${e.message}`),
        ].join("\n");
        print(json ? result : text, json);
        return result.errors.length ? EXIT.error : EXIT.ok;
      }
      if (rest[0] === "dismiss" || rest[0] === "restore") {
        const id = required(rest[1], "item id");
        const body = rest[0] === "dismiss" && values.reason ? { reason: values.reason } : {};
        const item = await api.request<InboxItemDetail>("POST", `/api/v1/inbox/${encodeURIComponent(id)}/${rest[0]}`, body);
        return print(json ? item : `${item.id} ${item.status}`, json);
      }
      if (rest[0] !== undefined) throw new CliError("usage: navarch inbox [start|dismiss|restore]", EXIT.usage);
      const query = new URLSearchParams();
      if (!values.all) query.set("status", "new,triaged");
      if (values.project) query.set("project", values.project);
      const view = await api.request<InboxView>("GET", `/api/v1/inbox${query.size ? `?${query}` : ""}`);
      return print(json ? view : formatInbox(view), json);
    }
    case "summary": {
      const api = new ApiClient(home);
      const summary = values.now ? await api.request<MorningSummary>("POST", "/api/v1/summary", {}) : await api.request<MorningSummary | null>("GET", "/api/v1/summary");
      return print(json ? summary : formatSummary(summary), json);
    }
    case "ci": {
      const api = new ApiClient(home);
      if (rest[0] === "fix") {
        const id = required(rest[1], "failure id");
        const budget = values.budget === undefined ? undefined : Number(values.budget);
        const result = await api.request<{ failure: CiFailureView; run: RunView }>("POST", `/api/v1/ci/failures/${encodeURIComponent(id)}/fix`, budget ? { budget } : {});
        return print(json ? result : `${result.failure.repo}#${result.failure.number}: run ${result.run.name} (${result.run.id}) started; follow it with: navarch logs ${result.run.id} -f`, json);
      }
      if (rest[0] === "dismiss") {
        const id = required(rest[1], "failure id");
        const failure = await api.request<CiFailureView>("POST", `/api/v1/ci/failures/${encodeURIComponent(id)}/dismiss`, {});
        return print(json ? failure : `${failure.id} ${failure.status}`, json);
      }
      if (rest[0] !== undefined) throw new CliError("usage: navarch ci [fix|dismiss] <failure-id>", EXIT.usage);
      const failures = await api.request<CiFailureView[]>("GET", `/api/v1/ci/failures${values.all ? "?status=" : ""}`);
      return print(json ? failures : formatCiFailures(failures), json);
    }
    case "say": {
      const id = required(rest[0], "run id");
      const text = rest.slice(1).join(" ").trim();
      if (!text) throw new CliError("missing the instruction text", EXIT.usage);
      if (values.now && !values.task) throw new CliError("--now needs --task <task-id>: the running task to interrupt", EXIT.usage);
      const message = await new ApiClient(home).request<RunMessage>("POST", `/api/v1/runs/${id}/messages`, {
        text,
        delivery: values.now ? "now" : "next",
        ...(values.task ? { task_id: values.task } : {}),
      });
      const when = values.now ? "now: the agent stops and resumes with it" : "in the next agent turn";
      return print(json ? message : `${message.id} sent to ${values.task ?? `run ${id}`}, delivered ${when}`, json);
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
        ...(values.pick ? { choice: values.pick } : {}),
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

const AWAY_WARNING = `Away mode: an approver agent (an AI model) will approve for you what you hand over.
  - It reads each plan, and the finished change before a draft PR, and approves, sends the plan back, or leaves it to you.
  - It can be wrong. Plans it approves become code, and its draft PRs wait for your review.
  - It never merges, never raises a budget and never decides anything you did not hand over.
  - Every decision is recorded; \`navarch away\` lists them.`;

/** `navarch away on`: durations such as 4h, 90m or "none" (no time limit). */
function awayRequest(values: { for?: string; delegate?: string; "max-complexity"?: string; "max-revisions"?: string }): SetAwayRequest {
  const span = values.for ?? "4h";
  let minutes: number | null;
  if (span === "none") minutes = null;
  else {
    const m = /^(\d+)(m|h|d)$/.exec(span);
    if (!m) throw new CliError("--for takes a duration such as 90m, 4h or 2d, or none", EXIT.usage);
    minutes = Number(m[1]) * { m: 1, h: 60, d: 1440 }[m[2] as "m" | "h" | "d"];
  }
  const delegate = (values.delegate ?? "plan,pr").split(",").map((d) => d.trim()).filter(Boolean);
  for (const d of delegate) if (!["plan", "pr", "start"].includes(d)) throw new CliError(`--delegate takes plan, pr or start, not "${d}"`, EXIT.usage);
  const complexity = values["max-complexity"];
  const revisions = values["max-revisions"];
  return SetAwayRequest.parse({
    enabled: true,
    confirm: true,
    delegate,
    minutes,
    ...(complexity !== undefined ? { max_complexity: complexity === "none" ? null : Number(complexity) } : {}),
    ...(revisions !== undefined ? { max_revisions: Number(revisions) } : {}),
  });
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

/** `navarch budget set`: exactly one of --monthly, --project with --daily, or --run with an amount. */
function budgetRequest(values: { monthly?: string; project?: string; daily?: string; run?: string }, rest: string[]): SetBudgetRequest {
  const amount = (raw: string | undefined, what: string, removable: boolean): number | null => {
    if (raw === undefined) throw new CliError(`missing ${what}`, EXIT.usage);
    if (removable && raw === "none") return null;
    const n = Number(raw);
    if (!(n > 0)) throw new CliError(`${what} must be a positive number${removable ? " or none" : ""}`, EXIT.usage);
    return n;
  };
  const chosen = [values.monthly !== undefined, values.project !== undefined, values.run !== undefined].filter(Boolean).length;
  if (chosen !== 1) throw new CliError("usage: navarch budget set --monthly <usd|none> | --project <id> --daily <usd|none> | --run <id> <usd>", EXIT.usage);
  if (values.monthly !== undefined) return { scope: "global_monthly", usd: amount(values.monthly, "--monthly", true) };
  if (values.project !== undefined) return { scope: "project_daily", target: values.project, usd: amount(values.daily, "--daily", true) };
  return { scope: "run", target: values.run!, usd: amount(rest[0], "the run's new budget", false) };
}

/** The project named by `--project`, else the one whose clone holds the current directory. */
async function exploredProject(api: ApiClient, id: string | undefined): Promise<string> {
  if (id) return id;
  const cwd = process.cwd();
  const projects = await api.request<ProjectView[]>("GET", "/api/v1/projects");
  const here = projects
    .filter((p) => cwd === p.path || cwd.startsWith(p.path + "/"))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (!here) throw new CliError("no registered project contains this directory; pass --project <id> (see `navarch project list`)", EXIT.usage);
  return here.id;
}

function required(value: string | undefined, what: string): string {
  if (!value) throw new CliError(`missing ${what}`, EXIT.usage);
  return value;
}

function print(value: unknown, json: boolean): number {
  console.log(json || typeof value !== "string" ? JSON.stringify(value, null, 2) : stripControls(value));
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

function printEvent(event: NavarchEvent, json: boolean): void {
  if (json) console.log(JSON.stringify(event));
  else printSafeLine(formatEvent(event));
}

async function printEvents(api: ApiClient, id: string, json: boolean): Promise<number> {
  const events = await api.request<NavarchEvent[]>("GET", `/api/v1/runs/${id}/events`);
  for (const event of events) printEvent(event, json);
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
    printEvent(event, json);
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
      // A pull that changed dependencies without `make install` makes the daemon die on an import (F3).
      const root = checkoutRoot(daemonMain);
      const stale = root && installProblem(root);
      if (stale) console.error(`warning: ${stale}`);
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
      const log = homeFiles(home).daemonLog;
      const hint = startFailureHint(readTail(log));
      throw new CliError(`navarchd did not start${hint ? `: ${hint}` : ""}; see ${log}`);
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

/** A `--param name=value` pair; the daemon reads the value as the param's type. */
function readParam(pair: string): [string, string] {
  const at = pair.indexOf("=");
  if (at < 1) throw new CliError(`--param expects name=value, got "${pair}"`, EXIT.usage);
  return [pair.slice(0, at).trim(), pair.slice(at + 1)];
}

/** A `--attach` file for a run: its name and text (the daemon checks size and type). */
function readAttachment(path: string): { name: string; content: string } {
  try {
    return { name: basename(path), content: readFileSync(path, "utf8") };
  } catch (err) {
    throw new CliError(`cannot read ${path}: ${(err as Error).message}`, EXIT.usage);
  }
}

/** The terminal for `navarch` and `navarch chat`: the ship greets a terminal, in colour when it wants it. */
function chatIo() {
  const tty = Boolean(process.stdout.isTTY);
  return { input: process.stdin, output: process.stdout, cwd: process.cwd(), tty, color: wantsColor(tty) };
}
