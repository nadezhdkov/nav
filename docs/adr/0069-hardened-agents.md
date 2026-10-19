# 0069 — L3: agents in containers with an egress allowlist

- Status: accepted
- Date: 2026-10-19
- Spec: §6.5.1 (L3), §10 T1–T3
- Slice: [`docs/specs/phase-5-01-hardened-agents.md`](../specs/phase-5-01-hardened-agents.md)
- Builds on: ADR 0035 (L2 for verification), ADR 0006 (agents run with Navarch's configuration)

## Context

ADR 0035 left agents at L1: each CLI runs on the operator's machine with the operator's network. For a third party's pull request that is T1, T2 and T3 of the threat model: an injected agent can run code and send the repository anywhere. Spec L3 asks for a hardened container and no network or a registry allowlist.

## Decision

1. **`isolation: hardened` is a level above `container`.** The daemon's default wins over a repository's choice, so a repository cannot lower it. The agent image, the OCI runtime and extra hosts are the daemon's settings, never the repository's, because a repository is the untrusted party.
2. **No network interface at all.** The container runs with `--network=none`. Its only way out is a unix socket, mounted into it, to a CONNECT proxy in the daemon process; a small Node script inside the container bridges the container's loopback port to the socket. Unlike an iptables allowlist this fails closed: a client that ignores the proxy variables has no route, and the only thing to get wrong is reachability, never leakage.
3. **The allowlist is hosts, and the address decides.** Only `CONNECT :443` to a listed host, with the name resolved by the proxy and refused if any answer is private, loopback, link-local or CGNAT, so an allowed name cannot be pointed at the operator's LAN or the cloud metadata address. The defaults per adapter are the provider's hosts, 🟡 to check against an account, extended by `container.egress_allow`.
4. **One hook, no adapter changes.** Every CLI adapter starts processes through `CliProcesses`; the Agent Runtime registers a per-task sandbox there. A sandbox that cannot be prepared makes the process fail to start: it never falls back to the host.
5. **A profile that may not edit gets a read-only worktree.** The agent's own rules enforce that too, but a mount holds even when they fail.
6. **Login travels as files, not a mount of the home.** The agent's login files are copied into a home of its own and copied back when refreshed, because refresh tokens rotate and leaving the old file would sign the operator out of their own CLI. Provider API keys are the only environment forwarded.
7. **Two agents first.** `claude-code` and `codex` keep their state in `HOME` and take no host paths in arguments. The others use per-task homes, hook files and config directories that are not mounted yet; routing skips them for a hardened run and pinning one is refused.

## Consequences

- 🟡 Agents' proxy support is the CLIs' own: `HTTPS_PROXY` and, for Node, `NODE_USE_ENV_PROXY`. An agent that ignores them cannot reach its provider, which shows as a connection error rather than a leak. Nothing here proves a real Claude Code or Codex run through the proxy; the CLIs start in the image and the proxy is tested with a local server.
- 🟡 The agent's own commands have no network beyond its provider, so `npm install` inside an agent task fails; setup (with a network) is where dependencies belong.
- 🟡 A copy of the login is in `agent-homes/<task>` while the task exists; it is the operator's own file with mode 0700 directories.
- 🔴 The container shares the host kernel unless `oci_runtime: runsc` (gVisor) is installed and chosen; gVisor was not run here.
