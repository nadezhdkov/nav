import { join } from "node:path";
import type { Actor, NewEvent } from "@vectr/contracts";
import { describe, expect, it } from "vitest";
import { tempHome } from "../../../packages/runner/test/helpers.ts";
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
    const store = new EventStore(join(tempHome(), "vectr.db"));
    seed(store);
    const events = store.events();
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(store.getRun("run_1")).toMatchObject({ status: "created", cost_total: 0.25 });
    expect(store.tasksOfRun("run_1")[0]).toMatchObject({ status: "ready", cost: 0.25 });
  });

  it("rejects an invalid transition and writes nothing from that batch", () => {
    const store = new EventStore(join(tempHome(), "vectr.db"));
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
    const store = new EventStore(join(tempHome(), "vectr.db"));
    seed(store);
    expect(() => store.db.exec("UPDATE events SET type = 'x'")).toThrow(/append-only/);
    expect(() => store.db.exec("DELETE FROM events")).toThrow(/append-only/);
  });

  it("rebuilds identical projections from the log", () => {
    const store = new EventStore(join(tempHome(), "vectr.db"));
    seed(store);
    const before = { run: store.getRun("run_1"), tasks: store.tasksOfRun("run_1") };
    store.rebuildProjections();
    expect({ run: store.getRun("run_1"), tasks: store.tasksOfRun("run_1") }).toEqual(before);
  });

  it("publishes to subscribers only after commit", () => {
    const store = new EventStore(join(tempHome(), "vectr.db"));
    const seen: number[] = [];
    store.subscribe((e) => seen.push(e.seq));
    seed(store);
    expect(seen).toEqual([1, 2, 3, 4]);
  });
});
