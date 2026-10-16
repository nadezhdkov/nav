import { describe, expect, it } from "vitest";
import { ADJECTIVES, codename, isRunName, SHIPS, uniqueCodename } from "../src/orchestrator/names.ts";

describe("run codenames (ADR 0027)", () => {
  it("maps a run id to the same adjective-ship pair every time", () => {
    const name = codename("run_01M50H812NB09ZCJ6WXTRT7XCQ");
    expect(name).toBe(codename("run_01M50H812NB09ZCJ6WXTRT7XCQ"));
    const [adjective, ...ship] = name.split("-");
    expect(ADJECTIVES).toContain(adjective);
    expect(SHIPS).toContain(ship.join("-"));
    expect(new Set(ADJECTIVES).size).toBe(64);
    expect(new Set(SHIPS).size).toBe(64);
  });

  it("numbers a name that is already taken", () => {
    const base = codename("run_x");
    const taken = new Set([base, `${base}-2`]);
    expect(uniqueCodename("run_x", (n) => taken.has(n))).toBe(`${base}-3`);
    expect(uniqueCodename("run_x", () => false)).toBe(base);
  });

  it("tells names from run ids", () => {
    expect(isRunName("brave-frigate")).toBe(true);
    expect(isRunName("bold-man-o-war-2")).toBe(true);
    expect(isRunName("run_01M50H812NB09ZCJ6WXTRT7XCQ")).toBe(false);
  });
});
