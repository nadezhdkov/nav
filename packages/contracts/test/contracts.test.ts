import { describe, expect, it } from "vitest";
import {
  canTransitionRun,
  canTransitionTask,
  CreateRunRequest,
  FleetView,
  newId,
  parseIssueRef,
  parsePayload,
  redact,
  registerSecret,
  SendRunMessage,
} from "../src/index.ts";

describe("task state machine (spec §8.3)", () => {
  it("allows the documented path and retries", () => {
    expect(canTransitionTask("pending", "ready")).toBe(true);
    expect(canTransitionTask("ready", "running")).toBe(true);
    expect(canTransitionTask("running", "interrupted")).toBe(true);
    expect(canTransitionTask("interrupted", "ready")).toBe(true);
    expect(canTransitionTask("failed", "ready")).toBe(true);
  });

  it("rejects leaving terminal states and skipping dispatch", () => {
    expect(canTransitionTask("succeeded", "ready")).toBe(false);
    expect(canTransitionTask("cancelled", "running")).toBe(false);
    expect(canTransitionTask("pending", "running")).toBe(false);
  });
});

describe("run state machine (spec §8.4)", () => {
  it("moves forward, may skip stages, and never backwards", () => {
    expect(canTransitionRun("created", "executing")).toBe(true);
    expect(canTransitionRun("executing", "done")).toBe(true);
    // The only way back: a fix loop returns from verification to implementation.
    expect(canTransitionRun("verifying", "executing")).toBe(true);
    expect(canTransitionRun("reviewing", "executing")).toBe(false);
    expect(canTransitionRun("ready_for_pr", "verifying")).toBe(false);
  });

  it("allows side exits and returns from paused", () => {
    expect(canTransitionRun("executing", "cancelled")).toBe(true);
    expect(canTransitionRun("executing", "paused")).toBe(true);
    expect(canTransitionRun("paused", "executing")).toBe(true);
    expect(canTransitionRun("done", "failed")).toBe(false);
  });
});

describe("events", () => {
  it("validates payloads per type", () => {
    expect(() => parsePayload("run.status_changed", { from: "created", to: "nope" })).toThrow();
    expect(parsePayload("task.progress", { message: "hi" })).toEqual({ message: "hi" });
  });

  it("generates prefixed sortable ids", () => {
    const a = newId("run");
    const b = newId("run");
    expect(a).toMatch(/^run_[0-9A-Z]{26}$/);
    expect(a < b).toBe(true);
  });
});

describe("redact", () => {
  it("removes known token formats and registered secrets", () => {
    registerSecret("super-secret-value");
    const out = redact("gh ghp_abcdefghijklmnopqrstuvwxyz0123 and super-secret-value and sk-ant-api03-abcdefghijkl");
    expect(out).not.toContain("ghp_");
    expect(out).not.toContain("super-secret-value");
    expect(out).not.toContain("sk-ant-");
  });
});

describe("work items", () => {
  it("parses owner/repo#N issue references", () => {
    expect(parseIssueRef("nadezhdkov/game-asset-finder#12")).toEqual({ repo: "nadezhdkov/game-asset-finder", number: 12 });
    expect(parseIssueRef(" a.b/c_d-e#1 ")).toEqual({ repo: "a.b/c_d-e", number: 1 });
    for (const bad of ["repo#1", "o/r#0", "o/r#", "o/r/x#1", "o/r#1; rm -rf /", "https://github.com/o/r/issues/1", "../x#1", "o/..#1", "./r#1"]) {
      expect(parseIssueRef(bad), bad).toBeUndefined();
    }
  });

  it("needs a prompt or an issue to create a run", () => {
    expect(CreateRunRequest.safeParse({ repo_path: "/r" }).success).toBe(false);
    expect(CreateRunRequest.safeParse({ repo_path: "/r", issue: "o/r#3" }).success).toBe(true);
    expect(CreateRunRequest.safeParse({ repo_path: "/r", prompt: "x" }).success).toBe(true);
    expect(CreateRunRequest.safeParse({ repo_path: "/r", issue: "o/r#3 && echo" }).success).toBe(false);
    expect(CreateRunRequest.safeParse({ repo_path: "/r", issue: "../r#3" }).success).toBe(false);
  });

  it("validates the new event payloads", () => {
    const report = { checks: [], passed: true, blocking_failures: [], warnings: ["unverified"], artifact_id: "art_1" };
    expect(parsePayload("verification.completed", report)).toEqual(report);
    expect(() =>
      parsePayload("github.pr.opened", { repo: "o/r", number: 0, url: "https://github.com/o/r/pull/0", branch: "navarch/x", draft: true }),
    ).toThrow();
  });
});

describe("instructions to a run (ADR 0019)", () => {
  it("defaults to the next turn and bounds the text", () => {
    expect(SendRunMessage.parse({ text: "  use pnpm  " })).toEqual({ text: "use pnpm", delivery: "next" });
    expect(SendRunMessage.safeParse({ text: "   " }).success).toBe(false);
    expect(SendRunMessage.safeParse({ text: "x".repeat(4_001) }).success).toBe(false);
    expect(SendRunMessage.safeParse({ text: "stop", delivery: "later" }).success).toBe(false);
  });

  it("validates the message events", () => {
    expect(parsePayload("run.message", { message_id: "msg_1", text: "use pnpm", delivery: "now", task_id: "tsk_1" })).toBeTruthy();
    expect(() => parsePayload("run.message", { text: "use pnpm" })).toThrow();
    expect(parsePayload("run.message.delivered", { message_id: "msg_1", task_id: "tsk_1", attempt: 2 })).toBeTruthy();
    expect(() => parsePayload("run.message.delivered", { message_id: "msg_1", task_id: "tsk_1", attempt: 0 })).toThrow();
  });

  it("describes the fleet as runs with their agents", () => {
    const view = FleetView.parse({ generated_at: "2026-10-15T00:00:00Z", counts: { running: 0, waiting: 0, failed: 0, done: 0 }, runs: [] });
    expect(view.runs).toEqual([]);
  });
});
