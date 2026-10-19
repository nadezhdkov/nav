# Security

Navarch runs agents that write code on your machine, so its defaults are strict. These are the rules it keeps.

## Nothing merges without you

- Merge, release and deploy are **never automatic**, with one exception you opt into per repository: [auto-merge](autonomy-and-approvals#auto-merge). Release and deploy never are.
- Runs push only `navarch/*` branches, **never forced**, and only through the GitHub Integration.
- Pull requests are always **drafts**.

## Security keys

Register a security key (a fingerprint or PIN on your laptop or phone, a passkey, or a USB key) in Settings → Security. Once you have one, turning on auto-merge and adding or removing keys ask you to touch it first. It works only on the desktop, at `http://localhost` or your Tailscale name (never an IP address), and a paired phone cannot manage keys.

## The history can be checked

Every recorded event is chained to the one before it by a hash, so editing, deleting or reordering history breaks the chain. `navarch audit` verifies it and prints the latest hash; keep a copy somewhere the daemon cannot write, and `navarch audit --expect <hash>` later shows whether that point is still in the log. `navarch audit export <run>` lists a run's events with their actors. It detects tampering; it does not prevent it.

## Agents stay in their box

- Each run works in **its own git worktree**. Agents may not write outside it, and access to `~/.ssh` and to the vault is always denied.
- Agents run with **Navarch's configuration**, not yours: no user-level settings, MCP servers, skills or memory of yours.
- An agent may run only the commands on the repository's **allowlist** (plus read-only ones such as `git status`). Every agent CLI's permissions are translated from the same grant.
- `.navarch/project.yaml` is read **at the run's base commit**, so an agent cannot change its own rules.
- Instructions you send to a running agent never widen what it is allowed to do.

## Hardened containers (L3)

For code you do not trust, such as a third party's pull request, a project can ask for `isolation: hardened` in `.navarch/project.yaml` (or you set `security.default_isolation: hardened` for every project, which a repository cannot lower).

- The **agent itself** runs in a throwaway container with **no network interface**. It reaches only its model provider, through a proxy on your PC that tunnels HTTPS to a short allowlist and refuses everything else, including names that resolve to private addresses.
- Its root is read-only, all capabilities are dropped, and it sees only the worktree (**read-only for a profile that may not edit**), the git directory read-only and a home of its own. Nothing of your environment goes in except the provider key it needs.
- Verify checks and setup run in containers too, with no network for checks.
- Build the image once with `make agent-image`. For a stronger runtime such as gVisor, set `container.oci_runtime: runsc`.
- Today this covers the `claude-code` and `codex` agents. Routing picks only those for a hardened run, and a pinned agent that cannot run hardened is refused, never run on your machine.

## Untrusted input

Text from issues, pull requests, comments and the web is **data, never instructions**. Navarch passes it to agents inside delimited, labelled blocks.

## Secrets

- Secrets live in your **OS keychain** and are referenced as `secret://…`. They reach an agent only by injection at runtime, for the one command that needs them.
- They never appear in logs, events or configuration files, and logs are redacted automatically.
- The GitHub token should be a **fine-grained** token limited to the repositories Navarch works on.

## Every side effect goes through the policy

Starting an agent, running a command, pushing, opening a pull request, posting a review or comment, spending past a budget: each asks the **Policy Engine**, which allows, denies, or asks you. Every decision is an event in the local log.

## Your daemon stays local

`navarchd` listens on `127.0.0.1`. Phones reach it through Tailscale, which keeps it on loopback, and every API request is authenticated with a token. A paired phone has a restricted set of routes and never sees secrets.

## Reporting a vulnerability

Please follow `SECURITY.md` in the repository, and do not open a public issue for a vulnerability.
