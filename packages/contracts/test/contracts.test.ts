import { describe, expect, it } from "vitest";
import { canTransitionRun, canTransitionTask, newId, parsePayload, redact, registerSecret } from "../src/index.ts";

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
    expect(canTransitionRun("verifying", "executing")).toBe(false);
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
