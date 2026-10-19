import { describe, expect, it } from "vitest";
import { banner, wantsColor } from "../src/banner.ts";

describe("banner", () => {
  it("shows the ship, the name and the directory without escape codes when colour is off", () => {
    const text = banner({ color: false, cwd: "/work/repo" });
    expect(text).toContain("navarch");
    expect(text).toContain("(o_o)");
    expect(text).toContain("/work/repo");
    expect(text).not.toContain("\x1b");
  });

  it("paints the name in cyan when colour is on", () => {
    expect(banner({ color: true, cwd: "/w" })).toContain("\x1b[1m\x1b[36mnavarch\x1b[0m");
  });

  it("follows NO_COLOR, dumb terminals and missing terminals", () => {
    expect(wantsColor(true, {})).toBe(true);
    expect(wantsColor(true, { NO_COLOR: "1" })).toBe(false);
    expect(wantsColor(true, { TERM: "dumb" })).toBe(false);
    expect(wantsColor(false, {})).toBe(false);
  });
});
