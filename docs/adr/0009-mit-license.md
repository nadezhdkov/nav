# 0009 — Open source under the MIT license

- Status: superseded by [0010](0010-polyform-noncommercial-license.md)
- Date: 2026-10-14
- Spec: §19.9 (license and distribution), v0.9

## Context

Spec §19.9 left open whether the project would be closed, open source (MIT or Apache-2.0) or open core. The repository became public on 2026-10-14, after the rename to Navarch (ADR 0008) and a trademark search by the user that found no conflicting registration. A public repository without a license grants no rights to reuse the code.

## Decision

- **MIT**, chosen by the user: anyone may clone, change and redistribute the code, including in closed products, as long as the copyright notice stays. `Copyright (c) 2026 nadezhdkov`, as in the user's other projects.
- The GNU GPL was considered and not chosen: it requires modified versions that are distributed to stay under the GPL, which is more than the user wants to ask of others.
- The skills in `.claude/skills/` are adapted from mattpocock/skills (MIT); their notice stays in `.claude/skills/THIRD_PARTY.md`.

## Consequences

- `LICENSE` at the root, `"license": "MIT"` in the root `package.json`, and a License section in the README.
- Packages stay `"private": true`; publishing to npm is a separate decision.
- Open core is out of scope for now; a later change would need a new ADR.
