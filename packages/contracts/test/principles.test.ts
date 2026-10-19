import { describe, expect, it } from "vitest";
import { MAX_PROPOSALS_PER_TASK, parsePrincipleProposals } from "../src/index.ts";

const block = (o: unknown) => "```navarch-principles\n" + JSON.stringify(o) + "\n```";
const rule = (text: string, reason = "because") => ({ text, reason });

describe("parsePrincipleProposals (ADR 0056)", () => {
  it("reads the rules of the last block of a summary", () => {
    const summary = `Verdict: approve.\n${block({ rules: [rule("old rule")] })}\nMore text.\n${block({ rules: [rule("use Pest, not PHPUnit", "every test is Pest")] })}`;
    expect(parsePrincipleProposals(summary)).toEqual({ rules: [{ text: "use Pest, not PHPUnit", reason: "every test is Pest" }] });
  });

  it("proposes nothing without a block, with broken JSON or a block of the wrong shape", () => {
    expect(parsePrincipleProposals("Verdict: approve.").rules).toEqual([]);
    expect(parsePrincipleProposals("```navarch-principles\n{ not json\n```").rules).toEqual([]);
    expect(parsePrincipleProposals(block({ rules: "use Pest" })).rules).toEqual([]);
    expect(parsePrincipleProposals(block([rule("a rule")])).rules).toEqual([]);
  });

  it("drops the rules that do not fit one by one: several lines, too short or long, no reason, repeated", () => {
    const parsed = parsePrincipleProposals(
      block({ rules: [rule("two\nlines"), rule("ab"), rule("x".repeat(301)), rule("no reason", ""), { text: "no reason field" }, "a string", rule("Keep it small"), rule("keep it SMALL"), rule("reason\nbroken", "two\nlines")] }),
    );
    expect(parsed.rules).toEqual([{ text: "Keep it small", reason: "because" }]);
  });

  it("keeps at most three rules from one task", () => {
    const rules = ["one rule", "two rule", "three rule", "four rule", "five rule"].map((t) => rule(t));
    expect(parsePrincipleProposals(block({ rules })).rules.map((r) => r.text)).toEqual(["one rule", "two rule", "three rule"]);
    expect(MAX_PROPOSALS_PER_TASK).toBe(3);
  });
});
