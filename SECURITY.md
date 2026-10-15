# Security policy

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub: on the repository's **Security** tab, choose **Report a vulnerability** ([direct link](https://github.com/nadezhdkov/nav/security/advisories/new)). Only the maintainer sees the report.

Include what you can of:

- what an attacker can do, and under which assumptions (local user, a crafted issue or PR comment, a malicious repository, a compromised model…);
- steps to reproduce, with the Navarch commit or version;
- logs or a proof of concept, with your own secrets removed.

You will get an answer within a week. Once a fix is released, the advisory is published, with credit to you if you want it.

## In scope

Navarch runs coding agents on your machine against GitHub repositories, so these matter most:

- **Prompt injection** from issues, pull requests, comments or repository files that makes an agent act outside its task (spec threat T1);
- ways around the **Policy Engine**: commands outside the allowlist, writes outside the worktree, access to `~/.ssh` or the Vault, pushes to branches other than `navarch/*`, force pushes, or any merge;
- **secrets** leaking into logs, events, prompts, artifacts or pull requests;
- the daemon's **local API** (`navarchd` on `127.0.0.1`): requests without the token, the Web UI sign-in code, the WebSocket stream, the Content Security Policy.

## Supported versions

Navarch has no releases yet. Fixes land on `main`; please test against the latest commit.
