# Phase 2, slice 5: L2 container for verification

Status: implemented · Branch: `feat/container-verify` · Spec: §6.5.1 (L2), §6.6, §10 (T2, T3), §14.1 `security`, §14.2 `isolation`, §16 · ADR: 0035

A project can ask for its verify checks and setup commands to run in a container instead of on the operator's machine. This is isolation level **L2** of spec §6.5.1: Docker (or Podman) with the worktree mounted, restricted network and a non-root user. Agents still work in the worktree on the host (L1); only the commands Navarch itself runs move into the container.

## Behavior

### Choosing the isolation

- `.navarch/project.yaml` gains `isolation: worktree | container` and an optional `container` block. Like the rest of that file, both are read at the run's base commit, never from the worktree, and for a pull request at its base (ADR 0032):

  ```yaml
  isolation: container
  container:
    image: node:22-bookworm-slim   # default: the daemon's container.image
    network: none                  # verify checks: none (default) or bridge
    memory: 4g                     # defaults: the daemon's container.memory|cpus|pids_limit
    cpus: 2
  ```
- Without `isolation` the run uses the daemon's `security.default_isolation` (`worktree` by default).
- The daemon's `config.yaml` gains:

  ```yaml
  security:
    default_isolation: worktree
  container:
    runtime: docker                 # the command; podman takes the same flags
    image: node:22-bookworm-slim
    memory: 4g
    cpus: 2
    pids_limit: 1024
  ```
- At creation the run records what it resolved, in `run.created.isolation`: `{ kind: "container", image, network, memory, cpus, pids_limit }`. A run without it (worktree, or created before this slice) runs on the host as before. Changing the config later never changes a running run, except the `runtime` command, which is the daemon's.

### What runs in the container

- **Verify checks** (`verification.run`): each check is one `docker run` of `sh -c <command>` in the run's image, with the container network the run chose (`none` by default).
- **Setup commands** (spec §14.2 `setup`, ADR 0006): each is one `docker run` with network `bridge`, since they install dependencies. They run third-party install scripts, which is why they move too (T2).
- Every container gets:
  - `--rm`, a name `navarch-<task>-<n>` so a timeout or cancel can remove it (`docker rm -f`), and `--init`
  - `--user <uid>:<gid>` of the daemon, so files written to the worktree belong to the operator
  - `--cap-drop ALL`, `--security-opt no-new-privileges`, `--read-only` root file system with a `/tmp` tmpfs
  - `--memory`, `--cpus`, `--pids-limit` from the run's isolation
  - the worktree mounted read-write at its own path, which is the working directory, and the repository's git directory read-only at its own path (so `git status` and `git diff` work inside)
  - only `HOME=/tmp`, `CI=1`, `GIT_OPTIONAL_LOCKS=0` and `NAVARCH_SANDBOX=container` in its environment: nothing from the daemon's environment reaches it, so no secret can (T3)
  - `--pull missing`: a missing image is pulled once by the runtime, with the daemon's network
- Before the first check the runtime is asked for its version. If it is missing or not running, the verification fails with the blocking failure `container runtime unavailable: …` and no check runs. **Navarch never falls back to running the checks on the host.** A setup command fails the same way, and the agent task fails before the agent starts.

### Reporting

- `VerificationReport.sandbox` says where the checks ran: `{ kind: "container", image, network }`, absent on the host.
- The PR body's Verification section says "Checks ran in a container (`<image>`, network `<network>`)."; `navarch logs` shows `in container <image>` after the result.

## Out of scope (🔴)

- L3 (gVisor or similar, egress allowlist to registries) and `security.untrusted_isolation` for third-party code.
- The agents' own commands (their allowlisted test runs) still run on the host in the worktree.
- Container images prepared per repository (spec §19.7 "snapshots"); SELinux relabeling (`:z`) of the mounts for Podman on SELinux hosts.
- Dependencies installed by setup in the container are used by the agent on the host: native modules built for the image's libc may not load there.

## Acceptance

- A run on a project with `isolation: container` verifies through the runtime with the flags above, and its report and PR body say so (daemon test with a fake runtime that records its arguments).
- The runtime being unavailable fails the verification without running any check on the host.
- Cancel and timeout remove the container.
- With a real Docker (`NAVARCH_TEST_DOCKER=1`), a check in a container sees the worktree, cannot reach the network, does not run as root, and cannot see a variable set in the daemon's environment.
