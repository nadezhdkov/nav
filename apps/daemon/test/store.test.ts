import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Actor, NewEvent } from "@navarch/contracts";
import { parseFlow } from "@navarch/flow-engine";
import { describe, expect, it } from "vitest";
import { tempHome } from "../../../packages/runner/test/helpers.ts";
import { codename } from "../src/orchestrator/names.ts";
import { EventStore } from "../src/events/store.ts";

const user: Actor = { kind: "user", via: "cli" };

function seed(store: EventStore): void {
  const events: NewEvent[] = [
    {
      type: "run.created",
      run_id: "run_1",
      task_id: null,
      actor: user,
      payload: {
        repo_path: "/repo",
        base_commit: "abc",
        prompt: "do it",
        budget: 2,
        adapter: "claude-code",
        profile: "implementer",
        allow_commands: [],
      },
    },
    {
      type: "task.created",
      run_id: "run_1",
      task_id: "task_1",
      actor: user,
      payload: { node_id: "implement", type: "agent", profile: "implementer", adapter: "claude-code", max_attempts: 3 },
    },
    {
      type: "task.status_changed",
      run_id: "run_1",
      task_id: "task_1",
      actor: user,
      payload: { from: "pending", to: "ready", attempt: 0 },
    },
    {
      type: "model.call.completed",
      run_id: "run_1",
      task_id: "task_1",
      actor: user,
      payload: { model: "m", tokens_in: 1, tokens_out: 1, cached_tokens: 0, cost: 0.25 },
    },
  ];
  store.append(events);
}

describe("EventStore", () => {
  it("assigns increasing seq numbers and updates projections", () => {
    const store = new EventStore(join(tempHome(), "navarch.db"));
    seed(store);
    const events = store.events();
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(store.getRun("run_1")).toMatchObject({ status: "created", cost_total: 0.25 });
    expect(store.tasksOfRun("run_1")[0]).toMatchObject({ status: "ready", cost: 0.25 });
  });

  it("rejects an invalid transition and writes nothing from that batch", () => {
    const store = new EventStore(join(tempHome(), "navarch.db"));
    seed(store);
    expect(() =>
      store.append([
        { type: "run.status_changed", run_id: "run_1", task_id: null, actor: user, payload: { from: "created", to: "executing" } },
        { type: "task.status_changed", run_id: "run_1", task_id: "task_1", actor: user, payload: { from: "ready", to: "succeeded", attempt: 1 } },
      ]),
    ).toThrow(/invalid task transition/);
    expect(store.events()).toHaveLength(4);
    expect(store.getRun("run_1")?.status).toBe("created");
  });

  it("refuses to update or delete events", () => {
    const store = new EventStore(join(tempHome(), "navarch.db"));
    seed(store);
    expect(() => store.db.exec("UPDATE events SET type = 'x'")).toThrow(/append-only/);
    expect(() => store.db.exec("DELETE FROM events")).toThrow(/append-only/);
  });

  it("rebuilds identical projections from the log", () => {
    const store = new EventStore(join(tempHome(), "navarch.db"));
    seed(store);
    const before = { run: store.getRun("run_1"), tasks: store.tasksOfRun("run_1") };
    store.rebuildProjections();
    expect({ run: store.getRun("run_1"), tasks: store.tasksOfRun("run_1") }).toEqual(before);
  });

  it("rebuilds projections from the log when an older database lacks a new column", () => {
    const path = join(tempHome(), "navarch.db");
    const old = new EventStore(path);
    seed(old);
    old.db.exec("ALTER TABLE tasks DROP COLUMN not_before");
    old.close();

    const store = new EventStore(path);
    expect(store.tasksOfRun("run_1")).toEqual([expect.objectContaining({ id: "task_1", status: "ready", not_before: null })]);
    store.close();
  });

  it("opens a database from before run names and names its runs from their ids (ADR 0027)", () => {
    const path = join(tempHome(), "navarch.db");
    const old = new EventStore(path);
    seed(old);
    old.db.exec("DROP INDEX runs_name; ALTER TABLE runs DROP COLUMN name");
    old.close();

    const store = new EventStore(path);
    expect(store.getRun("run_1")?.name).toBe(codename("run_1"));
    expect(store.runIdByName(codename("run_1"))).toBe("run_1");
    store.close();
  });

  it("publishes to subscribers only after commit", () => {
    const store = new EventStore(join(tempHome(), "navarch.db"));
    const seen: number[] = [];
    store.subscribe((e) => seen.push(e.seq));
    seed(store);
    expect(seen).toEqual([1, 2, 3, 4]);
  });
});

describe("fleet tree data (slice 10)", () => {
  const fixIssue = parseFlow(readFileSync(fileURLToPath(new URL("../../../flows/fix-issue.yaml", import.meta.url)), "utf8"));
  const base = { base_commit: "abc", prompt: "p", budget: 2, adapter: "claude-code", profile: "implementer", allow_commands: [] };

  function task(runId: string, id: string, node: string, to: ("ready" | "running" | "succeeded")[]): NewEvent[] {
    const steps: NewEvent[] = [
      { type: "task.created", run_id: runId, task_id: id, actor: user, payload: { node_id: node, type: "agent", profile: "planner", adapter: "claude-code", max_attempts: 3 } },
    ];
    let from = "pending";
    for (const status of to) {
      steps.push({ type: "task.status_changed", run_id: runId, task_id: id, actor: user, payload: { from, to: status, attempt: status === "running" ? 1 : 0 } } as NewEvent);
      from = status;
    }
    return steps;
  }

  it("gives each run its step progress and registered project", () => {
    const store = new EventStore(join(tempHome(), "navarch.db"));
    store.append([
      { type: "project.added", run_id: null, task_id: null, actor: user, payload: { project_id: "prj_1", name: "app", repo: "o/app", path: "/work/app" } },
      { type: "run.created", run_id: "run_f", task_id: null, actor: user, payload: { ...base, repo_path: "/work/app", flow: { definition: fixIssue, params: { max_fix_iterations: 3 } } } },
      ...task("run_f", "t_triage", "triage", ["ready", "running", "succeeded"]),
      ...task("run_f", "t_plan", "plan", ["ready", "running", "succeeded"]),
      { type: "flow.node.skipped", run_id: "run_f", task_id: null, actor: user, payload: { node_id: "approve_plan", reason: "level 3" } },
      ...task("run_f", "t_impl", "implement", ["ready", "running"]),
      { type: "run.created", run_id: "run_old", task_id: null, actor: user, payload: { ...base, repo_path: "/elsewhere" } },
    ] as NewEvent[]);
    const runs = new Map(store.fleet("active", () => true).runs.map((r) => [r.id, r]));
    expect(runs.get("run_f")).toMatchObject({ progress: { done: 3, total: 7 }, project_id: "prj_1" });
    expect(runs.get("run_old")).toMatchObject({ progress: null, project_id: null });
    store.close();
  });
});
