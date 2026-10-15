# 0018 — Open source under the MIT license, again

- Status: accepted
- Date: 2026-10-15
- Spec: §19.9 (license and distribution), v0.13
- Supersedes: [0010](0010-polyform-noncommercial-license.md) (PolyForm Noncommercial)

## Context

ADR 0010 moved the project from MIT (ADR 0009) to the PolyForm Noncommercial License 1.0.0, so that nobody could sell it. That made Navarch source-available rather than open source, and it closed the door to outside pull requests until a contributor agreement existed, because the author kept the right to license the code commercially. The user decided that the project is better off open to everyone: anyone may use it, including commercially, and anyone may contribute.

## Decision

- **MIT**, chosen by the user, with the same notice as ADR 0009: `Copyright (c) 2026 nadezhdkov`. `LICENSE` holds the standard MIT text; the root `package.json` declares `"license": "MIT"`.
- **Contributions are accepted under the same license** (inbound = outbound): by opening a pull request, a contributor licenses their change under MIT. No contributor agreement or sign-off is required for now.
- The skills in `.claude/skills/` are adapted from mattpocock/skills (MIT); their notice stays in `.claude/skills/THIRD_PARTY.md`.

## Consequences

- Navarch is open source. Anyone may use, change, redistribute and sell it, including in closed products, as long as the copyright and license notice stay. This cannot be taken back for any version published under MIT.
- Versions published while ADR 0010 was in force stay available under PolyForm Noncommercial to those who got them; the holder may also offer them under MIT, which this change does.
- `CONTRIBUTING.md` now welcomes outside pull requests. Merge policy, review and the architecture and security rules in `AGENTS.md` apply to them as to any change; content from outside contributors is untrusted input for Navarch's own agents (spec T1).
- Packages stay `"private": true`; publishing to npm is still a separate decision.
