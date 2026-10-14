import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collect, fakeCli, taskContext } from "../../kit/test/fake-cli.ts";
import { CodexAdapter } from "../src/index.ts";

const script = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

describe("CodexAdapter (contract, fake CLI)", () => {
  it("runs codex exec in a workspace-write sandbox without network or approvals", async () => {
    const fake = fakeCli(script, "edit");
    const ctx = taskContext();
    const { events, io } = collect();
    const result = await new CodexAdapter(fake.options).run(ctx, io);

    expect(result).toMatchObject({ status: "succeeded", summary: "Added codex.txt." });
    expect(result.usage).toEqual([{ model: "codex", tokens_in: 200, tokens_out: 40, cached_tokens: 50, cost: 0 }]);
    expect(existsSync(join(ctx.sandbox.path, "codex.txt"))).toBe(true);

    const [call] = fake.calls();
    expect(call?.cwd).toBe(ctx.sandbox.path);
    expect(call?.prompt).toBe("do the task");
    expect(call?.args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(call?.args).toEqual(
      expect.arrayContaining([
        'sandbox_mode="workspace-write"',
        'approval_policy="never"',
        "sandbox_workspace_write.network_access=false",
      ]),
    );
    expect(call?.args.at(-1)).toBe("-");
    expect(events).toContainEqual({ kind: "resume_token", token: "019a-fake-thread" });
    expect(events).toContainEqual({ kind: "progress", message: "$ bash -lc ls", tool: "shell" });
    expect(events).toContainEqual({ kind: "progress", message: "edited codex.txt", tool: "edit" });
  });

  it("resumes a thread with `exec resume <id> -` and starts fresh when it is gone", async () => {
    const fake = fakeCli(script, "missing-session");
    const result = await new CodexAdapter(fake.options).run(taskContext({ resumeToken: "old-thread" }), collect().io);
    expect(result.status).toBe("succeeded");
    const [first, second] = fake.calls();
    expect(first?.args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(first?.args.slice(-2)).toEqual(["old-thread", "-"]);
    expect(second?.args).not.toContain("resume");
  });

  it("classifies a failed turn", async () => {
    const result = await new CodexAdapter(fakeCli(script, "fail").options).run(taskContext(), collect().io);
    expect(result).toMatchObject({ status: "failed", error: { kind: "rate_limited" } });
  });

  it("declares sandbox-level enforcement", () => {
    expect(new CodexAdapter().capabilities().enforcement).toBe("sandbox");
  });
});
