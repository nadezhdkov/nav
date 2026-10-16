import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NavarchEvent, RunDetail, RunView, ValidateFlowResponse } from "@navarch/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { fakeClaude } from "../../../packages/adapters/claude-code/test/fake.ts";
import { makeRepo, tempHome } from "../../../packages/runner/test/helpers.ts";
import { Config } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";

const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop().catch(() => {});
});

async function start() {
  const home = tempHome();
  const fake = fakeClaude("parallel");
  const config = Config.parse({ daemon: { port: 0 }, scheduler: { concurrency: 3, max_attempts: 1 }, routing: { enabled: false } });
  const daemon = new Daemon({ home, config, adapters: { "claude-code": fake.options } });
  await daemon.start();
  daemons.push(daemon);
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const api = async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(daemon.url + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  const publish = async (yaml: string) => {
    const name = /name: ([a-z-]+)/.exec(yaml)![1]!;
    expect((await api("PUT", `/api/v1/flows/${name}/draft`, { yaml, revision: null })).status).toBe(200);
    return api<{ error?: string; problems?: { message: string }[] }>("POST", `/api/v1/flows/${name}/publish`, { revision: 1 });
  };
  const finished = async (id: string): Promise<RunDetail> => {
    const end = Date.now() + 15_000;
    for (;;) {
      const r = (await api<RunDetail>("GET", `/api/v1/runs/${id}`)).body;
      if (["done", "failed", "cancelled"].includes(r.status)) return r;
      if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(r)}`);
      await new Promise((res) => setTimeout(res, 50));
    }
  };
  return { api, publish, finished, fake };
}

const reviews = (join: string, security: string, standards = "") => `apiVersion: navarch/v1
kind: Flow
metadata: { name: reviews }
nodes:
  - id: reviews
    type: parallel
    join: ${join}
    branches:
      security:
        - { id: threat, type: agent, profile: researcher, inputs: { pace: ${security} } }
      standards:
        - { id: style, type: agent, profile: reviewer${standards ? `, inputs: { pace: ${standards} }` : ""} }
  - { id: report, type: agent, profile: planner, inputs: { reviews: "\${{ nodes.reviews.outputs.summary }}" } }
edges: ["reviews -> report"]
`;

describe("parallel nodes in a run (ADR 0036)", () => {
  it("runs the branches in the run's worktree and hands the joined summaries to the next node", async () => {
    const { api, publish, finished, fake } = await start();
    expect((await publish(reviews("all", "quick"))).status).toBe(200);
    const created = await api<RunView>("POST", "/api/v1/runs", { repo_path: makeRepo(), prompt: "review the change", flow: "reviews" });
    expect(created.status).toBe(201);
    const run = await finished(created.body.id);
    expect(run.status).toBe("done");
    expect(run.tasks.map((t) => [t.node_id, t.status])).toEqual(expect.arrayContaining([["threat", "succeeded"], ["style", "succeeded"], ["report", "succeeded"]]));
    expect(run.tasks.find((t) => t.node_id === "report")!.summary).toBe("Report from: ### security researcher looked at the change. ### standards reviewer looked at the change.");
    // Read-only branches share the run's worktree.
    expect(new Set(fake.calls().map((c) => c.cwd)).size).toBe(1);
    const events = (await api<NavarchEvent[]>("GET", `/api/v1/runs/${created.body.id}/events`)).body;
    const refs = events.filter((e) => e.type === "task.created").map((e) => [(e.payload as { node_id: string }).node_id, (e.payload as { parallel?: unknown }).parallel]);
    expect(refs).toEqual([["threat", { node_id: "reviews", branch: "security" }], ["style", { node_id: "reviews", branch: "standards" }], ["report", undefined]]);
  });

  it("join any: stops the branch still working once one succeeds, and the run goes on", async () => {
    const { api, publish, finished, fake } = await start();
    await publish(reviews("any", "slow"));
    const created = await api<RunView>("POST", "/api/v1/runs", { repo_path: makeRepo(), prompt: "review the change", flow: "reviews" });
    const run = await finished(created.body.id);
    expect(run.status).toBe("done");
    const threat = run.tasks.find((t) => t.node_id === "threat")!;
    expect(threat.status).toBe("cancelled");
    expect(readdirSync(fake.stateDir).some((f) => f.startsWith("slow-"))).toBe(true);
    expect(run.tasks.find((t) => t.node_id === "report")!.summary).toBe("Report from: ### standards reviewer looked at the change.");
    const events = (await api<NavarchEvent[]>("GET", `/api/v1/runs/${created.body.id}/events`)).body;
    expect(events.find((e) => e.type === "task.status_changed" && e.task_id === threat.id && (e.payload as { to: string }).to === "cancelled")?.payload).toMatchObject({ reason: "not needed: reviews joined (any)" });
  });

  it("join all: a failed branch stops the others and fails the run with the reason", async () => {
    const { api, publish, finished } = await start();
    await publish(reviews("all", "slow", "broken"));
    const created = await api<RunView>("POST", "/api/v1/runs", { repo_path: makeRepo(), prompt: "review the change", flow: "reviews" });
    const run = await finished(created.body.id);
    expect(run.status).toBe("failed");
    expect(run.tasks.map((t) => [t.node_id, t.status])).toEqual([["threat", "cancelled"], ["style", "failed"]]);
    const events = (await api<NavarchEvent[]>("GET", `/api/v1/runs/${created.body.id}/events`)).body;
    const failure = events.filter((e) => e.type === "run.status_changed").at(-1)!.payload as { to: string; reason: string };
    expect(failure.reason).toContain("reviews: 0 of 2 branch(es) succeeded, all needs 2; security: threat was cancelled; standards: style failed");
  });

  it("refuses to publish a Flow whose branch edits", async () => {
    const { api, publish } = await start();
    const editing = reviews("all", "quick").replace("profile: researcher", "profile: implementer");
    const refused = await publish(editing);
    expect(refused.status).toBe(400);
    const check = await api<ValidateFlowResponse>("POST", "/api/v1/flows/validate", { yaml: editing });
    expect(check.body.problems.map((p) => p.message)).toContain('node "threat": profile "implementer" edits the worktree, and parallel branches run read-only agents; edit in parallel with a team or compete node');
  });
});
