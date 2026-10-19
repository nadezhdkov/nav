import type { NavarchEvent } from "@navarch/contracts";
import { describe, expect, it } from "vitest";
import { formatEvent } from "../src/format.ts";
import { oneLineSafe, stripControls } from "../src/safe.ts";

describe("terminal-safe text", () => {
  it("drops escape sequences and other control characters but keeps newlines and tabs", () => {
    expect(stripControls("ok \u001b[2J\u001b]0;pwned\u0007 done\tx\ny\u0000\u009b")).toBe("ok [2J]0;pwned done\tx\ny");
    expect(stripControls("plain, ünïcode ✅ and 日本語")).toBe("plain, ünïcode ✅ and 日本語");
  });

  it("keeps one value on one line", () => {
    expect(oneLineSafe("a\r\nb\u2028c\u001b[31md")).toBe("a bc[31md");
  });

  it("makes an event line from untrusted text safe to print", () => {
    const event = { seq: 1, ts: "2026-10-19T12:00:00.000Z", type: "task.progress", payload: { message: "reading\u001b[1A\u001b[2Kfake line" } } as unknown as NavarchEvent;
    const line = oneLineSafe(formatEvent(event));
    expect(line).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(line).toContain("reading");
  });
});
