import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Actor, FlowSummary, RunView, SaveScheduleRequest, ScheduleView } from "@navarch/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeClaude } from "../../../packages/adapters/claude-code/test/fake.ts";
import { makeRepo, tempHome } from "../../../packages/runner/test/helpers.ts";
import { Config } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";
import { EventStore } from "../src/events/store.ts";
import { PolicyEngine } from "../src/policy/engine.ts";
import { latestSlot, nextSlot, ScheduleError, ScheduleService, slotName } from "../src/schedules/service.ts";

const user: Actor = { kind: "user", via: "cli" };
const FLOWS = [{ name: "task", needs: "prompt" }, { name: "fix-issue", needs: "issue" }, { name: "compete", needs: "prompt" }] as FlowSummary[];

/** Event timestamps follow this clock, so "saved at" and "today" agree with the service's idea of now. */
const clock = { now: new Date(2026, 9, 21, 8, 0) }; // Wednesday 2026-10-21, 08:00 local

let store: EventStore;
beforeEach(() => {
  clock.now = new Date(2026, 9, 21, 8, 0);
  store = new EventStore(join(tempHome(), "navarch.db"), { now: () => clock.now });
  store.append([{ type: "project.added", run_id: null, task_id: null, actor: user, payload: { project_id: "prj_1", name: "r", repo: "acme/widgets", path: "/work/widgets" } }]);
});
afterEach(() => store.close());

/** A moment on the local day `ahead` days after the test's today, at `hhmm`. */
function at(ahead: number, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(2026, 9, 21 + ahead, h, m, 0, 0);
}

const ALL = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const request = (over: Partial<SaveScheduleRequest> = {}): SaveScheduleRequest => ({ name: "nightly", project_id: "prj_1", prompt: "triage the failing tests", budget: 1, at: "09:00", days: [...ALL], enabled: true, ...over });

function service(config: Record<string, unknown> = {}, startRun?: (req: unknown) => Promise<RunView>) {
  const started: unknown[] = [];
  const svc = new ScheduleService({
    config: Config.parse({ schedules: config }),
    store,
    policy: new PolicyEngine(),
    startRun: async (req) => {
      started.push(req);
      return startRun ? startRun(req) : ({ id: `run_${started.length}`, name: "brave-frigate" } as RunView);
    },
    flows: () => FLOWS,
    now: () => clock.now,
  });
  return { svc, started };
}

describe("timetable arithmetic", () => {
  it("finds the latest slot not after now, only on the chosen days", () => {
    const wed = new Date(2026, 9, 21, 12, 0); // Wednesday
    expect(slotName(latestSlot(["wed"], "09:00", wed)!)).toBe("2026-10-21 09:00");
    expect(slotName(latestSlot(["mon"], "09:00", wed)!)).toBe("2026-10-19 09:00");
    expect(slotName(latestSlot(["wed"], "13:00", wed)!)).toBe("2026-10-14 13:00");
  });

  it("finds the first slot after now", () => {
    const wed = new Date(2026, 9, 21, 12, 0);
    expect(slotName(nextSlot(["wed"], "13:00", wed)!)).toBe("2026-10-21 13:00");
    expect(slotName(nextSlot(["wed"], "09:00", wed)!)).toBe("2026-10-28 09:00");
    expect(slotName(nextSlot(["sat", "sun"], "09:00", wed)!)).toBe("2026-10-24 09:00");
  });
});

describe("scheduled runs (ADR 0064)", () => {
  it("starts a run once at its slot, with the budget and Flow the user set", async () => {
    const { svc, started } = service();
    const saved = svc.save(undefined, request({ flow: "task", budget: 2.5 }), user);
    expect(saved.next_at).not.toBeNull();

    clock.now = at(1, "09:02");
    await svc.tick();
    expect(started).toEqual([{ repo_path: "/work/widgets", prompt: "triage the failing tests", flow: "task", budget: 2.5 }]);
    expect(svc.list()[0]).toMatchObject({ last_outcome: "started", last_run_id: "run_1", last_slot: slotName(at(1, "09:00")) });
    const fired = store.events().find((e) => e.type === "schedule.fired")!;
    expect(fired.run_id).toBe("run_1");
    expect(fired.actor).toEqual({ kind: "system", component: "schedule" });

    // The same slot is never started twice, not even when the daemon looks again.
    clock.now = at(1, "09:20");
    await svc.tick();
    expect(started).toHaveLength(1);
  });

  it("skips a slot missed by more than the grace period instead of starting it late", async () => {
    const { svc, started } = service({ grace_minutes: 30 });
    svc.save(undefined, request(), user);
    clock.now = at(1, "11:00");
    await svc.tick();
    expect(started).toHaveLength(0);
    expect(svc.list()[0]).toMatchObject({ last_outcome: "missed", last_slot: slotName(at(1, "09:00")) });
    // And it did not leave a backlog: the next day's slot starts normally.
    clock.now = at(2, "09:01");
    await svc.tick();
    expect(started).toHaveLength(1);
  });

  it("never starts a slot from before the user saved it, nor one while paused", async () => {
    const { svc, started } = service();
    const s = svc.save(undefined, request({ at: "00:00" }), user);
    await svc.tick(); // today's 00:00 is before it was saved
    expect(started).toHaveLength(0);

    svc.setEnabled(s.id, false, user);
    clock.now = at(1, "00:03");
    await svc.tick();
    expect(started).toHaveLength(0);
    expect(svc.list()[0]!.next_at).toBeNull();

    // Resuming does not start the slot that passed while it was paused.
    svc.setEnabled(s.id, true, user);
    await svc.tick();
    expect(started).toHaveLength(0);
  });

  it("waits while the previous run of the schedule is unfinished", async () => {
    const run = { id: "run_live", name: "calm-ferry" } as RunView;
    const { svc, started } = service({}, async () => run);
    svc.save(undefined, request(), user);
    clock.now = at(1, "09:01");
    await svc.tick();
    expect(started).toHaveLength(1);
    store.append([
      {
        type: "run.created",
        run_id: "run_live",
        task_id: null,
        actor: user,
        payload: { name: "calm-ferry", repo_path: "/work/widgets", prompt: "x", budget: 1, base_commit: "abc", adapter: "claude-code", profile: "implementer", allow_commands: [] },
      },
    ]);
    clock.now = at(2, "09:01");
    await svc.tick();
    expect(started).toHaveLength(1);
    expect(svc.list()[0]).toMatchObject({ last_outcome: "still_running" });
  });

  it("stops at the daily limit", async () => {
    const { svc, started } = service({ daily_runs: 1 });
    svc.save(undefined, request({ name: "a" }), user);
    svc.save(undefined, request({ name: "b" }), user);
    clock.now = at(1, "09:01");
    await svc.tick();
    expect(started).toHaveLength(1);
    expect(svc.list().map((s) => s.last_outcome)).toEqual(["started", "daily_cap"]);
  });

  it("records a failed start and keeps going", async () => {
    const { svc } = service({}, async () => {
      throw new Error("push denied");
    });
    svc.save(undefined, request(), user);
    clock.now = at(1, "09:01");
    await svc.tick();
    expect(svc.list()[0]).toMatchObject({ last_outcome: "failed", last_message: "push denied" });
  });

  it("is the user's to set: not a phone, an agent or the daemon; and only prompt Flows", () => {
    const { svc } = service();
    const phone: Actor = { kind: "user", via: "mobile", device_id: "dev_1" };
    const agent: Actor = { kind: "agent", profile: "concierge", adapter: "native", model: "m" };
    for (const actor of [phone, agent, { kind: "system", component: "schedule" } as Actor]) {
      expect(() => svc.save(undefined, request(), actor)).toThrow(ScheduleError);
    }
    expect(() => svc.save(undefined, request({ flow: "fix-issue" }), user)).toThrow(/needs issue/);
    expect(() => svc.save(undefined, request({ flow: "compete" }), user)).toThrow(/parked/);
    expect(() => svc.save(undefined, request({ flow: "nope" }), user)).toThrow(/no Flow/);
    expect(() => svc.save(undefined, request({ project_id: "prj_x" }), user)).toThrow(/not found/);
  });

  it("removes a schedule and forgets it", () => {
    const { svc } = service();
    const s = svc.save(undefined, request(), user);
    svc.remove(s.id, user);
    expect(svc.list()).toEqual([]);
    expect(() => svc.remove(s.id, user)).toThrow(/not found/);
  });
});

describe("schedules API", () => {
  const daemons: Daemon[] = [];
  afterEach(async () => {
    for (const d of daemons.splice(0)) await d.stop().catch(() => {});
  });

  it("creates, lists, pauses and removes, and keeps a phone from setting them", async () => {
    const home = tempHome();
    const daemon = new Daemon({
      home,
      config: Config.parse({ daemon: { port: 0, remote: { url: "https://pc.tail1234.ts.net", tailscale_command: "/nonexistent/tailscale" } }, routing: { enabled: false }, inbox: { poll_minutes: 0 } }),
      adapters: { "claude-code": fakeClaude("edit").options },
    });
    await daemon.start();
    daemons.push(daemon);
    const token = readFileSync(join(home, "token"), "utf8").trim();
    const call = async <T>(bearer: string | undefined, method: string, path: string, body?: unknown) => {
      const res = await fetch(daemon.url + path, {
        method,
        headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
    };
    const repo = makeRepo();
    execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], { cwd: repo });
    const project = await call<{ project: { id: string } }>(token, "POST", "/api/v1/projects", { path: repo });
    const projectId = project.body.project?.id ?? (project.body as unknown as { id: string }).id;

    const bad = await call(token, "POST", "/api/v1/schedules", { name: "x", project_id: projectId, prompt: "do it", budget: 1, at: "25:00", days: ["mon"] });
    expect(bad.status).toBe(400);
    const made = await call<ScheduleView>(token, "POST", "/api/v1/schedules", { name: "nightly", project_id: projectId, prompt: "triage the failing tests", budget: 1, at: "03:00", days: ["mon", "tue"] });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({ name: "nightly", enabled: true, days: ["mon", "tue"], last_outcome: null });

    const pairing = (await call<{ code: string }>(token, "POST", "/api/v1/devices/pairings")).body;
    const session = (await call<{ access_token: string }>(undefined, "POST", "/api/v1/devices/pair", { code: pairing.code, name: "Pixel" })).body;
    expect((await call<ScheduleView[]>(session.access_token, "GET", "/api/v1/schedules")).body).toHaveLength(1);
    expect((await call(session.access_token, "POST", "/api/v1/schedules", { name: "x", project_id: projectId, prompt: "do it", budget: 1, at: "03:00", days: ["mon"] })).status).toBe(403);
    expect((await call(session.access_token, "DELETE", `/api/v1/schedules/${made.body.id}`)).status).toBe(403);

    const paused = await call<ScheduleView>(token, "PUT", `/api/v1/schedules/${made.body.id}/enabled`, { enabled: false });
    expect(paused.body).toMatchObject({ enabled: false, next_at: null });
    expect((await call(token, "DELETE", `/api/v1/schedules/${made.body.id}`)).status).toBe(204);
    expect((await call<ScheduleView[]>(token, "GET", "/api/v1/schedules")).body).toEqual([]);
  });
});
