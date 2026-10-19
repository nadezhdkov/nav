import { describe, expect, it } from "vitest";
import { knowledgePanel } from "../src/budgets/knowledge.ts";
import type { AttemptRecord, PullRequestRecord } from "../src/events/store.ts";

let n = 0;
function attempt(over: Partial<AttemptRecord> & { input: number }): AttemptRecord {
  const { input, ...rest } = over;
  n++;
  return {
    ts: "2026-10-19T10:00:00.000Z",
    run_id: `run_${n}`,
    task_id: `task_${n}`,
    profile: "implementer",
    adapter: "claude-code",
    model: null,
    model_id: null,
    status: "succeeded",
    error_kind: null,
    duration_ms: 1000,
    tokens_in: input,
    tokens_out: 100,
    cached_tokens: 0,
    cost: 0,
    plan_cost: 0,
    context_tokens: null,
    ...rest,
  };
}

function pr(run_id: string, state: PullRequestRecord["state"]): PullRequestRecord {
  return { repo: "o/r", number: 1, run_id, run_name: "x", url: "u", branch: "b", commit_sha: null, opened_at: "2026-10-19T10:00:00.000Z", state, closed_at: null, commits_after: 0, cost: 0, plan_cost: 0 };
}

const withCtx = (input: number, over: Partial<AttemptRecord> = {}) => attempt({ input, context_tokens: 3000, ...over });
const without = (input: number, over: Partial<AttemptRecord> = {}) => attempt({ input, ...over });

describe("knowledgePanel", () => {
  it("is insufficient until both sides have enough attempts", () => {
    const k = knowledgePanel([withCtx(50_000), without(100_000), without(100_000)], []);
    expect(k.verdict).toBe("insufficient");
    expect(k.overall.reduction).toBeNull();
  });

  it("reports the reduction in median input tokens, counting cached input", () => {
    const rows = [
      ...[60_000, 70_000, 65_000].map((i) => withCtx(i)),
      ...[100_000, 90_000, 110_000].map((i) => without(i)),
    ];
    const k = knowledgePanel(rows, []);
    expect(k.overall.with.median_input_tokens).toBe(65_000);
    expect(k.overall.without.median_input_tokens).toBe(100_000);
    expect(k.overall.reduction).toBe(0.35);
    expect(k.verdict).toBe("met");
    expect(k.context).toEqual({ attempts: 3, median_est_tokens: 3000 });
    const cached = knowledgePanel([...[1, 1, 1].map(() => withCtx(10_000, { cached_tokens: 40_000 })), ...[1, 1, 1].map(() => without(100_000))], []);
    expect(cached.overall.with.median_input_tokens).toBe(50_000);
  });

  it("is not met below the target, and when success dropped", () => {
    const small = knowledgePanel([...[1, 2, 3].map(() => withCtx(90_000)), ...[1, 2, 3].map(() => without(100_000))], []);
    expect(small.overall.reduction).toBe(0.1);
    expect(small.verdict).toBe("not_met");
    const worse = knowledgePanel(
      [
        withCtx(50_000),
        withCtx(50_000, { status: "failed", error_kind: "fatal" }),
        withCtx(50_000, { status: "failed", error_kind: "fatal" }),
        ...[1, 2, 3].map(() => without(100_000)),
      ],
      [],
    );
    expect(worse.overall.reduction).toBe(0.5);
    expect(worse.verdict).toBe("not_met");
  });

  it("holds the verdict when PR acceptance dropped, counting only runs on one side", () => {
    const w = [1, 2, 3].map(() => withCtx(50_000));
    const wo = [1, 2, 3].map(() => without(100_000));
    const mixed = withCtx(50_000, { run_id: wo[0]!.run_id });
    const prs = [pr(w[0]!.run_id, "closed"), pr(w[1]!.run_id, "closed"), pr(wo[1]!.run_id, "merged"), pr(wo[0]!.run_id, "closed")];
    const k = knowledgePanel([...w, ...wo, mixed], prs);
    expect(k.pull_requests.with).toEqual({ closed: 2, merged: 0, acceptance_rate: 0 });
    expect(k.pull_requests.without).toEqual({ closed: 1, merged: 1, acceptance_rate: 1 });
    expect(k.verdict).toBe("not_met");
  });

  it("leaves out profiles that never get the context", () => {
    const k = knowledgePanel([without(10, { profile: "reviewer" }), withCtx(10)], []);
    expect(k.profiles.map((p) => p.profile)).toEqual(["implementer"]);
  });
});
