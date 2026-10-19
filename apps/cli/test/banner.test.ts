import { describe, expect, it } from "vitest";
import { banner, hasTruecolor, prompt, tidyRemote, wantsColor } from "../src/banner.ts";
import { renderMascot, PALETTE, SPRITE, WIDTH } from "../src/mascot.ts";

const info = { project: "Navarch", repository: "https://github.com/nadezhdkov/nav", workspace: "~/nav", branch: "main", agents: "2 running" };
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("banner", () => {
  it("shows the name, the tagline, where you are and that the system is ready, with no escape codes when colour is off", () => {
    const text = banner({ color: false, columns: 100, info });
    expect(text).not.toContain("\x1b");
    expect(text).toContain("orchestrate your fleet of coding agents");
    for (const line of ["Project", "Repository", "Workspace", "Branch", "Agents"]) expect(text).toContain(line);
    expect(text).toContain("https://github.com/nadezhdkov/nav");
    expect(text).toContain("System ready");
    expect(text).toContain("█   █"); // the block-letter name
  });

  it("draws the mascot only with true colour and room for it", () => {
    const wide = banner({ color: true, truecolor: true, columns: 100, info });
    expect(wide).toContain("▀");
    expect(wide).toContain("\x1b[38;2;");
    expect(banner({ color: true, truecolor: false, columns: 100, info })).not.toContain("▀");
    expect(banner({ color: true, truecolor: true, columns: 70, info })).not.toContain("▀");
  });

  it("never runs past the terminal's width", () => {
    for (const columns of [100, 80, 78, 60, 50, 40]) {
      for (const truecolor of [true, false]) {
        const text = banner({ color: true, truecolor, columns, info: { ...info, repository: `https://github.com/${"x".repeat(80)}/repo` } });
        for (const line of visible(text).split("\n")) expect([...line].length, `${columns} columns, line "${line}"`).toBeLessThanOrEqual(columns);
      }
    }
  });

  it("leaves out a line it has nothing for, and strips control characters from what it shows", () => {
    const text = banner({ color: false, columns: 100, info: { workspace: "~/a\x1b]0;evil\x07b" } });
    expect(text).not.toContain("Repository");
    expect(text).not.toContain("Branch");
    expect(text).not.toContain("\x1b");
    expect(text).not.toContain("\x07");
  });

  it("follows NO_COLOR, dumb terminals and missing terminals; true colour from COLORTERM", () => {
    expect(wantsColor(true, {})).toBe(true);
    expect(wantsColor(true, { NO_COLOR: "1" })).toBe(false);
    expect(wantsColor(true, { TERM: "dumb" })).toBe(false);
    expect(wantsColor(false, {})).toBe(false);
    expect(hasTruecolor({ COLORTERM: "truecolor" })).toBe(true);
    expect(hasTruecolor({ COLORTERM: "24bit" })).toBe(true);
    expect(hasTruecolor({ TERM: "xterm-256color" })).toBe(false);
  });

  it("shows the prompt as nav>", () => {
    expect(prompt(false)).toBe("nav> ");
    expect(visible(prompt(true))).toBe("nav> ");
  });
});

describe("remote URLs", () => {
  it("are shown as https links without credentials", () => {
    expect(tidyRemote("git@github.com:nadezhdkov/nav.git")).toBe("https://github.com/nadezhdkov/nav");
    expect(tidyRemote("https://user:ghp_secret@github.com/nadezhdkov/nav.git")).toBe("https://github.com/nadezhdkov/nav");
    expect(tidyRemote("ssh://git@host.example/o/r.git")).not.toContain("git@");
  });
});

describe("mascot", () => {
  it("is a rectangular grid of known colours, and prints two pixel rows per text row", () => {
    for (const row of SPRITE) {
      expect(row).toHaveLength(WIDTH);
      for (const c of row) expect(c === "." || PALETTE[c], c).toBeTruthy();
    }
    const lines = renderMascot();
    expect(lines).toHaveLength(Math.ceil(SPRITE.length / 2));
    for (const line of lines) expect([...visible(line)].length).toBe(WIDTH);
  });
});
