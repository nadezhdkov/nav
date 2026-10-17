import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Actor, NavarchEvent, RunView } from "@navarch/contracts";
import { subjectOf as awaySubject } from "../away/service.ts";
import type { Config } from "../config.ts";
import type { DeviceService, DeviceSubscription } from "../devices/devices.ts";
import type { EventStore } from "../events/store.ts";
import type { PolicyEngine } from "../policy/engine.ts";
import { fill, MESSAGES, type ApprovalSubject, type NoticeKind } from "./messages.ts";
import { generateVapidKeys, sendPush, type PushOptions, type PushTarget, type VapidKeys } from "./webpush.ts";

/** Events of the same run and kind within this window are folded into one notification. */
export const COALESCE_MS = 10_000;
const TITLE_MAX = 80;

/** Something worth a notification, before it is written in a device's language. */
export interface Notice {
  kind: NoticeKind;
  run_id: string;
  critical: boolean;
  /** Path in the SPA to open. */
  url: string;
  subject?: ApprovalSubject;
}

/** What the service worker receives (decrypted): enough to show and route, nothing more. */
export interface PushMessage {
  title: string;
  body: string;
  tag: string;
  url: string;
  actions: { action: string; title: string; url: string }[];
}

export interface NotifierDeps {
  store: EventStore;
  devices: DeviceService;
  policy: PolicyEngine;
  config: Config;
  vapidFile: string;
  send?: (target: PushTarget, payload: unknown, options: PushOptions) => Promise<{ status: number; body: string }>;
  now?: () => Date;
}

const actor: Actor = { kind: "system", component: "notifier" };

/**
 * Web Push to paired devices (spec §6.11, ADR 0020). Notifications open the app; they never act.
 * Each send asks the Policy Engine and is recorded as `notification.sent` or `.failed`.
 */
export class Notifier {
  readonly publicKey: string;
  private readonly deps: NotifierDeps;
  private readonly vapid: VapidKeys;
  private readonly windows = new Map<string, { count: number; latest: Notice; timer: NodeJS.Timeout }>();
  private readonly inflight = new Set<Promise<void>>();
  private off: (() => void) | undefined;

  constructor(deps: NotifierDeps) {
    this.deps = deps;
    this.vapid = loadVapid(deps.vapidFile);
    this.publicKey = this.vapid.publicKey;
  }

  start(): void {
    if (!this.deps.config.notifications.web_push || this.off) return;
    this.off = this.deps.store.subscribe((event) => {
      const notice = this.noticeOf(event);
      if (notice) this.enqueue(notice);
    });
  }

  /**
   * Away mode (ADR 0039): an approval the approver is about to read is not news. The user hears
   * about it when the approver leaves it to them.
   */
  private noticeOf(event: NavarchEvent): Notice | undefined {
    const { store } = this.deps;
    if (event.type === "approval.requested") {
      const approvalId = (event.payload as { approval_id: string }).approval_id;
      const view = store.awayView();
      const approval = store.getApproval(approvalId);
      const task = approval ? store.getTask(approval.task_id) : undefined;
      const subject = approval && task ? awaySubject(approval, task) : undefined;
      if (view.active && subject && view.settings?.delegate.includes(subject)) return undefined;
    }
    if (event.type === "away.reviewed") {
      const p = (event as NavarchEvent<"away.reviewed">).payload;
      const approval = p.verdict === "escalate" ? store.getApproval(p.approval_id) : undefined;
      if (!approval || approval.status !== "pending" || !event.run_id) return undefined;
      return { kind: "approval", run_id: event.run_id, critical: false, url: `/approvals?focus=${approval.id}`, subject: subjectOf(approval.action) };
    }
    return noticeFor(event);
  }

  /** Stops listening and waits for sends in flight; folded notifications still pending are dropped. */
  async stop(): Promise<void> {
    this.off?.();
    this.off = undefined;
    for (const w of this.windows.values()) clearTimeout(w.timer);
    this.windows.clear();
    await Promise.allSettled([...this.inflight]);
  }

  /** Why a subscription endpoint is refused, or undefined when the daemon may POST to it. */
  checkEndpoint(endpoint: string): string | undefined {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      return "endpoint is not a URL";
    }
    if (url.protocol !== "https:") return "push endpoints must use https";
    const host = url.hostname.toLowerCase();
    const allowed = this.deps.config.notifications.push_hosts.some((pattern) =>
      pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : host === pattern.toLowerCase(),
    );
    return allowed ? undefined : `push service ${host} is not in notifications.push_hosts`;
  }

  /** Resolves once every send started so far has finished (tests). */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  private enqueue(notice: Notice): void {
    const key = `${notice.run_id}:${notice.kind}`;
    const open = this.windows.get(key);
    if (open) {
      open.count += 1;
      open.latest = notice;
      return;
    }
    this.dispatch(notice, 0);
    const timer = setTimeout(() => {
      const w = this.windows.get(key);
      this.windows.delete(key);
      if (w && w.count > 0) this.dispatch(w.latest, w.count);
    }, COALESCE_MS);
    timer.unref();
    this.windows.set(key, { count: 0, latest: notice, timer });
  }

  private dispatch(notice: Notice, more: number): void {
    if (!notice.critical && this.quiet()) return;
    const run = this.deps.store.getRun(notice.run_id);
    for (const sub of this.deps.devices.subscriptions()) {
      const work = this.deliver(sub, notice, more, run).finally(() => this.inflight.delete(work));
      this.inflight.add(work);
    }
  }

  private async deliver(sub: DeviceSubscription, notice: Notice, more: number, run: RunView | undefined): Promise<void> {
    const decision = this.deps.policy.decide(actor, "notification.send", sub.device_id, { autonomyLevel: this.deps.config.autonomy_level });
    if (decision.effect !== "allow") return;
    // Re-checked at send time: the allowlist may have changed since the device subscribed.
    const refused = this.checkEndpoint(sub.endpoint);
    if (refused) return this.failed(sub, notice, null, refused);
    const message = render(notice, more, run, sub.locale);
    try {
      const res = await (this.deps.send ?? sendPush)({ endpoint: sub.endpoint, keys: sub.keys }, message, {
        vapid: this.vapid,
        subject: this.deps.config.notifications.vapid_subject,
        ttl: notice.kind === "approval" || notice.critical ? 24 * 3600 : 6 * 3600,
        urgency: notice.critical || notice.kind === "approval" ? "high" : "normal",
        topic: message.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32),
      });
      if (res.status >= 200 && res.status < 300) {
        this.record({ type: "notification.sent", payload: { channel: "web_push", device_id: sub.device_id, kind: notice.kind, run_id: notice.run_id } });
        return;
      }
      if (res.status === 404 || res.status === 410) this.deps.devices.clearSubscription(sub.device_id, actor);
      this.failed(sub, notice, res.status, `push service answered ${res.status}`);
    } catch (err) {
      this.failed(sub, notice, null, (err as Error).message);
    }
  }

  private failed(sub: DeviceSubscription, notice: Notice, status: number | null, message: string): void {
    this.record({ type: "notification.failed", payload: { channel: "web_push", device_id: sub.device_id, kind: notice.kind, status, message: message.slice(0, 300) } });
  }

  private record(e: { type: "notification.sent"; payload: NavarchEvent<"notification.sent">["payload"] } | { type: "notification.failed"; payload: NavarchEvent<"notification.failed">["payload"] }): void {
    try {
      this.deps.store.append([{ ...e, run_id: null, task_id: null, actor } as never]);
    } catch {
      // The store is closed when the daemon stops mid-send; the notification is gone either way.
    }
  }

  private quiet(): boolean {
    const q = this.deps.config.notifications.quiet_hours;
    if (!q) return false;
    const now = this.deps.now?.() ?? new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    const start = toMinutes(q.start);
    const end = toMinutes(q.end);
    return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  }
}

/** The notification an event deserves, if any (spec §6.11 table in the slice spec). */
export function noticeFor(event: NavarchEvent): Notice | undefined {
  const runId = event.run_id;
  if (!runId) return undefined;
  if (event.type === "approval.requested") {
    const p = (event as NavarchEvent<"approval.requested">).payload;
    return { kind: "approval", run_id: runId, critical: false, url: `/approvals?focus=${p.approval_id}`, subject: subjectOf(p.action) };
  }
  if (event.type === "budget.threshold") {
    // A run's own budget at 100 % shows as the run's budget_exceeded status; the others are news here (ADR 0023).
    const p = (event as NavarchEvent<"budget.threshold">).payload;
    if (p.ratio < 1) return { kind: "budget_warning", run_id: runId, critical: false, url: "/usage" };
    return p.scope === "run" ? undefined : { kind: "budget_exceeded", run_id: runId, critical: true, url: "/usage" };
  }
  if (event.type === "task.status_changed") {
    const p = (event as NavarchEvent<"task.status_changed">).payload;
    // A team lead asked the user something; the team waits for the answer (ADR 0022).
    if (p.to === "blocked" && p.reason === "question") return { kind: "question", run_id: runId, critical: false, url: `/runs/${runId}` };
    return undefined;
  }
  if (event.type !== "run.status_changed") return undefined;
  const p = (event as NavarchEvent<"run.status_changed">).payload;
  const url = `/runs/${runId}`;
  switch (p.to) {
    case "failed":
      return { kind: "run_failed", run_id: runId, critical: true, url };
    case "budget_exceeded":
      return { kind: "budget_exceeded", run_id: runId, critical: true, url };
    case "pr_opened":
      return { kind: "pr_opened", run_id: runId, critical: false, url };
    case "done":
      return { kind: "run_done", run_id: runId, critical: false, url };
    case "paused":
      // A pause by the user (or the kill switch) is not news to them.
      if (p.reason === "user" || p.reason === "kill switch") return undefined;
      return { kind: "paused_quota", run_id: runId, critical: false, url };
    default:
      return undefined;
  }
}

export function render(notice: Notice, more: number, run: RunView | undefined, locale: keyof typeof MESSAGES): PushMessage {
  const t = MESSAGES[locale] ?? MESSAGES.en;
  // The run title may come from an issue (untrusted, T1): plain text, one line, truncated.
  const title = run ? runTitle(run) : notice.run_id;
  const parts = [notice.subject ? `${t.approval[notice.subject]}: ${title}` : title];
  if (more > 0) parts.push(fill(t.more, { n: more }));
  const actions = [{ action: "open", title: t.actions.open, url: notice.url }];
  if (notice.kind === "approval" && notice.subject === "plan") actions.push({ action: "plan", title: t.actions.plan, url: notice.url });
  if (notice.kind === "approval" && notice.subject === "pr") actions.push({ action: "diff", title: t.actions.diff, url: notice.url });
  return { title: t.title[notice.kind], body: parts.join(" · "), tag: `${notice.run_id}-${notice.kind}`, url: notice.url, actions };
}

function runTitle(run: RunView): string {
  const line = run.prompt.split("\n").find((l) => l.trim())?.trim() ?? "";
  const ref = run.work_item ? `${run.work_item.repo}#${run.work_item.number}` : "";
  const text = [run.name, ref, line].filter(Boolean).join(" · ");
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, " ");
  return clean.length > TITLE_MAX ? `${clean.slice(0, TITLE_MAX - 1)}…` : clean;
}

function subjectOf(action: string): ApprovalSubject {
  if (action === "flow.approval") return "plan";
  if (action === "github.pr.create") return "pr";
  if (action === "verification.run") return "verification";
  return "agent";
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** The daemon's VAPID key pair, created on first use (mode 0600). */
function loadVapid(file: string): VapidKeys {
  if (existsSync(file)) {
    const keys = JSON.parse(readFileSync(file, "utf8")) as Partial<VapidKeys>;
    if (keys.publicKey && keys.privateKey) return { publicKey: keys.publicKey, privateKey: keys.privateKey };
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const keys = generateVapidKeys();
  writeFileSync(file, JSON.stringify(keys) + "\n", { mode: 0o600 });
  return keys;
}
