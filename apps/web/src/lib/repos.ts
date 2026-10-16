import type { GitHubRepoView, ProjectView, RepoView } from "@navarch/contracts";

/** One choice of the New run repository picker: a local clone, or a GitHub repository to clone. */
export type RepoOption = {
  /** `local:<path>` or `github:<owner/name>`. */
  value: string;
  group: "projects" | "earlier" | "github";
  /** The name people know it by: the project's name, else the folder or repository name. */
  title: string;
  /** `owner/name` on GitHub, or the folder's path with the home shortened to `~`. */
  subtitle: string;
  /** For GitHub repositories: owner, to group them, and whether it is private or read-only. */
  owner?: string;
  private?: boolean;
  canPush?: boolean;
};

export type RepoGroup = { key: string; group: RepoOption["group"]; owner?: string; options: RepoOption[] };

/** `/home/<user>/x` and `/Users/<user>/x` read as `~/x`; a path is long, its tail is what tells clones apart. */
export function shortPath(path: string): string {
  return path.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, "~");
}

const lastSegment = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

/** Registered projects first, then other repositories of earlier runs, then GitHub ones with no clone. */
export function repoOptions(projects: readonly ProjectView[], earlier: readonly RepoView[], github: readonly GitHubRepoView[]): RepoOption[] {
  const known = new Set(projects.map((p) => p.path));
  return [
    ...projects.map((p): RepoOption => ({ value: `local:${p.path}`, group: "projects", title: p.name, subtitle: p.repo || shortPath(p.path) })),
    ...earlier
      .filter((r) => !known.has(r.path))
      .map((r): RepoOption => ({ value: `local:${r.path}`, group: "earlier", title: lastSegment(r.path), subtitle: shortPath(r.path) })),
    ...github
      .filter((r) => !r.path)
      .map(
        (r): RepoOption => ({
          value: `github:${r.repo}`,
          group: "github",
          title: lastSegment(r.repo),
          subtitle: r.description || r.repo,
          owner: r.owner,
          private: r.private,
          canPush: r.can_push,
        }),
      ),
  ];
}

/** Options matching every word of `query` (title, subtitle or value), in groups for the list. */
export function groupOptions(options: readonly RepoOption[], query = ""): RepoGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const groups: RepoGroup[] = [];
  for (const o of options) {
    const text = `${o.title} ${o.subtitle} ${o.value}`.toLowerCase();
    if (!words.every((w) => text.includes(w))) continue;
    const key = o.group === "github" ? `github:${o.owner}` : o.group;
    let group = groups.find((g) => g.key === key);
    if (!group) groups.push((group = { key, group: o.group, ...(o.owner ? { owner: o.owner } : {}), options: [] }));
    group.options.push(o);
  }
  return groups;
}
