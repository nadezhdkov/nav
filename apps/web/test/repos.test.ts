import type { GitHubRepoView, ProjectView } from "@navarch/contracts";
import { describe, expect, it } from "vitest";
import { groupOptions, repoOptions, shortPath } from "../src/lib/repos.ts";

const project = (name: string, repo: string, path: string): ProjectView => ({
  id: `prj_${name}`,
  name,
  repo,
  path,
  added_at: "2026-10-15T00:00:00Z",
  active_runs: 0,
  inbox: { new: 0, triaged: 0 },
  synced_at: null,
});

const gh = (repo: string, over: Partial<GitHubRepoView> = {}): GitHubRepoView => ({
  repo,
  owner: repo.split("/")[0]!,
  private: false,
  description: null,
  default_branch: "main",
  pushed_at: null,
  can_push: true,
  project_id: null,
  path: null,
  ...over,
});

describe("New run repository picker", () => {
  it("shortens the home folder to ~", () => {
    expect(shortPath("/home/hope/Documents/projects/vectr")).toBe("~/Documents/projects/vectr");
    expect(shortPath("/Users/ana/src/x")).toBe("~/src/x");
    expect(shortPath("/srv/repos/x")).toBe("/srv/repos/x");
  });

  it("names projects, then other earlier repositories, then GitHub repositories without a clone", () => {
    const options = repoOptions(
      [project("claude-toolkit", "nadezhdkov/claude-toolkit", "/home/hope/Documents/projects/claude-toolkit")],
      [
        { path: "/home/hope/Documents/projects/claude-toolkit", last_run_at: "x" },
        { path: "/home/hope/Documents/projects/vectr", last_run_at: "x" },
      ],
      [gh("nadezhdkov/nav", { private: true, description: "Fleet of agents" }), gh("nadezhdkov/claude-toolkit", { path: "/home/hope/Documents/projects/claude-toolkit" })],
    );
    expect(options.map((o) => [o.group, o.title, o.subtitle])).toEqual([
      ["projects", "claude-toolkit", "nadezhdkov/claude-toolkit"],
      ["earlier", "vectr", "~/Documents/projects/vectr"],
      ["github", "nav", "Fleet of agents"],
    ]);
    expect(options[2]).toMatchObject({ value: "github:nadezhdkov/nav", owner: "nadezhdkov", private: true, canPush: true });
  });

  it("filters on every word and groups GitHub repositories by owner", () => {
    const options = repoOptions([], [{ path: "/home/hope/a/sandbox", last_run_at: "x" }], [gh("acme/widgets"), gh("acme/gadgets"), gh("other/widgets")]);
    expect(groupOptions(options).map((g) => [g.key, g.options.length])).toEqual([
      ["earlier", 1],
      ["github:acme", 2],
      ["github:other", 1],
    ]);
    expect(groupOptions(options, "acme wid").flatMap((g) => g.options.map((o) => o.value))).toEqual(["github:acme/widgets"]);
    expect(groupOptions(options, "nothing")).toEqual([]);
  });
});
