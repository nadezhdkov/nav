import { join } from "node:path";
import type { Actor, NewEvent } from "@navarch/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempHome } from "../../../packages/runner/test/helpers.ts";
import { Config } from "../src/config.ts";
import { EventStore } from "../src/events/store.ts";
import { AutoMerger, githubReason, sensitiveFile } from "../src/github/automerge.ts";
import type { MergeFacts } from "../src/github/integration.ts";
import { PolicyEngine } from "../src/policy/engine.ts";

const user: Actor = { kind: "user", via: "cli" };
const phone: Actor = { kind: "user", via: "mobile", device_id: "dev_1" };
const agent: Actor = { kind: "agent", profile: "implementer", adapter: "claude-code" };
const sys: Actor = { kind: "system", component: "test" };
const policy = new PolicyEngine();

describe("policy for auto-merge", () => {
  const merge = (actor: Actor, context: Parameters<PolicyEngine["decide"]>[3]) => policy.decide(actor, "github.pr.merge", "o/r#1", context).effect;
  const automerge: Actor = { kind: "system", component: "automerge" };

  it("lets only the user, from the desktop or CLI, change the setting", () => {
    expect(policy.decide(user, "automerge.set", "prj", { autonomyLevel: 3 }).effect).toBe("allow");
    expect(policy.decide({ kind: "user", via: "web" }, "automerge.set", "prj", { autonomyLevel: 3 }).effect).toBe("allow");
    expect(policy.decide(phone, "automerge.set", "prj", { autonomyLevel: 3 }).effect).toBe("deny");
    expect(policy.decide(agent, "automerge.set", "prj", { autonomyLevel: 3 }).effect).toBe("deny");
    expect(policy.decide(sys, "automerge.set", "prj", { autonomyLevel: 3 }).effect).toBe("deny");
  });

  it("merges without approval only for the auto-merger, when enabled, at level 3 or higher", () => {
    expect(merge(automerge, { autonomyLevel: 3, autoMerge: { enabled: true } })).toBe("allow");
    expect(merge(automerge, { autonomyLevel: 2, autoMerge: { enabled: true } })).toBe("require_approval");
    expect(merge(automerge, { autonomyLevel: 3, autoMerge: { enabled: false } })).toBe("require_approval");
    expect(merge(automerge, { autonomyLevel: 3 })).toBe("require_approval");
    expect(merge(agent, { autonomyLevel: 4, autoMerge: { enabled: true } })).toBe("require_approval");
    expect(merge({ kind: "system", component: "github" }, { autonomyLevel: 4, autoMerge: { enabled: true } })).toBe("require_approval");
  });
});

describe("what stops a merge", () => {
  it("flags dependency manifests, lockfiles, workflows and protected paths", () => {
    expect(sensitiveFile("package.json", [])).toBeDefined();
    expect(sensitiveFile("apps/web/pnpm-lock.yaml", [])).toBeDefined();
    expect(sensitiveFile("requirements-dev.txt", [])).toBeDefined();
    expect(sensitiveFile(".github/workflows/ci.yml", [])).toBeDefined();
    expect(sensitiveFile("src/secrets/key.ts", ["src/secrets/**"])).toBeDefined();
    expect(sensitiveFile("src/index.ts", ["src/secrets/**"])).toBeUndefined();
    expect(sensitiveFile("docs/package.json.md", [])).toBeUndefined();
  });

  const good: MergeFacts = {
    state: "open", merged: false, draft: true, head_sha: "abc", head_ref: "navarch/run_1/task", head_repo: "o/r", base_ref: "main", node_id: "PR_1", title: "fix: x",
    default_branch: "main", base_protected: false, files: ["src/a.ts"], files_truncated: false, checks: { total: 2, pending: 0, notGreen: [] },
  };
  const pr = { branch: "navarch/run_1/task", repo: "O/R" };
  const reason = (over: Partial<MergeFacts>) => githubReason({ ...good, ...over }, pr, "abc", []);

  it("accepts a clean pull request and names each reason otherwise", () => {
    expect(reason({})).toBeUndefined();
    expect(reason({ head_sha: "def" })).toMatch(/not the commit Navarch pushed/);
    expect(reason({ head_repo: "x/fork" })).toMatch(/fork/);
    expect(reason({ base_ref: "dev" })).toMatch(/not the default branch/);
    expect(reason({ base_protected: true })).toMatch(/protected/);
    expect(reason({ files: ["package.json"] })).toMatch(/dependency/);
    expect(reason({ files_truncated: true })).toMatch(/too many files/);
    expect(reason({ checks: { total: 0, pending: 0, notGreen: [] } })).toMatch(/no check runs/);
    expect(reason({ checks: { total: 2, pending: 1, notGreen: [] } })).toMatch(/still running/);
    expect(reason({ checks: { total: 2, pending: 0, notGreen: ["lint"] } })).toMatch(/not green: lint/);
    expect(reason({ state: "closed" })).toMatch(/no longer open/);
  });
});

describe("the auto-merger", () => {
  let store: EventStore;
  beforeEach(() => {
    store = new EventStore(join(tempHome(), "navarch.db"));
  });
  afterEach(() => store.close());

  const facts: MergeFacts = {
    state: "open", merged: false, draft: true, head_sha: "abc123", head_ref: "navarch/run_1/fix", head_repo: "o/r", base_ref: "main", node_id: "PR_1", title: "fix: x",
    default_branch: "main", base_protected: false, files: ["src/a.ts"], files_truncated: false, checks: { total: 1, pending: 0, notGreen: [] },
  };

  /** A project with a run whose PR is open and whose checks, review and push all say "merge". */
  function scene(over: { review?: Record<string, unknown> | null; verifyPassed?: boolean; level?: number } = {}) {
    const events: NewEvent[] = [
      { type: "project.added", run_id: null, task_id: null, actor: user, payload: { project_id: "prj_1", name: "r", repo: "o/r", path: "/nonexistent" } },
      {
        type: "run.created", run_id: "run_1", task_id: null, actor: user,
        payload: { repo_path: "/nonexistent", base_commit: "b", prompt: "fix", budget: 2, adapter: "claude-code", profile: "implementer", allow_commands: [], autonomy_level: over.level ?? 3 },
      },
      { type: "github.push", run_id: "run_1", task_id: null, actor: sys, payload: { repo: "o/r", branch: "navarch/run_1/fix", commit: "abc123" } },
      { type: "verification.completed", run_id: "run_1", task_id: null, actor: sys, payload: { checks: [{ name: "t", command: "make test", exit_code: 0, duration_ms: 1, required: true, output_tail: "" }], passed: over.verifyPassed ?? true, blocking_failures: [], warnings: [], artifact_id: "art_1" } },
      { type: "github.pr.opened", run_id: "run_1", task_id: null, actor: sys, payload: { repo: "o/r", number: 7, url: "https://github.com/o/r/pull/7", branch: "navarch/run_1/fix", draft: true } },
      { type: "run.status_changed", run_id: "run_1", task_id: null, actor: sys, payload: { from: "created", to: "reviewing" } },
      { type: "run.status_changed", run_id: "run_1", task_id: null, actor: sys, payload: { from: "reviewing", to: "pr_opened" } },
    ] as NewEvent[];
    if (over.review !== null) {
      events.push(
        { type: "task.created", run_id: "run_1", task_id: "task_r", actor: sys, payload: { node_id: "review", type: "agent", profile: "reviewer", adapter: "codex", max_attempts: 1 } } as NewEvent,
        { type: "task.status_changed", run_id: "run_1", task_id: "task_r", actor: sys, payload: { from: "pending", to: "ready", attempt: 0 } } as NewEvent,
        { type: "task.status_changed", run_id: "run_1", task_id: "task_r", actor: sys, payload: { from: "ready", to: "running", attempt: 1 } } as NewEvent,
        { type: "task.status_changed", run_id: "run_1", task_id: "task_r", actor: sys, payload: { from: "running", to: "succeeded", attempt: 1 } } as NewEvent,
        { type: "task.completed", run_id: "run_1", task_id: "task_r", actor: sys, payload: { status: "succeeded", summary: "ok", artifacts: [], cost: 0, duration_ms: 1, outputs: over.review ?? { verdict: "approve", blocking: 0, red: 0 } } } as NewEvent,
      );
    }
    store.append(events);
  }

  function merger(mergeFacts: () => Promise<MergeFacts> = async () => facts) {
    const autoMerge = vi.fn(async () => ({ sha: "merged1" }));
    const m = new AutoMerger({ config: Config.parse({ autonomy_level: 3 }), store, policy, github: { mergeFacts, autoMerge }, now: () => Date.now() });
    return { m, autoMerge };
  }

  it("turns on only after the repository name is typed back, and records who and what", async () => {
    scene();
    const { m } = merger();
    await expect(m.set("prj_1", { enabled: true }, user)).rejects.toThrow(/confirm it by typing/);
    await expect(m.set("prj_1", { enabled: true, confirm: "x/y" }, user)).rejects.toThrow(/confirm it by typing/);
    await expect(m.set("prj_1", { enabled: true, confirm: "o/r" }, phone)).rejects.toMatchObject({ code: "forbidden" });
    await expect(m.set("prj_1", { enabled: true, confirm: "o/r" }, agent)).rejects.toMatchObject({ code: "forbidden" });
    expect(store.autoMergeSettings().size).toBe(0);
    const view = await m.set("prj_1", { enabled: true, confirm: "O/R" }, user);
    expect(view).toMatchObject({ enabled: true, strategy: "squash" });
    const event = store.events({}).find((e) => e.type === "github.auto_merge.enabled");
    expect(event?.actor).toEqual(user);
    await m.set("prj_1", { enabled: false }, user);
    expect(m.status().projects[0]?.enabled).toBe(false);
  });

  it("refuses to turn on below autonomy level 3", async () => {
    scene();
    const low = new AutoMerger({ config: Config.parse({ autonomy_level: 2 }), store, policy, github: { mergeFacts: async () => facts, autoMerge: vi.fn() } });
    await expect(low.set("prj_1", { enabled: true, confirm: "o/r" }, user)).rejects.toMatchObject({ code: "conflict" });
  });

  it("merges a pull request that meets every condition, once, and records it", async () => {
    scene();
    const { m, autoMerge } = merger();
    await m.set("prj_1", { enabled: true, confirm: "o/r" }, user);
    expect(await m.check()).toBe(1);
    expect(autoMerge).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "o/r", number: 7, sha: "abc123", draft: true, method: "squash" }),
      { autonomyLevel: 3, enabled: true },
    );
    expect(store.events({ runId: "run_1" }).some((e) => e.type === "github.pr.merged")).toBe(true);
  });

  it("does nothing while it is off, and says why a pull request waits when it is on", async () => {
    scene({ review: { verdict: "approve", blocking: 1, red: 0 } });
    const { m, autoMerge } = merger();
    expect(await m.check()).toBe(0);
    await m.set("prj_1", { enabled: true, confirm: "o/r" }, user);
    expect(await m.check()).toBe(0);
    expect(autoMerge).not.toHaveBeenCalled();
    expect(m.status().projects[0]?.waiting[0]?.reason).toMatch(/blocking/);
  });

  it.each([
    ["no review ran", { review: null }, /no succeeded review/],
    ["the review gave no counts", { review: { verdict: "approve" } }, /blocking/],
    ["the review has 🔴 items", { review: { verdict: "approve", blocking: 0, red: 2 } }, /🔴/],
    ["the verification failed", { verifyPassed: false }, /verification failed/],
    ["the run's autonomy is low", { level: 2 }, /autonomy level is below 3/],
  ])("waits when %s", async (_name, over, why) => {
    scene(over as never);
    const { m, autoMerge } = merger();
    await m.set("prj_1", { enabled: true, confirm: "o/r" }, user);
    expect(await m.check()).toBe(0);
    expect(autoMerge).not.toHaveBeenCalled();
    expect(m.status().projects[0]?.waiting[0]?.reason).toMatch(why);
  });

  it("does not merge when GitHub no longer shows the commit Navarch pushed", async () => {
    scene();
    const { m, autoMerge } = merger(async () => ({ ...facts, head_sha: "someone-elses" }));
    await m.set("prj_1", { enabled: true, confirm: "o/r" }, user);
    expect(await m.check()).toBe(0);
    expect(autoMerge).not.toHaveBeenCalled();
  });

  it("is turned off everywhere by the kill switch", async () => {
    scene();
    const { m, autoMerge } = merger();
    m.start();
    await m.set("prj_1", { enabled: true, confirm: "o/r" }, user);
    store.append([{ type: "fleet.stopped", run_id: null, task_id: null, actor: user, payload: { run_ids: [] } }]);
    expect(m.status().projects[0]?.enabled).toBe(false);
    expect(await m.check()).toBe(0);
    expect(autoMerge).not.toHaveBeenCalled();
    await m.stop();
  });
});
