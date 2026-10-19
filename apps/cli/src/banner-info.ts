import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, resolve, sep } from "node:path";
import type { FleetView, ProjectView } from "@navarch/contracts";
import { tidyRemote, type BannerInfo } from "./banner.ts";

type Api = { request<T>(method: string, path: string, body?: unknown): Promise<T> };

function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((done) => {
    execFile("git", ["-C", cwd, ...args], { timeout: 1500, windowsHide: true }, (err, stdout) => done(err ? undefined : stdout.trim() || undefined));
  });
}

const tilde = (path: string) => {
  const home = homedir();
  return path === home ? "~" : path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
};

/**
 * What the banner says about where you are, read quickly and never fatal: a missing git, a repository
 * with no remote or a daemon that does not answer just leaves that line out. The remote is shown without
 * credentials.
 */
export async function bannerInfo(api: Api, cwd: string): Promise<BannerInfo> {
  const [branch, remote, top, projects, fleet] = await Promise.all([
    git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(cwd, ["config", "--get", "remote.origin.url"]),
    git(cwd, ["rev-parse", "--show-toplevel"]),
    api.request<ProjectView[]>("GET", "/api/v1/projects").catch(() => [] as ProjectView[]),
    api.request<FleetView>("GET", "/api/v1/fleet").catch(() => undefined),
  ]);
  const root = resolve(top ?? cwd);
  const registered = projects.find((p) => resolve(p.path) === root);
  const counts = fleet?.counts;
  const agents = counts
    ? [counts.running ? `${counts.running} running` : "", counts.waiting ? `${counts.waiting} waiting for you` : ""].filter(Boolean).join(" · ") || "idle"
    : undefined;
  return {
    project: registered?.name ?? (top ? basename(root) : undefined),
    repository: remote ? tidyRemote(remote) : undefined,
    workspace: tilde(resolve(cwd)),
    branch: branch && branch !== "HEAD" ? branch : undefined,
    agents,
  };
}
