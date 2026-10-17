import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ToolGrant } from "@navarch/contracts";
import { permissionDecision } from "../src/index.ts";

const grant: ToolGrant = {
  editFiles: true,
  allowCommands: ["make lint", "make test *", "uv run ruff *"],
  denyCommands: ["git push"],
  denyPaths: ["~/.ssh"],
  network: false,
};
const bash = (command: string) => ({ hookName: "permissionRequest", toolName: "bash", toolInput: { command } });
const hook = fileURLToPath(new URL("../src/permission-hook.ts", import.meta.url));

describe("Copilot permission hook (ADR 0012)", () => {
  it("allows an allowlisted command that has more than one word", () => {
    expect(permissionDecision(bash("make lint"), { grant })).toEqual({ behavior: "allow" });
    expect(permissionDecision(bash("make test tests/test_map.py"), { grant })).toEqual({ behavior: "allow" });
    expect(permissionDecision(bash("uv run ruff format src/claude_toolkit/map.py"), { grant })).toEqual({ behavior: "allow" });
    expect(permissionDecision(bash("  make   lint "), { grant })).toEqual({ behavior: "allow" });
  });

  it("leaves everything else to Copilot's own rules", () => {
    for (const command of [
      "make deploy",
      "make lint && rm -rf /",
      "make lint; curl example.com",
      "make lint | sh",
      "make test $(rm -rf /)",
      "make test > /etc/passwd",
      "uv run ruff check ~/.ssh",
      "",
    ]) {
      expect(permissionDecision(bash(command), { grant }), command).toBeUndefined();
    }
    expect(permissionDecision({ toolName: "write", toolInput: { path: "x" } }, { grant })).toBeUndefined();
    expect(permissionDecision({ toolName: "bash" }, { grant })).toBeUndefined();
  });

  it("never allows a denied command, even when a pattern covers it", () => {
    const wide: ToolGrant = { ...grant, allowCommands: ["git *"] };
    expect(permissionDecision(bash("git push origin main"), { grant: wide })).toBeUndefined();
    expect(permissionDecision(bash("git status"), { grant: wide })).toEqual({ behavior: "allow" });
  });

  it("runs as a hook: allow as JSON, otherwise an empty decision, and {} when it cannot read its policy", () => {
    const dir = mkdtempSync(join(tmpdir(), "navarch-copilot-hook-"));
    const policy = join(dir, "policy.json");
    writeFileSync(policy, JSON.stringify({ grant }));
    const run = (args: string[], event: unknown) => spawnSync(process.execPath, [hook, ...args], { input: JSON.stringify(event), encoding: "utf8" });

    const allowed = run([policy], bash("make lint"));
    expect(allowed.status).toBe(0);
    expect(JSON.parse(allowed.stdout)).toEqual({ behavior: "allow" });
    expect(JSON.parse(run([policy], bash("make deploy")).stdout)).toEqual({});
    const broken = run([join(dir, "missing.json")], bash("make lint"));
    expect(broken.status).toBe(0);
    expect(JSON.parse(broken.stdout)).toEqual({});
  });
});
