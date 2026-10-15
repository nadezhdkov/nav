import type { FleetAgent, FleetView, NavarchEvent, RunMessage } from "@navarch/contracts";
import { flushPromises, mount, RouterLinkStub } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../src/i18n.ts";
import { buildThread } from "../src/lib/fleet.ts";

const api = vi.hoisted(() => ({
  fleet: vi.fn(),
  runEvents: vi.fn(),
  messages: vi.fn(),
  run: vi.fn(),
  taskLogs: vi.fn(),
  sendMessage: vi.fn(),
}));
vi.mock("../src/api/client.ts", async (orig) => ({ ...(await orig<object>()), api }));

const { default: FleetPage } = await import("../src/views/FleetView.vue");
const { default: InstructionBox } = await import("../src/components/InstructionBox.vue");
const { useFleetStore } = await import("../src/stores/runs.ts");

function agent(over: Partial<FleetAgent> = {}): FleetAgent {
  return {
    id: "task_impl",
    run_id: "run_1",
    node_id: "implement",
    type: "agent",
    status: "running",
    attempt: 1,
    max_attempts: 3,
    profile: "implementer",
    adapter: "claude-code",
    model: "sonnet",
    sandbox_path: "/home/me/.navarch/worktrees/widget/run_1-task",
    branch: "navarch/run_1/task",
    cost: 0.12,
    summary: null,
    error: null,
    not_before: null,
    updated_at: "2026-10-15T01:00:00Z",
    iteration: 1,
    last_activity: { text: "Editing src/hello.ts", tool: "Edit", ts: "2026-10-15T01:00:00Z" },
    waiting: null,
    resumable: true,
    pending_messages: 0,
    ...over,
  };
}

const view: FleetView = {
  generated_at: "2026-10-15T01:00:01Z",
  counts: { running: 1, waiting: 1, failed: 0, done: 0 },
  runs: [
    {
      id: "run_1",
      status: "executing",
      repo_path: "/home/me/src/widget",
      base_commit: "abc",
      prompt: "Add a greeting",
      budget: 2,
      cost_total: 0.12,
      created_at: "2026-10-15T00:59:00Z",
      updated_at: "2026-10-15T01:00:00Z",
      ended_at: null,
      work_item: null,
      pr_url: null,
      flow: "task",
      autonomy_level: 2,
      agents: [
        agent(),
        agent({ id: "task_rev", node_id: "review", profile: "reviewer", status: "waiting_approval", waiting: { kind: "approval" }, last_activity: null }),
      ],
    },
  ],
};

const global = { plugins: [i18n], stubs: { RouterLink: RouterLinkStub } };

beforeEach(() => {
  setActivePinia(createPinia());
  for (const fn of Object.values(api)) fn.mockReset();
  api.runEvents.mockResolvedValue([]);
  api.messages.mockResolvedValue([]);
  api.run.mockResolvedValue({ artifacts: [] });
});

describe("Fleet view", () => {
  it("groups agents by run, each with status as icon plus text, model, branch and latest activity", async () => {
    api.fleet.mockResolvedValue(view);
    const page = mount(FleetPage, { global });
    await flushPromises();
    expect(api.fleet).toHaveBeenCalledWith("active");
    const text = page.text();
    expect(text).toContain("Add a greeting");
    expect(text).toContain("1running");
    const cards = page.findAll("button[aria-pressed]");
    expect(cards).toHaveLength(2);
    expect(cards[0]!.text()).toContain("Running");
    expect(cards[0]!.find("svg").exists()).toBe(true);
    expect(cards[0]!.text()).toContain("claude-code · sonnet");
    expect(cards[0]!.text()).toContain("navarch/…/task");
    expect(cards[0]!.text()).toContain("Edit · Editing src/hello.ts");
    expect(cards[1]!.text()).toContain("Waiting for approval");
  });

  it("opens an agent's panel with its activity and an instruction box, and switches the time span", async () => {
    api.fleet.mockResolvedValue(view);
    const page = mount(FleetPage, { global });
    await flushPromises();
    await page.findAll("button[aria-pressed]")[0]!.trigger("click");
    await flushPromises();
    expect(page.find("aside").exists()).toBe(true);
    expect(page.find("aside textarea").exists()).toBe(true);
    expect(api.runEvents).toHaveBeenCalledWith("run_1");

    await page.findAll('[role="radio"]').find((b) => b.text() === "Last 24 h")!.trigger("click");
    expect(api.fleet).toHaveBeenLastCalledWith("24h");
  });

  it("refetches when the stream reports task changes, not for unrelated events", () => {
    vi.useFakeTimers();
    api.fleet.mockResolvedValue(view);
    const store = useFleetStore();
    store.apply({ type: "concierge.message" } as NavarchEvent);
    vi.advanceTimersByTime(300);
    expect(api.fleet).not.toHaveBeenCalled();
    store.apply({ type: "task.progress" } as NavarchEvent);
    vi.advanceTimersByTime(300);
    expect(api.fleet).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe("InstructionBox", () => {
  it("sends for the next turn by default", async () => {
    api.sendMessage.mockResolvedValue({ id: "msg_1" });
    const box = mount(InstructionBox, { global, props: { runId: "run_1", agent: agent() } });
    await box.find("textarea").setValue("use pnpm");
    await box.find("form").trigger("submit");
    await flushPromises();
    expect(api.sendMessage).toHaveBeenCalledWith("run_1", { text: "use pnpm", delivery: "next", task_id: "task_impl" });
    expect(box.text()).toContain("Sent.");
  });

  it("offers interrupting only a running agent that can resume, and says what it does", async () => {
    const box = mount(InstructionBox, { global, props: { runId: "run_1", agent: agent({ resumable: false }) } });
    const [, now] = box.findAll('input[type="radio"]');
    expect(now!.attributes("disabled")).toBeDefined();

    await box.setProps({ agent: agent() });
    expect(now!.attributes("disabled")).toBeUndefined();
    await now!.setValue(true);
    expect(box.text()).toContain("Stops implement and resumes it with your message");
    api.sendMessage.mockResolvedValue({ id: "msg_2" });
    await box.find("textarea").setValue("stop and add tests");
    await box.find("form").trigger("submit");
    await flushPromises();
    expect(api.sendMessage).toHaveBeenCalledWith("run_1", { text: "stop and add tests", delivery: "now", task_id: "task_impl" });
  });
});

describe("buildThread", () => {
  const progress = (id: string, task: string, ts: string, message: string) =>
    ({ id, type: "task.progress", task_id: task, ts, payload: { message } }) as unknown as NavarchEvent;
  const message = (over: Partial<RunMessage>): RunMessage => ({
    id: "msg",
    run_id: "run_1",
    text: "hi",
    task_id: null,
    delivery: "next",
    created_at: "2026-10-15T01:00:01Z",
    delivered: null,
    ...over,
  });

  it("merges the agent's progress and the instructions meant for it, in time order", () => {
    const thread = buildThread(
      [progress("e1", "task_impl", "2026-10-15T01:00:00Z", "reading"), progress("e2", "task_other", "2026-10-15T01:00:00Z", "not mine"), progress("e3", "task_impl", "2026-10-15T01:00:02Z", "editing")],
      [
        message({ id: "m1" }),
        message({ id: "m2", delivered: { task_id: "task_other", attempt: 1, at: "2026-10-15T01:00:03Z" } }),
        message({ id: "m3", task_id: "task_impl", delivery: "now", created_at: "2026-10-15T01:00:04Z", delivered: { task_id: "task_impl", attempt: 2, at: "2026-10-15T01:00:05Z" } }),
      ],
      { id: "task_impl", status: "running" },
      true,
    );
    expect(thread.map((i) => i.id)).toEqual(["e1", "m1", "e3", "m3"]);
    expect(thread[3]).toMatchObject({ kind: "message", delivery: "now", delivered: true });
  });

  it("leaves waiting run-wide instructions off agents that ended", () => {
    expect(buildThread([], [message({})], { id: "task_done", status: "succeeded" }, false)).toEqual([]);
  });
});
