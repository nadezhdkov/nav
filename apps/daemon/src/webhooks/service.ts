import { createHmac, timingSafeEqual } from "node:crypto";
import type { Actor } from "@navarch/contracts";
import type { EventStore } from "../events/store.ts";
import type { Vault } from "../vault/vault.ts";

/**
 * GitHub webhooks (ADR 0068). A delivery reaches the daemon through the relay, which holds no secret, so
 * the daemon checks the `X-Hub-Signature-256` HMAC itself against `secret://github/webhook_secret`.
 *
 * A webhook only **nudges**: it says that something changed in a registered project, and the daemon then
 * runs the same reads it runs on its poll (the Inbox sync, the PR watcher, the CI watcher). Nothing in the
 * payload is stored or acted on beyond the repository name and the event type, so a forged or replayed
 * delivery that passes the signature can do no more than make the daemon look at GitHub a little sooner.
 */

export const WEBHOOK_SECRET_REF = "secret://github/webhook_secret";
const EVENTS = new Set(["ping", "issues", "pull_request", "check_run", "check_suite"]);
const MAX_BODY = 1024 * 1024;
const SEEN_TTL_MS = 60 * 60_000;
const SEEN_MAX = 2000;
const system: Actor = { kind: "system", component: "webhook" };

export type WebhookResult = { status: number; message: string };

export type WebhookDeps = {
  store: Pick<EventStore, "append" | "listProjects">;
  vault: Pick<Vault, "get" | "has">;
  /** Reads that a webhook triggers; each may take a while and is never awaited by the answer. */
  sync: { inbox(projectId: string): Promise<unknown>; pullRequests(): Promise<unknown>; ci(): Promise<unknown> };
  /** Waits this long after the first delivery of a burst before reading (GitHub sends several at once). */
  debounceMs?: number;
  now?: () => number;
  log?: (line: string) => void;
};

export type WebhookCounts = { configured: boolean; received: number; rejected: number; last_at: string | null };

type Pending = { timer: NodeJS.Timeout; inbox: boolean; prs: boolean; ci: boolean };

export class WebhookService {
  private readonly seen = new Map<string, number>();
  private readonly pending = new Map<string, Pending>();
  private received = 0;
  private rejected = 0;
  private lastAt: string | null = null;

  private readonly deps: WebhookDeps;

  constructor(deps: WebhookDeps) {
    this.deps = deps;
  }

  async status(): Promise<WebhookCounts> {
    return { configured: await this.deps.vault.has(WEBHOOK_SECRET_REF).catch(() => false), received: this.received, rejected: this.rejected, last_at: this.lastAt };
  }

  stop(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }

  /** Checks one delivery and answers at once; the reads it asks for run afterwards. */
  async receive(headers: Record<string, string | undefined>, body: Uint8Array): Promise<WebhookResult> {
    if (body.length > MAX_BODY) return this.reject(413, "payload too large");
    let secret: string;
    try {
      secret = await this.deps.vault.get(WEBHOOK_SECRET_REF);
    } catch {
      return { status: 503, message: "webhooks are not set up: store the secret with `navarch secret set github/webhook_secret`" };
    }
    if (!validSignature(secret, body, headers["x-hub-signature-256"])) return this.reject(401, "bad signature");

    const event = headers["x-github-event"] ?? "";
    const delivery = headers["x-github-delivery"] ?? "";
    if (!EVENTS.has(event) || !/^[A-Za-z0-9-]{8,64}$/.test(delivery)) return { status: 202, message: "ignored" };
    if (this.duplicate(delivery)) return { status: 200, message: "duplicate" };
    if (event === "ping") return { status: 200, message: "pong" };

    let payload: { action?: unknown; repository?: { full_name?: unknown } };
    try {
      payload = JSON.parse(Buffer.from(body).toString("utf8"));
    } catch {
      return { status: 400, message: "bad json" };
    }
    const repo = typeof payload.repository?.full_name === "string" ? payload.repository.full_name : "";
    const action = typeof payload.action === "string" ? payload.action : "";
    const project = this.deps.store.listProjects().find((p) => p.repo.toLowerCase() === repo.toLowerCase());
    if (!project) return { status: 202, message: "ignored" };
    const wants = this.wants(event, action);
    if (!wants) return { status: 202, message: "ignored" };

    this.received++;
    this.lastAt = new Date((this.deps.now ?? Date.now)()).toISOString();
    this.deps.store.append([{ type: "webhook.received", run_id: null, task_id: null, actor: system, payload: { delivery, event, action, project_id: project.id, repo: project.repo } }]);
    this.schedule(project.id, wants);
    return { status: 202, message: "accepted" };
  }

  /** Which reads an event asks for, or undefined when it asks for none. */
  private wants(event: string, action: string): Omit<Pending, "timer"> | undefined {
    if (event === "issues") return { inbox: true, prs: false, ci: false };
    if (event === "pull_request") return { inbox: false, prs: action === "closed", ci: ["opened", "reopened", "synchronize", "closed"].includes(action) };
    if ((event === "check_run" || event === "check_suite") && action === "completed") return { inbox: false, prs: false, ci: true };
    return undefined;
  }

  private schedule(projectId: string, wants: Omit<Pending, "timer">): void {
    const existing = this.pending.get(projectId);
    if (existing) {
      existing.inbox ||= wants.inbox;
      existing.prs ||= wants.prs;
      existing.ci ||= wants.ci;
      return;
    }
    const timer = setTimeout(() => {
      const job = this.pending.get(projectId);
      this.pending.delete(projectId);
      if (!job) return;
      const log = this.deps.log;
      const run = (name: string, p: Promise<unknown>) => p.catch((err: Error) => log?.(`webhook: ${name} failed (${err.message})`));
      if (job.inbox) void run("inbox sync", this.deps.sync.inbox(projectId));
      if (job.prs) void run("PR watcher", this.deps.sync.pullRequests());
      if (job.ci) void run("CI watcher", this.deps.sync.ci());
    }, this.deps.debounceMs ?? 2_000);
    timer.unref();
    this.pending.set(projectId, { timer, ...wants });
  }

  private duplicate(delivery: string): boolean {
    const now = (this.deps.now ?? Date.now)();
    for (const [id, at] of this.seen) if (now - at > SEEN_TTL_MS) this.seen.delete(id);
    if (this.seen.has(delivery)) return true;
    if (this.seen.size >= SEEN_MAX) this.seen.delete(this.seen.keys().next().value!);
    this.seen.set(delivery, now);
    return false;
  }

  private reject(status: number, message: string): WebhookResult {
    this.rejected++;
    return { status, message };
  }
}

function validSignature(secret: string, body: Uint8Array, header: string | undefined): boolean {
  const m = /^sha256=([0-9a-f]{64})$/.exec(header ?? "");
  if (!m) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(m[1]!, "hex"));
}
