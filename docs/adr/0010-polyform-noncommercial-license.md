# 0010 — Source-available under the PolyForm Noncommercial License 1.0.0

- Status: accepted
- Date: 2026-10-14
- Spec: §19.9 (license and distribution), v0.10
- Supersedes: [0009](0009-mit-license.md) (MIT)

## Context

ADR 0009 put the project under MIT the same day the repository went public. The user then asked for a license that lets people copy and change the code but not sell it. A license that restricts commercial use is not open source under the OSI definition; the accurate term is *source-available*.

The options considered:

- **PolyForm Noncommercial 1.0.0:** no commercial use at all (selling, paid services, or a company using it for its own work); personal use, research, education, charities and public institutions may use, change and redistribute it. Written by lawyers for software.
- **MIT + Commons Clause:** everything MIT allows except selling the software or a service whose value comes mainly from it; a company may still use it internally.
- **PolyForm Shield 1.0.0:** only forbids building a competing product.
- **Creative Commons BY-NC:** Creative Commons itself advises against its licenses for software.

## Decision

- **PolyForm Noncommercial License 1.0.0** (SPDX `PolyForm-Noncommercial-1.0.0`), chosen by the user. `LICENSE` holds the official text, unchanged, after the line `Required Notice: Copyright (c) 2026 nadezhdkov (https://github.com/nadezhdkov/nav)`, which the license requires every copy to carry.
- The copyright holder is not bound by it and can still sell the software or license it differently (for example a commercial license on request).
- The skills in `.claude/skills/` are adapted from mattpocock/skills under MIT; those files keep their MIT notice in `.claude/skills/THIRD_PARTY.md`, as MIT requires.

## Consequences

- The project is described as source-available, never as open source.
- The code was public under MIT for part of 2026-10-14. Anyone who obtained it then keeps MIT rights to that version; the new terms apply from this change on.
- Outside contributions would need an agreement that lets the holder keep licensing commercially; until there is one, the project does not accept external pull requests.
