import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Actor, NewEvent, RunView } from "@navarch/contracts";
import { parseFlow } from "@navarch/flow-engine";
import { describe, expect, it } from "vitest";
import { tempHome } from "../../../packages/runner/test/helpers.ts";
import { Config } from "../src/config.ts";
import { EventStore } from "../src/events/store.ts";
import { SpecSyncTrigger } from "../src/github/specsync.ts";
import type { Orchestrator } from "../src/orchestrator/orchestrator.ts";
import { PolicyEngine } from "../src/policy/engine.ts";

const user: Actor = { kind: "user", via: "cli" };
const flowOf = (name: string) => parseFlow(readFileSync(fileURLToPath(new URL(`../../../flows/${name}.yaml`, import.meta.url)), "utf8"));
const base = { repo_path: "/work/widgets", base_commit: "abc", prompt: "p", budget: 2, adapter: "claude-code", profile: "implementer", allow_commands: [] };
const specs = { components: 1, claims: 2, confirmed: 2, inferred: 0, gap: 0, downgraded: 0, green_rate: 1, branch: "navarch/x/reverse-spec", files: [".navarch/specs/a.md"] };

/** A store with the project acme/widgets, a task run (run_task) whose PR 12 Navarch opened, and optionally specs. */
function setup(opts: { specs?: boolean; auto?: boolean; dailyRuns?: number; flow?: string } = {}) {
  const store = new EventStore(join(tempHome(), "navarch.db"));
  const flow = opts.flow ?? "task";
  const events: NewEvent[] = [
    { type: "project.added", run_id: null, task_id: null, actor: user, payload: { project_id: "prj_1", name: "widgets", repo: "acme/widgets", path: "/work/widgets" } },
    { type: "run.created", run_id: "run_pr", task_id: null, actor: user, payload: { ...base, flow: { definition: flowOf(flow), params: {} } } },
    { type: "github.pr.opened", run_id: "run_pr", task_id: null, actor: user, payload: { repo: "acme/widgets", number: 12, url: "https://github.com/acme/widgets/pull/12", branch: "navarch/run_pr/task", draft: true } },
  ];
  if (opts.specs ?? true) {
    events.push(
      { type: "run.created", run_id: "run_specs", task_id: null, actor: user, payload: { ...base, flow: { definition: flowOf("reverse-spec"), params: {} } } },
      { type: "spec.generated", run_id: "run_specs", task_id: null, actor: user, payload: specs },
    );
  }
  store.append(events);
  const started: unknown[] = [];
  let seq = 0;
  const orchestrator = { startRun: async (req: unknown) => (started.push(req), { id: `run_sync${++seq}` } as RunView) } as unknown as Orchestrator;
  const config = Config.parse({ spec_sync: { auto: opts.auto ?? true, daily_runs: opts.dailyRuns ?? 3 } });
  const trigger = new SpecSyncTrigger({ config, store, orchestrator, policy: new PolicyEngine() });
  const pr = () => store.openPullRequests().find((p) => p.number === 12)!;
  return { store, started, trigger, pr };
}

describe("auto spec-sync after a merge (ADR 0052)", () => {
  it("starts spec-sync on the merged pull request of a project that keeps specs, once", async () => {
    const { store, started, trigger, pr } = setup();
    const record = pr();
    await trigger.merged(record);
    expect(started).toEqual([{ repo_path: "/work/widgets", pull_request: "acme/widgets#12", flow: "spec-sync" }]);
    expect(store.eventsOfType("spec.sync.auto_started")[0]).toMatchObject({ run_id: "run_sync1", payload: { repo: "acme/widgets", number: 12, project_id: "prj_1" } });
    await trigger.merged(record);
    expect(started).toHaveLength(1);
  });

  it("does nothing while spec_sync.auto is off, which is the default", async () => {
    expect(Config.parse({}).spec_sync).toEqual({ auto: false, daily_runs: 3 });
    const { started, trigger, pr } = setup({ auto: false });
    await trigger.merged(pr());
    expect(started).toEqual([]);
  });

  it("skips a project that keeps no specs with Navarch", async () => {
    const { started, trigger, pr } = setup({ specs: false });
    await trigger.merged(pr());
    expect(started).toEqual([]);
  });

  it("never syncs on the merge of a pull request that only added specs", async () => {
    for (const flow of ["reverse-spec", "spec-sync"]) {
      const { started, trigger, pr } = setup({ flow });
      await trigger.merged(pr());
      expect(started, flow).toEqual([]);
    }
  });

  it("stops at spec_sync.daily_runs", async () => {
    const { store, started, trigger, pr } = setup({ dailyRuns: 1 });
    store.append([{ type: "spec.sync.auto_started", run_id: "run_pr", task_id: null, actor: user, payload: { repo: "acme/widgets", number: 3, project_id: "prj_1", run_id: "run_pr" } }]);
    await trigger.merged(pr());
    expect(started).toEqual([]);
  });

  it("records nothing when the run cannot start", async () => {
    const { store, trigger, pr } = setup();
    const failing = new SpecSyncTrigger({
      config: Config.parse({ spec_sync: { auto: true } }),
      store,
      orchestrator: { startRun: async () => Promise.reject(new Error("not merged")) } as unknown as Orchestrator,
      policy: new PolicyEngine(),
    });
    await failing.merged(pr());
    expect(store.eventsOfType("spec.sync.auto_started")).toEqual([]);
    await trigger.merged(pr());
    expect(store.eventsOfType("spec.sync.auto_started")).toHaveLength(1);
  });
});
