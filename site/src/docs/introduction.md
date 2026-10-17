# Introduction

Navarch is a **local-first coordination layer for coding agents**. It does not write code itself. It takes the agents you already use (Claude Code, Codex, Gemini CLI, GitHub Copilot CLI, OpenCode, Kilo, Grok, or local models) and gives each piece of work a plan, an isolated git worktree, a budget, rules and a human in the loop.

A *navarch* commanded a fleet. That is the job: you decide what gets done, and Navarch keeps a fleet of agents on course.

## What a run looks like

Point Navarch at a GitHub issue and it runs the `fix-issue` Flow:

```
issue ─▶ triage ─▶ plan ─▶ ✋ approve plan ─▶ ┌ implement ⇄ verify ┐ ─▶ review ─▶ ✋ open draft PR
                                              └── fix loop, ≤ 3 ───┘
```

1. A fast agent **triages** the issue: what kind of work, how complex.
2. A stronger agent writes a **plan**, which waits for your approval.
3. An implementer edits the code in **its own worktree**, and your project's checks **verify** it. Failures go back to the implementer, up to three times.
4. A **reviewer** from a different provider reads the result.
5. Navarch opens a **draft pull request** with the plan, the evidence and the cost. You review and merge.

You can also start a run from a plain prompt in any local repository, or from a pull request to review it or fix its failing checks.

## What Navarch is not

- **Not an agent.** It orchestrates agents and never replaces them.
- **Not a cloud service.** The daemon runs on your computer and listens on `127.0.0.1`. Your tokens stay in your OS keychain.
- **Not autopilot for merges.** Navarch never merges, releases or deploys. Pull requests are always drafts.

## How you control it

- The **Web UI**, served by the daemon: runs, the live task graph, every agent as a tree, approvals, usage.
- The **CLI**, `navarch` (or `nav`): everything the UI does, from the terminal.
- **Your phone**: the same UI as an installable app, over Tailscale.
- **Plain language**: run `navarch` with no arguments and ask.

Ready? Continue with [Getting started](/docs/getting-started).
