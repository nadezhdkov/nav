# Phase 5, slice 1 — L3: agents in hardened containers

Status: implemented for `claude-code` and `codex`. ADR 0069. Spec §6.5.1 (L3), §10 T1–T3.

## Behaviour

- `isolation: hardened` in `.navarch/project.yaml`, or `security.default_isolation: hardened` for every project (a repository cannot lower it). The run records `run.created.isolation.hardened` `{ agent_image, oci_runtime?, egress_allow }`.
- Setup and verify run as in L2 (ADR 0035), except that checks never get a network, and with `container.oci_runtime` (e.g. `runsc`) when set.
- Each agent process runs in `docker run --rm --init --interactive` of `container.agent_image` (`make agent-image`): `--network=none`, `--cap-drop=ALL`, `no-new-privileges`, read-only root with a `/tmp` tmpfs, memory/CPU/pids limits, the operator's uid. Mounted: the worktree (**`ro` for a profile without `editFiles`**), the git directory `ro`, the agent's own home `<navarch home>/agent-homes/<task>`, the egress socket, the entry script. Environment: a fixed few variables, the proxy variables, and provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`) when the daemon has them.
- The agent's login files (`~/.claude/.credentials.json`, `~/.claude.json`, `~/.codex/auth.json`) are copied into its home, and copied back after the run when the agent refreshed them and the file is valid JSON.
- No interface means no direct egress. A proxy per process (`startEgressProxy`) listens on a unix socket mounted into the container; `agent-entry.mjs` bridges `127.0.0.1:3128` to it and runs the agent. It tunnels `CONNECT host:443` only for allowed hosts (the adapter's provider hosts in `DEFAULT_EGRESS` plus `container.egress_allow`; `*.x` allows subdomains), resolves the name itself and refuses any private, loopback, link-local or CGNAT answer. Refused hosts are written to the task log.
- Only `HARDENED_ADAPTERS` run hardened. The Model Router skips the others for such a run (`RouteRequest.allowedAdapters`), and a pinned one fails the task before it starts (`cannot run in hardened isolation`). A missing runtime or image fails the task; nothing falls back to the host.
- The seam is `useCliSandbox(taskId, fn)` in `@navarch/adapter-kit`: `CliProcesses.run` asks it to rewrite the command, so adapters did not change.

## Acceptance

- Real Docker (`NAVARCH_TEST_DOCKER=1`): no network interface, direct connections fail, root and a read-only worktree cannot be written, no daemon environment, the home is writable, an allowed host is reachable through the proxy and another gets 403.
- An issue run on a hardened project ends in a draft PR with every agent attempt in its own container, editing profiles on a `rw` worktree and the others `ro`.
- A pinned adapter outside the list fails with no container started.

## Not in this slice

- Adapters other than `claude-code` and `codex` (gemini-cli, copilot, antigravity, opencode, kilo and grok keep state in per-task homes and hooks that are not mounted yet), and the `native` adapter's tools.
- Running the agents' own tool commands with a registry allowlist (they have no network at all, beyond the provider), and an image per repository.
- A real agent run against a provider through the proxy: the proxy is tested with a local server, and the agents' proxy support (`HTTPS_PROXY`) is the CLIs' own.
