import type { FleetAgent, FleetRun, NavarchEvent, RunMessage, TaskView, TeamView } from "@navarch/contracts";
import { flushPromises, mount, RouterLinkStub } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import { i18n } from "../src/i18n.ts";
import { buildLeadThread, buildThread } from "../src/lib/fleet.ts";
import { agentNodeId, buildFleetTree, TREE_ACTIONS } from "../src/lib/fleetTree.ts";

const api = vi.hoisted(() => ({ sendMessage: vi.fn(), runEvents: vi.fn(), messages: vi.fn(), run: vi.fn(), taskLogs: vi.fn(), worktree: vi.fn(), worktreeDiff: vi.fn(), artifact: vi.fn() }));
vi.mock("../src/api/client.ts", async (orig) => ({ ...(await orig<object>()), api }));
vi.mock("@vue-flow/core", async (orig) => ({ ...(await orig<object>()), Handle: { template: "<i />" } }));

const { default: FleetTreeNode } = await import("../src/components/FleetTreeNode.vue");
const { default: AgentPanel } = await import("../src/components/AgentPanel.vue");

function agent(over: Partial<FleetAgent> = {}): FleetAgent {
  return {
    id: "task_impl", run_id: "run_1", node_id: "implement", type: "agent", status: "running", attempt: 1, max_attempts: 3,
    profile: "implementer", adapter: "claude-code", model: "sonnet", sandbox_path: "/w", branch: "navarch/run_1/task", cost: 0.1, plan_cost: 0, summary: null,
    error: null, not_before: null, updated_at: "2026-10-15T01:00:00Z", iteration: 1, last_activity: null, waiting: null, resumable: true,
    pending_messages: 1, team_role: null, team_key: null, ...over,
  };
}
function run(over: Partial<FleetRun> = {}): FleetRun {
  return {
    id: "run_1", name: "brave-frigate", status: "executing", repo_path: "/src/app", base_commit: "abc", prompt: "Add a greeting", budget: 2, cost_total: 0.1, plan_cost: 0,
    created_at: "2026-10-15T00:00:00Z", updated_at: "2026-10-15T00:00:00Z", ended_at: null, work_item: null, pr_url: null,
    flow: "task", autonomy_level: 2, team: null, progress: { done: 3, total: 7 }, project_id: null, agents: [agent()], ...over,
  };
}
const global = { plugins: [i18n], stubs: { RouterLink: RouterLinkStub } };
const ev = (type: string, task_id: string, ts: string, payload: object): NavarchEvent => ({ id: `e_${ts}`, seq: 1, ts, type, run_id: "run_1", task_id, actor: { kind: "system", component: "t" }, payload }) as unknown as NavarchEvent;

beforeEach(() => {
  setActivePinia(createPinia());
  vi.resetAllMocks();
  api.runEvents.mockResolvedValue([]);
  api.messages.mockResolvedValue([]);
  api.run.mockResolvedValue({ artifacts: [], tasks: [] });
});

function mountNode(id: string, r = run()) {
  const tree = buildFleetTree({ generated_at: "x", counts: { running: 0, waiting: 0, failed: 0, done: 0 }, runs: [r] }, []);
  const data = tree.nodes.find((n) => n.id === id)!;
  const actions = { focused: ref(null), selected: ref(null), toggle: vi.fn(), open: vi.fn(), sentSince: vi.fn(() => 0), sent: vi.fn() };
  return { node: mount(FleetTreeNode, { props: { data }, global: { ...global, provide: { [TREE_ACTIONS as symbol]: actions } } }), actions };
}

describe("tree nodes (slice 10)", () => {
  it("sends a card's message to its task for the next turn and counts it on the badge", async () => {
    api.sendMessage.mockResolvedValue({ id: "msg_1" });
    const { node, actions } = mountNode(agentNodeId("run_1", "implement"));
    expect(node.text()).toContain("Running");
    expect(node.find('[title="1 instruction(s) waiting"]').exists()).toBe(true);
    await node.find("input").setValue("use pnpm");
    await node.find("form").trigger("submit");
    await flushPromises();
    expect(api.sendMessage).toHaveBeenCalledWith("run_1", { text: "use pnpm", delivery: "next", task_id: "task_impl" });
    expect(actions.sent).toHaveBeenCalledWith("task_impl");
    expect(actions.open).not.toHaveBeenCalled();
    await node.trigger("click");
    expect(actions.open).toHaveBeenCalledWith("run_1", "implement");
  });

  it("has no prompt box once the run ended, and shows step progress on the run", () => {
    const { node } = mountNode(agentNodeId("run_1", "implement"), run({ status: "done" }));
    expect(node.find("input").exists()).toBe(false);
    const runNode = mountNode("run:run_1").node;
    expect(runNode.text()).toContain("3 of 7 steps");
    expect(runNode.find("button[aria-expanded]").attributes("aria-expanded")).toBe("true");
  });
});

describe("Chat threads (slice 10)", () => {
  it("ends an agent's thread with its result", () => {
    const items = buildThread([ev("task.progress", "task_impl", "1", { message: "editing" }), ev("task.completed", "task_impl", "2", { status: "succeeded", summary: "Added hello.ts" })], [], agent(), false);
    expect(items.map((i) => i.kind)).toEqual(["progress", "result"]);
  });

  it("joins every lead turn, the members each added, the question and the user's instructions to the run", () => {
    const team: TeamView = {
      node_id: "team", turn: 2, max_turns: 8, lead_task_id: "lead_2", question: "Which database?", summary: null, plan_errors: [],
      members: [{ key: "api", title: "API", profile: "implementer", prefer: null, depends_on: [], turn: 1, task_id: "m1", status: "succeeded", summary: "ok", merge: null, branch: null }],
      subagents: [],
    };
    const tasks = [{ id: "lead_1", node_id: "team.lead", iteration: 1 }, { id: "lead_2", node_id: "team.lead", iteration: 2 }, { id: "m1", node_id: "team.api", iteration: 1 }] as TaskView[];
    const events = [
      ev("task.completed", "lead_1", "1", { status: "succeeded", summary: "Split it.\n```navarch-team\n{}\n```" }),
      ev("task.progress", "m1", "2", { message: "member work" }),
      ev("task.completed", "lead_2", "4", { status: "succeeded", summary: "Need input." }),
    ];
    const messages = [{ id: "msg", run_id: "run_1", text: "go", task_id: null, delivery: "next", created_at: "3", delivered: { task_id: "lead_2", attempt: 1, at: "3" } }] as RunMessage[];
    const items = buildLeadThread(events, messages, tasks, team);
    expect(items.map((i) => i.kind)).toEqual(["result", "members", "message", "result", "question"]);
    expect(items[0]).toMatchObject({ text: "Split it.", turn: 1 });
  });
});

describe("Worktree tab (slice 10)", () => {
  it("lists the changed files with their lines and shows one file's diff", async () => {
    api.worktree.mockResolvedValue({
      run_id: "run_1", branch: "navarch/run_1/task", path: "/w", base_commit: "abc", exists: true,
      files: [{ path: "src/hello.ts", status: "added", added: 3, removed: 0 }, { path: "logo.png", status: "untracked", added: null, removed: null }],
      totals: { files: 2, added: 3, removed: 0 },
    });
    api.worktreeDiff.mockResolvedValue("+export const hello = 1;");
    const panel = mount(AgentPanel, { props: { agent: agent(), run: run(), version: "1" }, global });
    await flushPromises();
    await panel.findAll('[role="tab"]').find((b) => b.text() === "Worktree")!.trigger("click");
    await flushPromises();
    expect(api.worktree).toHaveBeenCalledWith("run_1", "task_impl");
    expect(panel.text()).toContain("2 changed file(s)");
    expect(panel.text()).toContain("binary");
    await panel.findAll("button[aria-expanded]").find((b) => b.text().includes("src/hello.ts"))!.trigger("click");
    await flushPromises();
    expect(api.worktreeDiff).toHaveBeenCalledWith("run_1", "src/hello.ts", "task_impl");
    expect(panel.text()).toContain("+export const hello = 1;");
  });

  it("says when there is no worktree", async () => {
    api.worktree.mockResolvedValue({ run_id: "run_1", branch: null, path: null, base_commit: "abc", exists: false, files: [], totals: { files: 0, added: 0, removed: 0 } });
    const panel = mount(AgentPanel, { props: { agent: agent(), run: run(), version: "1" }, global });
    await panel.findAll('[role="tab"]').find((b) => b.text() === "Worktree")!.trigger("click");
    await flushPromises();
    expect(panel.text()).toContain("No worktree yet.");
  });
});
