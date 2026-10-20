import type { Actor, CiFailureView, RunView } from "@navarch/contracts";
import { describe, expect, it } from "vitest";
import { conciergeTools, type ToolDeps } from "../src/concierge/tools.ts";

const actor: Actor = { kind: "user", via: "cli" };
const failure = (over: Partial<CiFailureView> = {}): CiFailureView => ({
  id: "cif_1",
  project_id: "prj_1",
  repo: "acme/widgets",
  number: 12,
  title: "Bad\nchange",
  author: "erin",
  url: "https://github.com/acme/widgets/pull/12",
  head_ref: "feature",
  head_sha: "abc",
  checks: [{ name: "test", conclusion: "failure", url: "https://x" }],
  status: "open",
  detected_at: "2026-10-19T10:00:00.000Z",
  run_id: null,
  resolved_reason: null,
  ...over,
});

function tools(extra: Partial<ToolDeps> = {}) {
  const calls: string[] = [];
  const ci: NonNullable<ToolDeps["ci"]> = {
    list: (status) => [failure()].filter((f) => f.status === (status ?? "open")),
    fix: async (id, req) => {
      calls.push(`fix ${id} ${JSON.stringify(req)}`);
      return { failure: failure({ status: "started", run_id: "run_1" }), run: { id: "run_1", status: "created" } as unknown as RunView };
    },
    dismiss: (id) => {
      calls.push(`dismiss ${id}`);
      return failure({ status: "dismissed" });
    },
  };
  const list = conciergeTools({ ci, actor: () => actor, ...extra } as unknown as ToolDeps);
  return { by: (name: string) => list.find((t) => t.name === name), names: list.map((t) => t.name), calls };
}

describe("concierge CI tools (ADR 0041)", () => {
  it("lists open failures as a read tool whose text is untrusted", async () => {
    const t = tools();
    const tool = t.by("list_ci_failures")!;
    expect(tool).toMatchObject({ kind: "read", untrusted: true });
    expect(await tool.run({})).toEqual([
      expect.objectContaining({ failure: "cif_1", pull_request: "acme/widgets#12", title: "Bad change", failed_checks: ["test (failure)"], status: "open" }),
    ]);
    expect(await tool.run({ status: "resolved" })).toEqual([]);
    await expect(tool.run({ status: "bogus" })).rejects.toThrow(/status must be/);
  });

  it("proposes a fix and a dismissal, and runs them as the operator", async () => {
    const t = tools();
    const fix = t.by("fix_ci")!;
    expect(fix.kind).toBe("act");
    expect(fix.kind === "act" && fix.summarize?.({ failure_id: "cif_1", budget: 2 })).toBe("start a ci-fix run on cif_1, acme/widgets#12 (failed test), budget $2");
    const result = await fix.run({ failure_id: "cif_1", budget: 2 });
    expect(fix.kind === "act" && fix.describe?.(result)).toBe("run run_1 created (created)");
    await t.by("dismiss_ci")!.run({ failure_id: "cif_1" });
    expect(t.calls).toEqual(['fix cif_1 {"budget":2}', "dismiss cif_1"]);
  });

  it("gives a paired phone the list only, and nothing without a CI watcher", () => {
    const phone = tools({ device: { knownRepos: () => [] } });
    expect(phone.names).toContain("list_ci_failures");
    expect(phone.names).not.toContain("fix_ci");
    expect(phone.names).not.toContain("dismiss_ci");
    expect(conciergeTools({ actor: () => actor } as unknown as ToolDeps).map((t) => t.name)).not.toContain("list_ci_failures");
  });
});
