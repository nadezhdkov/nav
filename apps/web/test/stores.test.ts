import type { NavarchEvent } from "@navarch/contracts";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  runs: vi.fn(),
  run: vi.fn(),
  runEvents: vi.fn(),
  approvals: vi.fn(),
  decide: vi.fn(),
}));
vi.mock("../src/api/client.ts", () => ({ api }));

const { useApprovalsStore, useRunStore, useRunsStore } = await import("../src/stores/runs.ts");

function event(seq: number, type: string, run_id: string | null = "run_1", payload: object = {}): NavarchEvent {
  return {
    id: `evt_${seq}`,
    seq,
    ts: "2026-10-15T00:00:00Z",
    type,
    run_id,
    task_id: null,
    actor: { kind: "system", component: "test" },
    payload,
    schema_version: 1,
  } as NavarchEvent;
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
  for (const fn of Object.values(api)) fn.mockReset();
});

describe("runs store", () => {
  it("refetches the list once after a burst of run events, and ignores unrelated ones", async () => {
    api.runs.mockResolvedValue([]);
    const store = useRunsStore();
    store.apply(event(1, "run.status_changed"));
    store.apply(event(2, "task.completed"));
    store.apply(event(3, "quota.observed"));
    await vi.runAllTimersAsync();
    expect(api.runs).toHaveBeenCalledTimes(1);
  });
});

describe("run store", () => {
  it("loads the detail and events, then asks only for events after the last seq", async () => {
    api.run.mockResolvedValue({ id: "run_1", tasks: [] });
    api.runEvents.mockResolvedValueOnce([event(4, "run.created"), event(9, "flow.node.skipped", "run_1", { node_id: "x" })]);
    const store = useRunStore();
    await store.load("run_1");
    expect(store.events.map((e) => e.seq)).toEqual([4, 9]);
    expect(store.skipped).toEqual(["x"]);

    api.runEvents.mockResolvedValueOnce([event(9, "flow.node.skipped"), event(12, "task.created")]);
    store.apply(event(12, "task.created"));
    store.apply(event(13, "task.created", "run_other"));
    await vi.runAllTimersAsync();
    expect(api.runEvents).toHaveBeenLastCalledWith("run_1", 9);
    expect(store.events.map((e) => e.seq)).toEqual([4, 9, 12]);
  });

  it("keeps a bounded log tail for the open run only", async () => {
    api.run.mockResolvedValue({ id: "run_1", tasks: [] });
    api.runEvents.mockResolvedValue([]);
    const store = useRunStore();
    await store.load("run_1");
    store.applyLog("run_1", "task_1", "hello");
    store.applyLog("run_2", "task_9", "elsewhere");
    expect(store.logs).toEqual([{ task_id: "task_1", line: "hello" }]);
  });
});

describe("approvals store", () => {
  it("counts pending approvals and reloads after a decision", async () => {
    api.approvals.mockResolvedValueOnce([
      { id: "apr_1", status: "pending" },
      { id: "apr_2", status: "approved" },
    ]);
    const store = useApprovalsStore();
    await store.load();
    expect(store.pending.map((a) => a.id)).toEqual(["apr_1"]);

    api.decide.mockResolvedValue({});
    api.approvals.mockResolvedValueOnce([{ id: "apr_1", status: "approved" }]);
    await store.decide("apr_1", "approve", "looks right");
    expect(api.decide).toHaveBeenCalledWith("apr_1", "approve", "looks right");
    expect(store.pending).toEqual([]);
  });
});
