import { describe, expect, it } from "vitest";
import { IMPLEMENTING_PROFILES, ROLE_PROFILES, TeamMemberProfile } from "@navarch/contracts";
import { Config } from "../src/config.ts";
import { lead, PROFILES } from "../src/orchestrator/profiles.ts";

describe("role profiles (ADR 0050)", () => {
  it("every profile a lead may give a member exists", () => {
    for (const id of TeamMemberProfile.options) expect(PROFILES.has(id), id).toBe(true);
  });

  it("implementing profiles edit, and architecture reads only", () => {
    for (const id of IMPLEMENTING_PROFILES) expect(PROFILES.get(id)?.edits, id).toBe(true);
    expect(PROFILES.get("architecture")?.edits).toBe(false);
    expect(ROLE_PROFILES).toContain("architecture");
  });

  it("has working rules of its own for each role", () => {
    const text = (id: string) => PROFILES.get(id)!.instructions;
    expect(text("qa")).toMatch(/test files and test helpers only/i);
    expect(text("devops")).toMatch(/do not deploy, publish, tag or release/i);
    expect(text("frontend")).toMatch(/keyboard/i);
    expect(text("backend")).toMatch(/untrusted/i);
    expect(text("architecture")).toMatch(/do not change files/i);
    for (const id of ROLE_PROFILES) expect(text(id)).toContain(`Navarch ${id} agent`);
  });

  it("tells the lead about every role", () => {
    for (const id of ROLE_PROFILES) expect(lead.instructions, id).toContain(`\`${id}\``);
  });

  it("has a default tier for every role", () => {
    const tiers = Config.parse({}).routing.profiles;
    for (const id of ROLE_PROFILES) expect(tiers[id], id).toBeDefined();
    expect(tiers.architecture).toBe("expert");
  });
});
