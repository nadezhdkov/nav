import { describe, expect, it } from "vitest";
import { FlowNode, parseJudgeVerdict } from "../src/index.ts";

const block = (verdict: unknown) => "I compared both.\n\n```navarch-judge\n" + JSON.stringify(verdict) + "\n```\n";
const rank = (competitor: string, score: number) => ({ competitor, score, reason: `${competitor} is fine` });

describe("judge verdict (ADR 0031)", () => {
  it("reads the last navarch-judge block, best first", () => {
    const text = block({ summary: "old", ranking: [rank("c1", 1), rank("c2", 2)] }) + block({ summary: "c2 is smaller", ranking: [rank("c2", 9), rank("c1", 6)] });
    expect(parseJudgeVerdict(text, ["c1", "c2"])).toEqual({ ok: true, verdict: { summary: "c2 is smaller", ranking: [rank("c2", 9), rank("c1", 6)] } });
  });

  it("needs every finalist exactly once and nobody else", () => {
    expect(parseJudgeVerdict(block({ summary: "s", ranking: [rank("c1", 5)] }), ["c1", "c2"])).toEqual({ ok: false, error: "the ranking leaves out c2; rank every finalist: c1, c2" });
    expect(parseJudgeVerdict(block({ summary: "s", ranking: [rank("c1", 5), rank("c1", 4)] }), ["c1"])).toEqual({ ok: false, error: "c1 is ranked twice" });
    expect(parseJudgeVerdict(block({ summary: "s", ranking: [rank("c1", 5), rank("c3", 4)] }), ["c1"])).toEqual({ ok: false, error: "c3 is not a finalist (finalists: c1)" });
  });

  it("rejects a missing block, bad JSON and scores outside 0–10", () => {
    expect(parseJudgeVerdict("no block", ["c1"])).toEqual({ ok: false, error: "no ```navarch-judge block at the end of the answer" });
    expect(parseJudgeVerdict("```navarch-judge\n{oops\n```", ["c1"]).ok).toBe(false);
    const high = parseJudgeVerdict(block({ summary: "s", ranking: [rank("c1", 11)] }), ["c1"]);
    expect(high.ok === false && high.error).toMatch(/^navarch-judge ranking\.0\.score: /);
  });
});

describe("compete node", () => {
  it("parses with defaults", () => {
    const node = FlowNode.parse({ id: "compete", type: "compete", competitors: "${{ params.competitors }}", judge: { profile: "judge" } });
    expect(node).toMatchObject({ type: "compete", competitors: "${{ params.competitors }}", max_fix_iterations: 2, approve_pick: false });
  });

  it("allows 2 to 5 competitors", () => {
    expect(FlowNode.safeParse({ id: "c", type: "compete", competitors: 1, judge: { profile: "judge" } }).success).toBe(false);
    expect(FlowNode.safeParse({ id: "c", type: "compete", competitors: 6, judge: { profile: "judge" } }).success).toBe(false);
    expect(FlowNode.safeParse({ id: "c", type: "compete", competitors: 5, judge: { profile: "judge" } }).success).toBe(true);
  });
});
