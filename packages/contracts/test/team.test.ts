import { describe, expect, it } from "vitest";
import { FlowNode, parseTeamPlan } from "../src/index.ts";

const block = (plan: unknown) => "Some reasoning first.\n\n```navarch-team\n" + JSON.stringify(plan) + "\n```\n";
const member = (key: string, extra: Record<string, unknown> = {}) => ({ key, title: `Do ${key}`, brief: `Brief for ${key}`, profile: "implementer", ...extra });

describe("team plan (ADR 0022)", () => {
  it("reads the last navarch-team block of a lead's summary", () => {
    const summary = block({ summary: "old", done: true, members: [] }) + block({ summary: "Split in two", done: false, members: [member("api", { prefer: "codex" }), member("ui", { depends_on: ["api"] })] });
    const parsed = parseTeamPlan(summary);
    expect(parsed).toEqual({
      ok: true,
      plan: {
        summary: "Split in two",
        done: false,
        question: null,
        members: [
          { key: "api", title: "Do api", brief: "Brief for api", profile: "implementer", prefer: "codex", depends_on: [] },
          { key: "ui", title: "Do ui", brief: "Brief for ui", profile: "implementer", depends_on: ["api"] },
        ],
      },
    });
  });

  it("allows depending on members of earlier turns", () => {
    expect(parseTeamPlan(block({ summary: "s", done: false, members: [member("fix", { depends_on: ["api"] })] }), ["api"]).ok).toBe(true);
  });

  it.each([
    ["no block", "I am done."],
    ["invalid JSON", "```navarch-team\n{ nope\n```"],
    ["an unknown profile", block({ summary: "s", done: false, members: [member("a", { profile: "lead" })] })],
    ["a bad key", block({ summary: "s", done: false, members: [member("Bad Key")] })],
    ["a duplicate key", block({ summary: "s", done: false, members: [member("a"), member("a")] })],
    ["a key used in an earlier turn", block({ summary: "s", done: false, members: [member("api")] })],
    ["an unknown dependency", block({ summary: "s", done: false, members: [member("a", { depends_on: ["zzz"] })] })],
    ["a dependency on a later member", block({ summary: "s", done: false, members: [member("a", { depends_on: ["b"] }), member("b")] })],
    ["a question with members", block({ summary: "s", done: false, question: "Which DB?", members: [member("a")] })],
    ["an extra field", block({ summary: "s", done: false, members: [], autonomy_level: 3 })],
  ])("rejects %s with a reason the lead can act on", (_name, summary) => {
    const parsed = parseTeamPlan(summary, ["api"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.length).toBeGreaterThan(5);
  });

  it("accepts a team node in a Flow", () => {
    const node = FlowNode.parse({ id: "team", type: "team", lead: { profile: "lead" }, max_turns: "${{ params.max_turns }}", approve_first_plan: "${{ project.autonomy_level < 3 }}" });
    expect(node.type).toBe("team");
  });
});
