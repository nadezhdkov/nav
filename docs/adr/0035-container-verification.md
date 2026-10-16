# 0035 — L2 container for verification and setup

- Status: accepted
- Date: 2026-10-16
- Spec: §6.5.1 (isolation levels), §6.6 (Verification), §10 T2/T3, §14.1 `security`, §14.2 `isolation`, §16 (Phase 2)
- Slice: [`docs/specs/phase-2-05-container-verify.md`](../specs/phase-2-05-container-verify.md)
- Builds on: ADR 0006 (setup commands), ADR 0032 (project config read at a pull request's base)

## Context

Every command Navarch runs itself, the project's setup (`npm ci`) and verify checks (`npm test`), runs on the operator's machine with the operator's user, network and file system. Those commands execute the repository's code and its dependencies' install scripts, which is T2 of the threat model. Spec §6.5.1 defines L2, a container with the worktree mounted, restricted network and a non-root user, and Phase 2 asks for it "for verification".

The agents themselves are a different problem. Each CLI runs its own tools, and putting a whole agent CLI in a container means its login, its config home and its model traffic too. That belongs with L3 and third-party code, not here.

## Decision

1. **L2 covers the commands Navarch runs: verify checks and setup commands.** Agents stay at L1 in the worktree. A project opts in with `isolation: container` in `.navarch/project.yaml`, read at the base commit like the rest of the file, or the daemon defaults every project to it with `security.default_isolation: container`.
2. **The run resolves its isolation once.** `run.created.isolation` records the image, the checks' network and the limits, from the project's `container` block over the daemon's `container` defaults. A config change never changes a running run. The runtime command (`container.runtime`, `docker` by default; Podman takes the same flags) stays the daemon's, because it describes the machine, not the run.
3. **One throwaway container per command**, through the runtime's CLI (`docker run --rm`), with no Docker SDK and no long-lived container. Each one gets a non-root user (the daemon's uid:gid, so the worktree's files stay the operator's), `--cap-drop ALL`, `no-new-privileges`, a read-only root file system with a `/tmp` tmpfs, and memory, CPU and process limits. Only the worktree is mounted read-write, and the repository's git directory read-only. It gets a fixed four-variable environment and nothing from the daemon's (T3: no secret can reach it). Every container has a unique name, so a timeout or cancel removes it, since killing the client alone leaves the container running.
4. **Network: none for checks, bridge for setup.** Checks should not need a network, and `container.network: bridge` is there for projects whose tests do. Setup installs dependencies and always has one. An egress allowlist is L3.
5. **No fallback to the host.** If the runtime is missing or not running, verification fails with `container runtime unavailable` before any check runs, and setup fails the agent task before the agent starts. Quietly running on the host would defeat the setting.
6. **Reports say where checks ran.** `VerificationReport.sandbox` is `{ kind: "container", image, network }`, and the PR body and `navarch logs` show it.

## Consequences

- A project with untrusted dependencies can keep their install scripts and its test suite off the host without changing how agents work.
- Dependencies installed in the container are used by agents on the host. Native modules built for another libc may not load there, so the image should match the host's runtime, or setup should stay on the host (`isolation: worktree`).
- Tests never start containers: `docker` and `podman` are stubbed on PATH (`test/no-real-agents.ts`), a fake runtime records the arguments, and one opt-in test (`NAVARCH_TEST_DOCKER=1`) checks the real isolation against a local image.
- Open: L3 (gVisor, egress allowlist) and `security.untrusted_isolation` for third-party pull requests, agents in containers, prepared images per repository (§19.7), and SELinux relabeling for Podman.
