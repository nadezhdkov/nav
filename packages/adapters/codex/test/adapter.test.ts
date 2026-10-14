import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collect, fakeCli, taskContext } from "../../kit/test/fake-cli.ts";
import { CodexAdapter } from "../src/index.ts";

const script = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
/** Keeps tests away from the real ~/.codex/sessions. */
const noSessions = mkdtempSync(join(tmpdir(), "navarch-codex-sessions-"));

describe("CodexAdapter (contract, fake CLI)", () => {
  it("runs codex exec in a workspace-write sandbox without network or approvals", async () => {
    const fake = fakeCli(script, "edit");
    const ctx = taskContext();
    const { events, io } = collect();
    const result = await new CodexAdapter({ ...fake.options, sessionsDir: noSessions }).run(ctx, io);

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
    const result = await new CodexAdapter({ ...fake.options, sessionsDir: noSessions }).run(taskContext({ resumeToken: "old-thread" }), collect().io);
    expect(result.status).toBe("succeeded");
    const [first, second] = fake.calls();
    expect(first?.args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(first?.args.slice(-2)).toEqual(["old-thread", "-"]);
    expect(second?.args).not.toContain("resume");
  });

  it("classifies a failed turn", async () => {
    const result = await new CodexAdapter({ ...fakeCli(script, "fail").options, sessionsDir: noSessions }).run(taskContext(), collect().io);
    expect(result).toMatchObject({ status: "failed", error: { kind: "rate_limited" } });
    expect(result.error?.retry_at).toBeUndefined();
  });

  it("reads plan limits from the session file and waits for the exhausted window", async () => {
    // Line shape from a real codex-cli 0.162 session file.
    const sessionsDir = mkdtempSync(join(tmpdir(), "navarch-codex-sessions-"));
    mkdirSync(join(sessionsDir, "2026", "10", "14"), { recursive: true });
    const limits = {
      limit_id: "codex",
      primary: { used_percent: 100.0, window_minutes: 300, resets_at: 1792005600 },
      secondary: { used_percent: 40.0, window_minutes: 10080, resets_at: 1792400400 },
      plan_type: "plus",
      rate_limit_reached_type: null,
    };
    writeFileSync(
      join(sessionsDir, "2026", "10", "14", "rollout-2026-10-14T15-00-43-019a-fake-thread.jsonl"),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: null, rate_limits: limits } }) + "\n",
    );
    const { events, io } = collect();
    const result = await new CodexAdapter({ ...fakeCli(script, "fail").options, sessionsDir }).run(taskContext(), io);

    expect(result.error).toMatchObject({ kind: "rate_limited", retry_at: "2026-10-14T19:20:00.000Z" });
    expect(events).toContainEqual({ kind: "quota", window: "primary_300m", utilization: 1, resetsAt: "2026-10-14T19:20:00.000Z", exhausted: true });
    expect(events).toContainEqual({ kind: "quota", window: "secondary_10080m", utilization: 0.4, resetsAt: "2026-10-19T09:00:00.000Z", exhausted: false });
  });

  it("declares sandbox-level enforcement", () => {
    expect(new CodexAdapter().capabilities().enforcement).toBe("sandbox");
  });
});
