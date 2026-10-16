import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkFlow, parseFlow, type FlowCatalog } from "../src/index.ts";

const FLOWS = fileURLToPath(new URL("../../../flows/", import.meta.url));
const builtins = readdirSync(FLOWS).filter((f) => f.endsWith(".yaml")).map((f) => readFileSync(FLOWS + f, "utf8"));
const flows = new Map(builtins.map((y) => parseFlow(y)).map((f) => [f.metadata.name, f]));
const catalog: FlowCatalog = {
  profiles: ["triager", "planner", "implementer", "reviewer", "lead", "judge", "pr-reviewer", "ci-fixer"],
  adapters: ["claude-code", "codex"],
  flows,
};

const flow = (body: string) => `apiVersion: navarch/v1
kind: Flow
metadata: { name: t }
${body}`;

const errors = (yaml: string, c: FlowCatalog = catalog) => checkFlow(yaml, c).problems.filter((p) => p.severity === "error");

describe("checkFlow", () => {
  it("finds no problems in the built-in flows", () => {
    for (const yaml of builtins) expect(checkFlow(yaml, catalog).problems).toEqual([]);
  });

  it("reports every problem at once, each with its node and line", () => {
    const yaml = flow(`nodes:
  - id: implement
    type: agent
    profile: wizard
  - id: verify
    type: action
    uses: verification.run
  - id: orphan
    type: agent
    profile: implementer
edges:
  - implement -> verify
`);
    const found = errors(yaml);
    expect(found).toEqual([
      expect.objectContaining({ node: "orphan", line: 11, message: expect.stringContaining('node "orphan" is not in edges') }),
      expect.objectContaining({ node: "implement", line: 7, message: expect.stringContaining('unknown agent profile "wizard"') }),
    ]);
  });

  it("reports schema problems at their line, all of them", () => {
    const yaml = flow(`nodes:
  - id: implement
    type: agent
  - id: Bad
    type: action
    uses: verification.run
edges:
  - implement -> Bad
`);
    const found = errors(yaml);
    expect(found.map((p) => p.line)).toEqual([5, 7]);
    expect(found[0]!.message).toMatch(/profile/);
  });

  it("reports invalid YAML with its line", () => {
    const found = errors(flow("nodes:\n  - id: a\n   type: agent\n"));
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toMatch(/invalid YAML/);
    expect(found[0]!.line).toBeGreaterThan(3);
  });

  it("names a node that appears twice in edges as a cycle without a loop", () => {
    const yaml = flow(`nodes:
  - { id: a, type: agent, profile: implementer }
  - { id: b, type: action, uses: verification.run }
edges:
  - a -> b -> a
`);
    expect(errors(yaml)[0]!.message).toMatch(/cycle.*loop/);
  });

  it("refuses a reference to a node that runs later", () => {
    const yaml = flow(`nodes:
  - id: plan
    type: agent
    profile: planner
    inputs:
      review: \${{ nodes.review.outputs.summary }}
  - { id: review, type: agent, profile: reviewer }
edges:
  - plan -> review
`);
    const found = errors(yaml);
    expect(found).toEqual([expect.objectContaining({ node: "plan", line: 9, message: expect.stringMatching(/"review", which runs later/) })]);
  });

  it("lets a loop body and its until read the whole body", () => {
    const yaml = flow(`nodes:
  - id: l
    type: loop
    max_iterations: 2
    until: \${{ nodes.verify.outputs.passed }}
    body:
      - id: implement
        type: agent
        profile: implementer
        inputs:
          failures: \${{ nodes.verify.outputs.blocking_failures }}
      - { id: verify, type: action, uses: verification.run }
edges:
  - l
`);
    expect(errors(yaml)).toEqual([]);
  });

  it("refuses a non-int param where a count goes", () => {
    const yaml = flow(`params:
  tries: { type: string, default: "3" }
nodes:
  - id: l
    type: loop
    max_iterations: \${{ params.tries }}
    until: \${{ nodes.v.outputs.passed }}
    body:
      - { id: v, type: action, uses: verification.run }
edges:
  - l
`);
    expect(errors(yaml)[0]!.message).toMatch(/param "tries" is a string/);
  });

  it("checks adapters, lead and judge profiles, and subflows against the catalog", () => {
    const yaml = flow(`nodes:
  - { id: a, type: agent, profile: implementer, adapter: hal }
  - { id: t, type: team, lead: { profile: boss }, max_turns: 3 }
  - { id: s, type: subflow, flow: nope }
  - { id: s2, type: subflow, flow: task, with: { colour: 1 } }
  - { id: s3, type: subflow, flow: draft-only }
edges:
  - a -> t -> s -> s2 -> s3
`);
    const msgs = errors(yaml, { ...catalog, drafts: ["draft-only"] }).map((p) => p.message);
    expect(msgs).toEqual([
      expect.stringMatching(/unknown adapter "hal"/),
      expect.stringMatching(/unknown agent profile "boss"/),
      expect.stringMatching(/unknown flow "nope"/),
      expect.stringMatching(/no param "colour"/),
      expect.stringMatching(/"draft-only" has no published version/),
    ]);
  });

  it("warns about a flow without agents, and a PR with nothing editing before it", () => {
    const yaml = flow(`nodes:
  - { id: v, type: action, uses: verification.run }
  - { id: pr, type: github, uses: pr.create }
edges:
  - v -> pr
`);
    const found = checkFlow(yaml, catalog).problems;
    expect(found.every((p) => p.severity === "warning")).toBe(true);
    expect(found.map((p) => p.message)).toEqual([expect.stringMatching(/no agent/), expect.stringMatching(/nothing before it edits/)]);
  });

  it("returns the parsed flow only when there are no errors", () => {
    expect(checkFlow(builtins[0]!, catalog).flow).not.toBeNull();
    expect(checkFlow(flow("nodes: []\nedges: []\n"), catalog).flow).toBeNull();
  });

  it("leaves parseFlow throwing the first error", () => {
    expect(() => parseFlow(flow(`nodes:\n  - { id: a, type: agent, profile: x }\n  - { id: b, type: agent, profile: x }\nedges:\n  - a\n`))).toThrow(/node "b" is not in edges/);
  });
});
