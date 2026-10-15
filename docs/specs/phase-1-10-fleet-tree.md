# Phase 1, slice 10: Fleet tree

Status: draft · Branch: `feat/fleet-tree` (after slice 9) · Spec: §8.3, §9.1, §9.2, §15.1, §15.2, §19 idea 14 · ADR: 0022 · Needs: slice 9 (Team mode)

The Fleet (ADR 0019) shown as a tree on a canvas: project → run → lead → members (ADR 0022), with the links between agents, a chat with the lead, a prompt box on every agent card and the live state of the run's worktree. Visual reference: the user's "Large Project - Multi-Agent Tree" mockup (2026-10-15), in the graphite theme.

What the mockup shows that Phase 1 cannot back with real data is left out rather than imitated: one worktree per agent and members running in parallel (Phase 2), and per-agent progress %, which no adapter reports.

## Behavior

### Tree (`/fleet`, desktop)

- `/fleet` gets a layout switch, **Tree** (new, default on desktop) | **Cards** (today's grid). The choice is remembered per browser. On phones (≤ 768 px) only Cards is offered.
- A Vue Flow canvas, laid out top-down, read-only (no dragging nodes, no editing edges); pan and zoom, "Fit view".
- **Project node**: name, repository, counts of its shown runs and running agents. Runs whose repository is not a registered project go under an "Other repositories" node, grouped by `repo_path`.
- **Run node**: title (issue or prompt), status icon + text, Flow, **step progress** "3 of 7 steps" (finished Flow nodes over all nodes of the run's Flow copy; a fix-loop iteration counts once), cost vs. budget, and a link to the run detail. Collapsible: a collapsed run shows its agent count and the worst agent state.
- **Agent node**: today's agent card content (profile icon, node label, status icon + text, adapter/model, iteration, branch, cost, latest activity, waiting reason), plus:
  - a one-line **prompt box** ("Message this agent…", Enter sends) while the run can still act. It always sends with `delivery: "next"` targeted at the task; interrupting stays in the panel, behind its warning. A badge shows pending instructions;
  - running agents pulse (off with `prefers-reduced-motion`).
- **Team runs** (ADR 0022): under the run node, the **lead** node (larger, marked "Lead", with turn "2 of 8", its adapter/model and its latest summary or question), and under it one node per member (title, profile, adapter/model, status, summary). The lead's internal sub-agents (`task.subagent`) hang under the lead as small "internal" nodes, collapsed by default. A question from the lead shows on its node as "Waiting for you" with the question.
- **Edges**: project → run → each agent of a Flow run, in Flow order. In a team run: lead → member, labelled "delegates" (with the turn); member → member for `depends_on`, dashed, labelled "after"; and member → lead, labelled "reports", once the member finished. Edge labels are text, not color alone; a running member's incoming edge is animated (off with `prefers-reduced-motion`).
- **Quick actions** in the canvas toolbar: Fit view, Collapse all / Expand all, filter *Active* | *Last 24 h* (as today), and **Pause all**, which is the existing kill switch (`POST /api/v1/stop`) with its confirmation.
- **Keyboard**: the canvas is reachable by Tab; arrow keys move between nodes along the tree (up: parent, down: first child, left/right: siblings), Enter opens the agent panel or toggles a run, Esc closes the panel. Focus is visible.

### Agent panel

The panel of ADR 0019, with these changes:

- The *Activity* tab becomes **Chat**: the same thread (the agent's progress lines, its final summary or error, and the user's instructions with "delivered" once an attempt took them), shown as a conversation, with the instruction box (next turn / interrupt now) at the bottom. For a team run, selecting the run or the lead opens the **lead chat**: every turn's summary and question, the members it added, and the user's instructions to the run, in one conversation across turns. This is the first step of §19 idea 14; it does not add a new transport.
- **Worktree** tab, live: branch, sandbox path, and the files changed since the run's base commit, each with status (added, modified, deleted, renamed, untracked) and `+added −removed` lines, plus totals. It refreshes when the tab opens and on `task.progress`/`task.completed` events of the run, at most once every 5 s. Selecting a file shows its diff. Before a worktree exists, or after it is removed, it says so and keeps showing the run's latest diff artifact as today.
- Output and Logs are unchanged.

## API and contracts (contracts first, `packages/contracts`)

- `FleetRun` gains `progress: { done: number, total: number } | null` (null for runs created before Flows) and `project_id: string | null` (the registered project whose path is the run's `repo_path`).
- `WorktreeStatus`: `{ run_id, branch, path, base_commit, exists: boolean, files: WorktreeFile[], totals: { files, added, removed } }`, with `WorktreeFile { path, old_path?, status: "added" | "modified" | "deleted" | "renamed" | "untracked", added: number | null, removed: number | null }` (null for binary files).
- `GET /api/v1/runs/:id/worktree` → `WorktreeStatus`. `GET /api/v1/runs/:id/worktree/diff?path=<file>` → that file's diff as text (max 512 KiB, then truncated with a marker). 404 for an unknown run, or for a path that is not in the status' file list (no reading arbitrary paths).
- Both are read-only and must not touch the worktree's index or files: `git diff --numstat -M` and `git diff --name-status -M` against the base commit, `git ls-files --others --exclude-standard` for untracked files (counted as added lines when text, up to 1 MiB), and `git diff --no-index /dev/null <file>` for an untracked file's diff. Not `add --intent-to-add`, which changes the index the agent is using.
- Device sessions (ADR 0020): both worktree routes are added to `DEVICE_ROUTES`.
- No new events or states; the canvas subscribes to `runs` like today.

## Rules

- **Pure client** (rule 1): the tree is grouping and layout over `FleetView` and the projects list; progress and project links come from the daemon.
- **Read-only worktree access**: the daemon reads the run's sandbox with git, inside the sandbox directory only; file paths in responses are relative to it; nothing in the request becomes a git argument except a path already in the status list, passed after `--`.
- **Policy** (rule 3): prompt-box messages go through `POST /api/v1/runs/:id/messages` and `run.message`, as today. Pause all is the existing `fleet.stop`.
- **No new states** (§8.3/§8.4).
- **i18n**: every new string in all five locales. Accessibility: status by icon + text, AA contrast in both themes, keyboard navigation on the canvas.

## Tests (no network, no real agent)

- Contracts: `FleetRun.progress`, `project_id`, `WorktreeStatus`.
- Projection: step progress over a Flow with a fix loop (iterations count once), runs created before Flows, project link by path.
- Worktree API with a real temporary repository: added, modified, deleted, renamed, untracked and binary files; totals; the index is unchanged after the call (`git diff --cached` empty, `git status` identical); 404 for a path outside the list and for `../` paths; truncation; missing worktree → `exists: false`; token required; device allowed.
- Web: tree building (projects, "Other repositories", Flow order, collapse), keyboard moves, prompt box sends `next` to the task and shows the pending badge, Chat thread, Worktree tab list and file diff, layout switch remembered, phones only get Cards; all locales complete.
- Visual check: demo daemon with two projects, a run with a fix loop, a waiting approval and a running slow agent, Chromium 1440×900 dark and light, and 390×844; Tree, collapsed run, agent panel Chat and Worktree; no console errors.

## 🔴 Open

- One worktree per agent and members in parallel (Phase 2: parallel/join/integrate nodes, Compete mode).
- Per-agent progress %: no adapter reports it.
- "Add child agent" and "Create worktree" from the mockup's quick actions: the lead adds members; a human adding one by hand is not planned yet.
- A real two-way live chat (streaming the agent's own messages token by token, §19 idea 14): this slice shows progress lines and summaries only.
- Pausing a single agent (still not in the API).
