import { join } from "node:path";
import type { NavarchEvent, NewEvent, RunView } from "@navarch/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempHome } from "../../../packages/runner/test/helpers.ts";
import { Config } from "../src/config.ts";
import { DeviceService } from "../src/devices/devices.ts";
import { EventStore } from "../src/events/store.ts";
import { COALESCE_MS, noticeFor, Notifier, render, type PushMessage } from "../src/notifications/notifier.ts";
import { PolicyEngine } from "../src/policy/engine.ts";

const keys = { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" };
const system = { kind: "system", component: "test" } as const;

let store: EventStore;
let notifier: Notifier | undefined;
beforeEach(() => {
  store = new EventStore(join(tempHome(), "navarch.db"));
});
afterEach(async () => {
  vi.useRealTimers();
  await notifier?.stop();
  store.close();
});

function setup(notifications: Record<string, unknown> = {}, now?: () => Date) {
  const config = Config.parse({ notifications });
  const devices = new DeviceService(store, join(tempHome(), "device-key"));
  const sent: { endpoint: string; message: PushMessage; urgency?: string }[] = [];
  let status = 201;
  notifier = new Notifier({
    store,
    devices,
    policy: new PolicyEngine(),
    config,
    vapidFile: join(tempHome(), "push", "vapid.json"),
    now,
    send: async (target, payload, options) => {
      sent.push({ endpoint: target.endpoint, message: payload as PushMessage, urgency: options.urgency });
      return { status, body: "" };
    },
  });
  notifier.start();
  const phone = devices.pair(devices.createPairing("https://pc.ts.net").code, "Phone");
  devices.setSubscription(phone.device.id, { endpoint: "https://fcm.googleapis.com/fcm/send/x", keys, locale: "pt-BR" }, system);
  const run = createRun();
  return { devices, sent, phone, run, setStatus: (s: number) => (status = s) };
}

function requestApproval(runId: string, n: number): void {
  store.append([
    {
      type: "task.created",
      run_id: runId,
      task_id: `task_${runId}_${n}`,
      actor: system,
      payload: { node_id: `gate${n}`, type: "approval", profile: "approval", adapter: "approval", max_attempts: 1 },
    } as NewEvent,
    approval(runId, n),
  ]);
}

function createRun(): string {
  const id = `run_${Math.random().toString(36).slice(2)}`;
  store.append([
    {
      type: "run.created",
      run_id: id,
      task_id: null,
      actor: system,
      payload: { repo_path: "/r", base_commit: "abc", prompt: "Add a greeting\nmore text", budget: 2, adapter: "claude-code", profile: "implementer", allow_commands: [] },
    } as NewEvent,
  ]);
  return id;
}

/** An approval request; in the store it needs its task, so `withTask` creates one first. */
const approval = (runId: string, n: number, action = "flow.approval"): NewEvent => ({
  type: "approval.requested",
  run_id: runId,
  task_id: `task_${runId}_${n}`,
  actor: system,
  payload: { approval_id: `apr_${n}`, action, resource: "t", reason: "r", summary: "s" },
});

const status = (runId: string, from: string, to: string, reason?: string): NewEvent =>
  ({ type: "run.status_changed", run_id: runId, task_id: null, actor: system, payload: { from, to, ...(reason ? { reason } : {}) } }) as NewEvent;

describe("notifications (ADR 0020)", () => {
  it("maps events to notices and leaves the user's own pauses alone", () => {
    const ev = (e: NewEvent) => ({ ...e, id: "e", seq: 1, ts: "", schema_version: 1 }) as NavarchEvent;
    expect(noticeFor(ev(approval("run_1", 1)))).toMatchObject({ kind: "approval", subject: "plan", url: "/approvals?focus=apr_1", critical: false });
    expect(noticeFor(ev(approval("run_1", 1, "github.pr.create")))?.subject).toBe("pr");
    expect(noticeFor(ev(status("run_1", "executing", "failed")))).toMatchObject({ kind: "run_failed", critical: true, url: "/runs/run_1" });
    expect(noticeFor(ev(status("run_1", "executing", "budget_exceeded")))?.critical).toBe(true);
    expect(noticeFor(ev(status("run_1", "executing", "paused", "quota resets in 30 h")))?.kind).toBe("paused_quota");
    expect(noticeFor(ev(status("run_1", "executing", "paused", "user")))).toBeUndefined();
    expect(noticeFor(ev(status("run_1", "executing", "paused", "kill switch")))).toBeUndefined();
    expect(noticeFor(ev(status("run_1", "planning", "executing")))).toBeUndefined();
  });

  it("writes the notification in the device's language, with deep links only", () => {
    const run = { id: "run_1", prompt: "Fix\u0007 the login\nbody", work_item: { repo: "o/r", number: 7 } } as unknown as RunView;
    const m = render({ kind: "approval", run_id: "run_1", critical: false, url: "/approvals?focus=apr_1", subject: "plan" }, 2, run, "pt-BR");
    expect(m).toEqual({
      title: "Aprovação pendente",
      body: "Plano: o/r#7 · Fix  the login · mais 2 nesta run",
      tag: "run_1-approval",
      url: "/approvals?focus=apr_1",
      actions: [
        { action: "open", title: "Abrir", url: "/approvals?focus=apr_1" },
        { action: "plan", title: "Ver plano", url: "/approvals?focus=apr_1" },
      ],
    });
    const long = render({ kind: "run_done", run_id: "run_1", critical: false, url: "/runs/run_1" }, 0, { ...run, prompt: "x".repeat(200), work_item: null }, "en");
    expect(long.body.length).toBeLessThanOrEqual(80);
  });

  it("sends at once, then folds the same run's notices within the window into one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { sent, run } = setup();
    requestApproval(run, 1);
    requestApproval(run, 2);
    requestApproval(run, 3);
    await notifier!.idle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.urgency).toBe("high");
    vi.advanceTimersByTime(COALESCE_MS);
    await notifier!.idle();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.message.body).toContain("mais 2 nesta run");
    expect(store.events().filter((e) => e.type === "notification.sent")).toHaveLength(2);
  });

  it("holds normal notifications in quiet hours but lets critical ones through", async () => {
    const at2am = () => new Date(2026, 9, 15, 2, 0);
    const { sent, run } = setup({ quiet_hours: { start: "23:00", end: "07:00" } }, at2am);
    requestApproval(run, 1);
    store.append([status(run, "created", "failed")]);
    await notifier!.idle();
    expect(sent.map((s) => s.message.title)).toEqual(["Run falhou"]);
  });

  it("drops a subscription the push service says is gone, and records failures", async () => {
    const { sent, run, devices, phone, setStatus } = setup();
    setStatus(410);
    store.append([status(run, "created", "failed")]);
    await notifier!.idle();
    expect(sent).toHaveLength(1);
    expect(devices.subscriptions()).toEqual([]);
    expect(devices.get(phone.device.id)!.push).toBe(false);
    const failed = store.events().find((e) => e.type === "notification.failed")!;
    expect(failed.payload).toMatchObject({ channel: "web_push", device_id: phone.device.id, status: 410 });
  });

  it("refuses endpoints outside the push host allowlist, even ones stored earlier", async () => {
    const { sent, run } = setup({ push_hosts: ["updates.push.services.mozilla.com"] });
    expect(notifier!.checkEndpoint("https://fcm.googleapis.com/x")).toMatch(/push_hosts/);
    expect(notifier!.checkEndpoint("https://a.push.apple.com/x")).toMatch(/push_hosts/);
    expect(notifier!.checkEndpoint("https://updates.push.services.mozilla.com/x")).toBeUndefined();
    store.append([status(run, "created", "failed")]);
    await notifier!.idle();
    expect(sent).toHaveLength(0);
    expect(store.events().some((e) => e.type === "notification.failed")).toBe(true);
  });
});
