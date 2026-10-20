import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { DEFAULT_SCRUB_ENV, scrubbedEnv, toolSummary } from "@navarch/adapter-kit";
import {
  redact,
  type Actor,
  type OpenSessionRequest,
  type SessionDetail,
  type SessionItem,
  type SessionMessageRequest,
  type SessionPermissionMode,
  type SessionPermissionRequest,
  type SessionStatus,
  type SessionView,
} from "@navarch/contracts";
import type { Config } from "../config.ts";
import type { EventStore } from "../events/store.ts";
import type { PolicyEngine } from "../policy/engine.ts";

/**
 * Live Claude Code sessions (ADR 0074). One `claude` process per session, run in a registered project's
 * folder with streamed JSON in and out. Every permission the agent asks for (`can_use_tool`) is held
 * until the user answers it in the app; nothing is answered on the user's behalf. The transcript lives
 * in memory; the events record the user's messages, each turn's answer, every permission decision and
 * the session's start and end.
 */

export class SessionError extends Error {
  readonly code: "not_found" | "conflict" | "forbidden" | "disabled" | "invalid";

  constructor(code: SessionError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export type SessionDeps = {
  config: Config;
  store: EventStore;
  policy: PolicyEngine;
  /** The `claude` command and the arguments that come before ours (tests point it at a fake). */
  command: { command: string; args: string[] };
  now?: () => number;
};

type Pending = { itemSeq: number; tool: string; input: unknown; summary: string };

type Live = {
  id: string;
  projectId: string;
  projectName: string;
  path: string;
  mode: SessionPermissionMode;
  openedAt: number;
  lastActivity: number;
  status: SessionStatus;
  cost: number;
  claudeId: string;
  closedReason: string | null;
  items: SessionItem[];
  seq: number;
  live: string | null;
  pending: Map<string, Pending>;
  /** Messages sent whose turn has not finished. */
  turns: number;
  proc: ChildProcessWithoutNullStreams | undefined;
  lastText: string;
};

const KEEP_ITEMS = 500;
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export class SessionService {
  private readonly deps: SessionDeps;
  private readonly sessions = new Map<string, Live>();
  private timer: NodeJS.Timeout | undefined;

  constructor(deps: SessionDeps) {
    this.deps = deps;
    this.timer = setInterval(() => this.closeIdle(), 30_000);
    this.timer.unref();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  enabled(): boolean {
    return this.deps.config.sessions.enabled;
  }

  list(): SessionView[] {
    const live = [...this.sessions.values()].map((s) => this.view(s));
    // Sessions of earlier runs of the daemon are listed from their events, only to be reopened.
    const known = new Set(this.sessions.keys());
    const closed = new Set(this.deps.store.eventsOfType("session.closed", 200).map((e) => (e.payload as { session_id: string }).session_id));
    const earlier = this.deps.store
      .eventsOfType("session.opened", 20)
      .filter((e) => !known.has((e.payload as { session_id: string }).session_id))
      .map((e): SessionView => {
        const p = e.payload as { session_id: string; project_id: string; path: string; permission_mode: SessionPermissionMode; claude_session_id: string };
        const project = this.deps.store.getProject(p.project_id);
        return {
          id: p.session_id,
          project_id: p.project_id,
          project_name: project?.name ?? p.path,
          path: p.path,
          status: "closed",
          permission_mode: p.permission_mode,
          opened_at: e.ts,
          last_activity: e.ts,
          cost_usd: 0,
          pending: 0,
          claude_session_id: p.claude_session_id,
          closed_reason: closed.has(p.session_id) ? "closed" : "the daemon restarted",
        };
      });
    return [...live, ...earlier].sort((a, b) => b.opened_at.localeCompare(a.opened_at));
  }

  get(id: string, after = 0): SessionDetail {
    const s = this.session(id);
    return { ...this.view(s), items: s.items.filter((i) => i.seq > after), live: s.live, seq: s.seq };
  }

  /** Opens a session in a registered project, as the user. */
  open(req: OpenSessionRequest, actor: Actor): SessionDetail {
    if (!this.enabled()) throw new SessionError("disabled", "sessions are off: set `sessions.enabled: true` in the daemon's config.yaml on the PC");
    const decision = this.deps.policy.decide(actor, "session.open", req.project_id, { autonomyLevel: this.deps.config.autonomy_level });
    if (decision.effect !== "allow") throw new SessionError("forbidden", `opening a session denied: ${decision.reason}`);
    const project = this.deps.store.getProject(req.project_id);
    if (!project || project.removed_at) throw new SessionError("not_found", `project ${req.project_id} not found`);
    const active = [...this.sessions.values()].filter((s) => s.status !== "closed");
    if (active.length >= this.deps.config.sessions.max_open) throw new SessionError("conflict", `${active.length} sessions are open already (sessions.max_open)`);

    let resumeId: string | undefined;
    if (req.resume) {
      const earlier = this.list().find((s) => s.id === req.resume);
      if (!earlier?.claude_session_id) throw new SessionError("not_found", `session ${req.resume} not found`);
      if (earlier.project_id !== project.id) throw new SessionError("invalid", "that session belongs to another project");
      if (earlier.status !== "closed") throw new SessionError("conflict", "that session is still open");
      resumeId = earlier.claude_session_id;
    }
    const mode = req.permission_mode ?? this.deps.config.sessions.permission_mode;
    const claudeId = resumeId ?? randomUUID();
    const t = this.now();
    const s: Live = {
      id: `ses_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      projectId: project.id,
      projectName: project.name,
      path: project.path,
      mode,
      openedAt: t,
      lastActivity: t,
      status: "starting",
      cost: 0,
      claudeId,
      closedReason: null,
      items: [],
      seq: 0,
      live: null,
      pending: new Map(),
      turns: 0,
      proc: undefined,
      lastText: "",
    };
    // Closed sessions of this run of the daemon are kept to be read, the 20 newest.
    const closedOnes = [...this.sessions.values()].filter((x) => x.status === "closed");
    for (const old of closedOnes.slice(0, Math.max(0, closedOnes.length - 20))) this.sessions.delete(old.id);
    this.sessions.set(s.id, s);
    this.deps.store.append([
      { type: "session.opened", run_id: null, task_id: null, actor, payload: { session_id: s.id, project_id: s.projectId, path: s.path, permission_mode: mode, claude_session_id: claudeId, resumed_from: req.resume ?? null } },
    ]);
    this.start(s, resumeId !== undefined);
    return this.get(s.id);
  }

  /** The user's message, with optional images, goes to the agent. */
  send(id: string, req: SessionMessageRequest, actor: Actor): SessionDetail {
    const s = this.session(id);
    if (s.status === "closed" || !s.proc) throw new SessionError("conflict", "this session is closed");
    const images = req.images ?? [];
    const content = [
      ...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.media_type, data: i.data } })),
      { type: "text", text: req.text },
    ];
    this.push(s, "user", req.text + (images.length ? `\n🖼 ${images.length}` : ""));
    this.deps.store.append([{ type: "session.message", run_id: null, task_id: null, actor, payload: { session_id: s.id, text: redact(req.text), images: images.length } }]);
    s.turns++;
    s.status = s.pending.size ? "waiting" : "working";
    this.touch(s);
    s.proc.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`);
    return this.get(s.id);
  }

  /** The user answers one permission question. */
  decide(id: string, requestId: string, req: SessionPermissionRequest, actor: Actor): SessionDetail {
    const s = this.session(id);
    const pending = s.pending.get(requestId);
    if (!pending || !s.proc) throw new SessionError("not_found", "that question is not waiting for an answer");
    const allow = req.decision === "allow";
    s.pending.delete(requestId);
    const item = s.items.find((i) => i.seq === pending.itemSeq);
    if (item) item.status = allow ? "allowed" : "denied";
    this.deps.store.append([
      { type: "session.permission", run_id: null, task_id: null, actor, payload: { session_id: s.id, request_id: requestId, tool: pending.tool, decision: allow ? "allow" : "deny", summary: redact(pending.summary) } },
    ]);
    const response = allow ? { behavior: "allow", updatedInput: pending.input } : { behavior: "deny", message: req.message?.trim() || "The user refused this from the app." };
    s.proc.stdin.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response } })}\n`);
    s.status = s.pending.size ? "waiting" : "working";
    this.touch(s);
    return this.get(s.id);
  }

  close(id: string, actor: Actor, reason = "closed by the user"): SessionDetail {
    const s = this.session(id);
    void actor;
    this.finish(s, reason);
    return this.get(id);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const s of this.sessions.values()) this.finish(s, "the daemon stopped");
  }

  // --- internals ---

  private session(id: string): Live {
    const s = this.sessions.get(id);
    if (!s) throw new SessionError("not_found", `session ${id} not found`);
    return s;
  }

  private view(s: Live): SessionView {
    return {
      id: s.id,
      project_id: s.projectId,
      project_name: s.projectName,
      path: s.path,
      status: s.status,
      permission_mode: s.mode,
      opened_at: new Date(s.openedAt).toISOString(),
      last_activity: new Date(s.lastActivity).toISOString(),
      cost_usd: s.cost,
      pending: s.pending.size,
      claude_session_id: s.claudeId,
      closed_reason: s.closedReason,
    };
  }

  private touch(s: Live): void {
    s.lastActivity = this.now();
  }

  private push(s: Live, kind: SessionItem["kind"], text: string, extra: Partial<SessionItem> = {}): SessionItem {
    const item: SessionItem = { seq: ++s.seq, ts: new Date(this.now()).toISOString(), kind, text: clip(text, 8_000), ...extra };
    s.items.push(item);
    if (s.items.length > KEEP_ITEMS) s.items.splice(0, s.items.length - KEEP_ITEMS);
    return item;
  }

  private start(s: Live, resume: boolean): void {
    const cfg = this.deps.config.sessions;
    const args = [
      ...this.deps.command.args,
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-prompt-tool", "stdio",
      "--permission-mode", s.mode,
      "--setting-sources", cfg.setting_sources,
      "--max-budget-usd", cfg.max_cost_usd.toFixed(2),
      ...(resume ? ["--resume", s.claudeId] : ["--session-id", s.claudeId]),
    ];
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(this.deps.command.command, args, { cwd: s.path, env: scrubbedEnv(DEFAULT_SCRUB_ENV), stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      this.finish(s, `could not start claude: ${(err as Error).message}`);
      return;
    }
    s.proc = proc;
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr = (stderr + String(d)).slice(-2_000)));
    proc.on("error", (err) => this.finish(s, `could not start claude: ${err.message}`));
    proc.on("close", (code) => this.finish(s, code === 0 || s.status === "closed" ? "the agent ended" : `the agent exited with code ${code}${stderr.trim() ? `: ${clip(stderr.trim(), 300)}` : ""}`));
    proc.stdin.on("error", () => {});
    createInterface({ input: proc.stdout }).on("line", (line) => this.onLine(s, line));
    s.status = "idle";
  }

  private onLine(s: Live, line: string): void {
    let m: Record<string, any>;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof m !== "object" || m === null) return;
    this.touch(s);
    switch (m.type) {
      case "system":
        if (m.subtype === "init") {
          if (typeof m.session_id === "string") s.claudeId = m.session_id;
          // Sessions run on a plan login. An API key would be billed outside the budgets (ADR 0023), so it is refused.
          if (m.apiKeySource && m.apiKeySource !== "none") this.finish(s, "this Claude Code is signed in with an API key, which would be billed; sessions run only on a claude.ai plan login");
        }
        return;
      case "stream_event": {
        const e = m.event;
        if (m.parent_tool_use_id) return;
        if (e?.type === "message_start") s.live = "";
        else if (e?.type === "content_block_delta" && e.delta?.type === "text_delta" && typeof e.delta.text === "string") s.live = (s.live ?? "") + e.delta.text;
        return;
      }
      case "assistant": {
        if (m.parent_tool_use_id) return;
        s.live = null;
        const blocks: any[] = Array.isArray(m.message?.content) ? m.message.content : [];
        for (const b of blocks) {
          if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
            s.lastText = b.text;
            this.push(s, "assistant", b.text);
          } else if (b?.type === "tool_use" && typeof b.name === "string") {
            this.push(s, "tool", toolSummary(b.name, b.input), { tool: b.name });
          }
        }
        return;
      }
      case "control_request": {
        const r = m.request;
        if (r?.subtype !== "can_use_tool" || typeof m.request_id !== "string") return;
        const tool = String(r.tool_name ?? "tool");
        const summary = `${toolSummary(tool, r.input)}${typeof r.description === "string" && r.description ? ` — ${r.description}` : ""}`;
        const item = this.push(s, "permission", summary, { tool, request_id: m.request_id, status: "pending" });
        s.pending.set(m.request_id, { itemSeq: item.seq, tool, input: r.input, summary });
        s.status = "waiting";
        return;
      }
      case "result": {
        s.live = null;
        if (typeof m.total_cost_usd === "number") s.cost = m.total_cost_usd;
        s.turns = Math.max(0, s.turns - 1);
        const text = typeof m.result === "string" ? m.result : s.lastText;
        this.deps.store.append([{ type: "session.reply", run_id: null, task_id: null, actor: { kind: "agent", profile: "session", adapter: "claude-code" } as Actor, payload: { session_id: s.id, text: redact(clip(text, 4_000)), cost_usd: s.cost } }]);
        if (m.is_error) this.push(s, "notice", clip(String(m.result ?? m.subtype ?? "the agent stopped with an error"), 500));
        if (m.subtype === "error_max_budget_usd") this.finish(s, "the session reached its cost ceiling (sessions.max_cost_usd)");
        else if (s.status !== "closed") s.status = s.pending.size ? "waiting" : s.turns > 0 ? "working" : "idle";
        return;
      }
      case "rate_limit_event":
        if (m.rate_limit_info?.status === "rejected") this.push(s, "notice", "Claude Code's usage limit was reached; try again after it resets.");
        return;
      default:
    }
  }

  private finish(s: Live, reason: string): void {
    if (s.status === "closed") return;
    s.status = "closed";
    s.closedReason = reason;
    s.live = null;
    for (const [requestId, p] of s.pending) {
      const item = s.items.find((i) => i.seq === p.itemSeq);
      if (item) item.status = "expired";
      this.deps.store.append([{ type: "session.permission", run_id: null, task_id: null, actor: { kind: "system", component: "sessions" } as Actor, payload: { session_id: s.id, request_id: requestId, tool: p.tool, decision: "expired", summary: redact(p.summary) } }]);
    }
    s.pending.clear();
    this.push(s, "notice", reason);
    this.deps.store.append([{ type: "session.closed", run_id: null, task_id: null, actor: { kind: "system", component: "sessions" } as Actor, payload: { session_id: s.id, reason } }]);
    const proc = s.proc;
    s.proc = undefined;
    if (proc && proc.exitCode === null) {
      try {
        proc.stdin.end();
      } catch {
        // already closed
      }
      const kill = setTimeout(() => proc.kill("SIGKILL"), 3_000);
      kill.unref();
      proc.once("close", () => clearTimeout(kill));
      proc.kill("SIGTERM");
    }
  }

  private closeIdle(): void {
    const limit = this.deps.config.sessions.idle_minutes * 60_000;
    for (const s of this.sessions.values()) {
      if (s.status !== "closed" && this.now() - s.lastActivity > limit) this.finish(s, `closed after ${this.deps.config.sessions.idle_minutes} minutes without activity`);
    }
  }
}
