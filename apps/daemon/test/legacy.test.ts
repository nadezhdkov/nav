import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { homeFiles, navarchHome } from "../src/config.ts";
import { loadProjectConfig } from "../src/project.ts";

/** Homes, files and project configuration created before the rename from VECTR (ADR 0008). */
describe("legacy VECTR state", () => {
  const tmp = () => mkdtempSync(join(tmpdir(), "navarch-legacy-"));

  it("picks the home from NAVARCH_HOME, then VECTR_HOME, then an existing ~/.vectr, else ~/.navarch", () => {
    const user = tmp();
    expect(navarchHome({}, user)).toBe(join(user, ".navarch"));
    mkdirSync(join(user, ".vectr"));
    expect(navarchHome({}, user)).toBe(join(user, ".vectr"));
    mkdirSync(join(user, ".navarch"));
    expect(navarchHome({}, user)).toBe(join(user, ".navarch"));
    expect(navarchHome({ VECTR_HOME: "/old" }, user)).toBe("/old");
    expect(navarchHome({ VECTR_HOME: "/old", NAVARCH_HOME: "/new" }, user)).toBe("/new");
  });

  it("keeps the database and daemon file names of a home created before the rename", () => {
    const fresh = tmp();
    expect(homeFiles(fresh)).toEqual({
      db: join(fresh, "navarch.db"),
      daemonInfo: join(fresh, "navarchd.json"),
      daemonLog: join(fresh, "navarchd.log"),
    });
    const old = tmp();
    writeFileSync(join(old, "vectr.db"), "");
    expect(homeFiles(old)).toEqual({ db: join(old, "vectr.db"), daemonInfo: join(old, "vectrd.json"), daemonLog: join(old, "vectrd.log") });
  });

  it("reads .vectr/project.yaml when the repository has no .navarch/project.yaml", async () => {
    const repo = tmp();
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env }).trim();
    git("init", "-q");
    mkdirSync(join(repo, ".vectr"));
    writeFileSync(join(repo, ".vectr", "project.yaml"), "verify:\n  - name: legacy\n    run: test -f a\n");
    git("add", ".");
    git("commit", "-q", "-m", "legacy config");
    expect((await loadProjectConfig(repo, git("rev-parse", "HEAD"))).verify.map((c) => c.name)).toEqual(["legacy"]);

    mkdirSync(join(repo, ".navarch"));
    writeFileSync(join(repo, ".navarch", "project.yaml"), "verify:\n  - name: current\n    run: test -f b\n");
    git("add", ".");
    git("commit", "-q", "-m", "current config");
    expect((await loadProjectConfig(repo, git("rev-parse", "HEAD"))).verify.map((c) => c.name)).toEqual(["current"]);
  });
});
