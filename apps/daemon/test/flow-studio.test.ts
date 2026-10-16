import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DevicePairing, FlowCatalogView, DeviceSession, FlowDetail, FlowSummary, RunDetail, RunView, SimulationResult, ValidateFlowResponse } from "@navarch/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { fakeClaude } from "../../../packages/adapters/claude-code/test/fake.ts";
import { makeRepo, tempHome } from "../../../packages/runner/test/helpers.ts";
import { Config } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";
import { PolicyEngine } from "../src/policy/engine.ts";

const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop().catch(() => {});
});

async function start() {
  const home = tempHome();
  const fake = fakeClaude("edit");
  const config = Config.parse({ daemon: { port: 0, remote: { url: "https://pc.tail1234.ts.net", tailscale_command: "/nonexistent/tailscale" } }, routing: { enabled: false } });
  const daemon = new Daemon({ home, config, adapters: { "claude-code": fake.options } });
  await daemon.start();
  daemons.push(daemon);
  const local = readFileSync(join(home, "token"), "utf8").trim();
  const call = async <T>(token: string | undefined, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(daemon.url + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  const api = <T>(method: string, path: string, body?: unknown) => call<T>(local, method, path, body);
  return { daemon, call, api, local };
}

async function until<T>(fn: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  const end = Date.now() + 15_000;
  for (;;) {
    const v = await fn();
    if (done(v)) return v;
    if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const myTask = (description = "Implement and verify.") => `# Made in Flow Studio.
apiVersion: navarch/v1
kind: Flow
metadata:
  name: my-task
  description: ${description}
params:
  tries: { type: int, default: 2 }
nodes:
  - id: work
    type: loop
    max_iterations: \${{ params.tries }}
    until: \${{ nodes.verify.outputs.passed }}
    body:
      - id: implement
        type: agent
        profile: implementer
      - id: verify
        type: action
        uses: verification.run
edges:
  - work
`;

describe("Flow Studio API (ADR 0033)", () => {
  it("saves drafts by revision, refuses built-in names and renames, and publishes only a valid draft", async () => {
    const { api } = await start();
    const broken = myTask().replace("profile: implementer", "profile: wizard");
    const saved = await api<FlowDetail>("PUT", "/api/v1/flows/my-task/draft", { yaml: broken, revision: null });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ source: "studio", published_version: null, draft: { revision: 1 }, draft_yaml: broken });

    expect((await api("PUT", "/api/v1/flows/my-task/draft", { yaml: broken, revision: null })).status).toBe(409);
    expect((await api("PUT", "/api/v1/flows/fix-issue/draft", { yaml: broken, revision: null })).status).toBe(400);
    expect((await api("PUT", "/api/v1/flows/other/draft", { yaml: broken, revision: null })).status).toBe(400);
    // A draft may be anything while it is being written.
    expect((await api("PUT", "/api/v1/flows/scratch/draft", { yaml: "nodes: [", revision: null })).status).toBe(200);

    const refused = await api<{ error: string; problems: unknown[] }>("POST", "/api/v1/flows/my-task/publish", { revision: 1 });
    expect(refused.status).toBe(400);
    expect(refused.body.problems).toEqual([expect.objectContaining({ node: "implement", line: 17, message: expect.stringMatching(/unknown agent profile "wizard"/) })]);

    await api("PUT", "/api/v1/flows/my-task/draft", { yaml: myTask(), revision: 1 });
    expect((await api("POST", "/api/v1/flows/my-task/publish", { revision: 1 })).status).toBe(409);
    const published = await api<FlowDetail>("POST", "/api/v1/flows/my-task/publish", { revision: 2 });
    expect(published.body).toMatchObject({ published_version: 1, draft: null, draft_yaml: null, published_yaml: myTask(), versions: [{ version: 1, actor: "user via api" }] });

    const list = (await api<FlowSummary[]>("GET", "/api/v1/flows")).body;
    expect(list.find((f) => f.name === "fix-issue")).toMatchObject({ source: "builtin", needs: "issue" });
    expect(list.find((f) => f.name === "review-pr")).toMatchObject({ needs: "pull_request" });
    expect(list.find((f) => f.name === "task")).toMatchObject({ needs: "prompt" });
    expect(list.find((f) => f.name === "my-task")).toMatchObject({ source: "studio", published_version: 1, node_count: 1, description: "Implement and verify.", needs: "prompt" });
    expect(list.find((f) => f.name === "scratch")).toMatchObject({ published_version: null, draft: { revision: 1 }, needs: null });
    expect((await api<{ yaml: string }>("GET", "/api/v1/flows/my-task/versions/1")).body.yaml).toBe(myTask());
    expect((await api("GET", "/api/v1/flows/my-task/versions/2")).status).toBe(404);

    // A new draft starts from the published version; discarding it keeps v1.
    const draft = await api<FlowDetail>("PUT", "/api/v1/flows/my-task/draft", { yaml: myTask("v2"), revision: null });
    expect(draft.body).toMatchObject({ based_on: 1, draft: { revision: 1 } });
    const discarded = await api<{ flow: FlowDetail }>("DELETE", "/api/v1/flows/my-task/draft", { revision: 1 });
    expect(discarded.body.flow).toMatchObject({ published_version: 1, draft: null });

    // A Flow that was never published is gone with its draft, and its name is free again.
    expect((await api<{ flow: FlowDetail | null }>("DELETE", "/api/v1/flows/scratch/draft", { revision: 1 })).body.flow).toBeNull();
    expect((await api<FlowSummary[]>("GET", "/api/v1/flows")).body.map((f) => f.name)).not.toContain("scratch");
    expect((await api("GET", "/api/v1/flows/scratch")).status).toBe(404);
    expect((await api("PUT", "/api/v1/flows/scratch/draft", { yaml: "nodes: [", revision: null })).status).toBe(200);
  });

  it("says what a Studio Flow needs: a PR node without a condition needs an issue (go/no-go finding)", async () => {
    const { api } = await start();
    const withPr = (when: string) =>
      myTask().replace("edges:\n  - work\n", `  - id: open_pr\n    type: github\n    uses: pr.create\n${when}edges:\n  - work -> open_pr\n`);
    const save = async (yaml: string) => {
      const current = (await api<FlowDetail>("GET", "/api/v1/flows/my-task")).body;
      const revision = current?.draft?.revision ?? null;
      await api("PUT", "/api/v1/flows/my-task/draft", { yaml, revision });
      return (await api<FlowDetail>("POST", "/api/v1/flows/my-task/publish", { revision: (revision ?? 0) + 1 })).body;
    };
    expect(await save(withPr(""))).toMatchObject({ needs: "issue" });
    expect(await save(withPr("    when: ${{ project.work_item }}\n"))).toMatchObject({ needs: "prompt" });
  });

  it("validates and simulates documents", async () => {
    const { api } = await start();
    const catalog = (await api<FlowCatalogView>("GET", "/api/v1/flows/catalog")).body;
    expect(catalog.profiles).toContainEqual({ id: "implementer", edits: true });
    expect(catalog.uses.github).toContain("pr.create");
    expect(catalog.flows.map((f) => f.name)).toContain("task");
    expect(catalog.flows.map((f) => f.name)).not.toContain("team");
    const problems = (await api<ValidateFlowResponse>("POST", "/api/v1/flows/validate", { yaml: myTask(), name: "not-mine" })).body.problems;
    expect(problems[0]).toMatchObject({ severity: "error", message: expect.stringMatching(/metadata.name is "my-task"/) });
    expect((await api<ValidateFlowResponse>("POST", "/api/v1/flows/validate", { yaml: myTask(), name: "my-task" })).body.problems).toEqual([]);

    const sim = (await api<SimulationResult>("POST", "/api/v1/flows/simulate", { yaml: myTask(), outcomes: { verify: { outputs: { passed: false } } } })).body;
    expect(sim.steps.map((s) => s.node)).toEqual(["implement", "verify", "implement", "verify"]);
    expect(sim.end).toEqual({ kind: "fail", reason: expect.stringMatching(/work stopped after 2/) });
    const huge = (await api<ValidateFlowResponse>("POST", "/api/v1/flows/validate", { yaml: `# ${"x".repeat(70_000)}\n${myTask()}` })).body.problems;
    expect(huge).toEqual([expect.objectContaining({ message: "a flow is at most 64 KiB" })]);
    const invalid = (await api<SimulationResult>("POST", "/api/v1/flows/simulate", { yaml: "kind: Flow" })).body;
    expect(invalid.end).toBeNull();
    expect(invalid.problems.length).toBeGreaterThan(0);
  });

  it("runs a published Studio Flow, keeps a running run on its version, and refuses draft-only flows", async () => {
    const { api } = await start();
    const repo = makeRepo();
    await api("PUT", "/api/v1/flows/my-task/draft", { yaml: myTask(), revision: null });
    expect((await api<{ message: string }>("POST", "/api/v1/runs", { repo_path: repo, prompt: "add hello.txt", flow: "my-task" })).body.message).toMatch(/only a draft; publish it first/);

    await api("POST", "/api/v1/flows/my-task/publish", { revision: 1 });
    const run = await api<RunView>("POST", "/api/v1/runs", { repo_path: repo, prompt: "add hello.txt", flow: "my-task" });
    expect(run.status).toBe(201);
    await api("PUT", "/api/v1/flows/my-task/draft", { yaml: myTask("v2"), revision: null });
    await api("POST", "/api/v1/flows/my-task/publish", { revision: 1 });

    const done = await until(() => api<RunDetail>("GET", `/api/v1/runs/${run.body.id}`), (r) => ["done", "failed"].includes(r.body.status));
    expect(done.body.status).toBe("done");
    expect(done.body.flow_definition).toMatchObject({ source: "studio", version: 1, definition: { metadata: { description: "Implement and verify." } } });

    const next = await api<RunView>("POST", "/api/v1/runs", { repo_path: repo, prompt: "again", flow: "my-task" });
    const detail = (await api<RunDetail>("GET", `/api/v1/runs/${next.body.id}`)).body;
    expect(detail.flow_definition).toMatchObject({ version: 2, definition: { metadata: { description: "v2" } } });
  });

  it("keeps every Flow Studio route away from paired devices", async () => {
    const { call, local } = await start();
    const pairing = (await call<DevicePairing>(local, "POST", "/api/v1/devices/pairings")).body;
    const device = (await call<DeviceSession>(undefined, "POST", "/api/v1/devices/pair", { code: pairing.code, name: "Pixel" })).body.access_token;
    expect((await call(device, "GET", "/api/v1/flows")).status).toBe(403);
    expect((await call(device, "PUT", "/api/v1/flows/x/draft", { yaml: "", revision: null })).status).toBe(403);
    expect((await call(device, "POST", "/api/v1/flows/validate", { yaml: "" })).status).toBe(403);
  });

  it("survives a replay of the event log", async () => {
    const { api, daemon } = await start();
    await api("PUT", "/api/v1/flows/my-task/draft", { yaml: myTask(), revision: null });
    await api("POST", "/api/v1/flows/my-task/publish", { revision: 1 });
    await api("PUT", "/api/v1/flows/my-task/draft", { yaml: myTask("next"), revision: null });
    const before = (await api<FlowDetail>("GET", "/api/v1/flows/my-task")).body;
    daemon.store.rebuildProjections();
    expect((await api<FlowDetail>("GET", "/api/v1/flows/my-task")).body).toEqual(before);
  });
});

describe("Flow Studio policy", () => {
  const policy = new PolicyEngine();
  it("lets only the user, from the desktop, save and publish Flows", () => {
    for (const action of ["flow.save", "flow.publish"]) {
      expect(policy.decide({ kind: "user", via: "web" }, action, "flow:x", { autonomyLevel: 3 }).effect).toBe("allow");
      expect(policy.decide({ kind: "user", via: "mobile", device_id: "d" }, action, "flow:x", { autonomyLevel: 3 }).effect).toBe("deny");
      expect(policy.decide({ kind: "agent", profile: "implementer", adapter: "codex" }, action, "flow:x", { autonomyLevel: 3 }).effect).toBe("deny");
      expect(policy.decide({ kind: "system", component: "concierge" }, action, "flow:x", { autonomyLevel: 3 }).effect).toBe("deny");
    }
  });
});
