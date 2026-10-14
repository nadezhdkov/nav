# 0008 — Rename the product from VECTR to Navarch

- Status: accepted
- Date: 2026-10-14
- Spec: §19.1 (product name), v0.8
- Supersedes: the name decided in §19.1 up to v0.7

## Context

The spec named the product VECTR and left the trademark, domain and package-name check for "before publishing". The user wants the repository public (so GitHub can require checks before merging, and auto-merge can work as in claude-toolkit), and found that a trademark called VECTR already exists. The name had to change before anything is published.

Candidates were checked on 2026-10-14 against npm, PyPI, GitHub (organizations and repository names), DNS for `.dev`, `.com` and `.io`, and web searches for software with the same or a similar name. Common English words that fit the product (Plumbline, Assay, Shipshape, Tollgate, Flotilla, …) were all taken. Two suggestions from outside were rejected: Sovereign (registered for software in the US, used by a coding-agent company, and an existing buzzword for national or data sovereignty) and Orchestr (a project with 13k stars does the same thing under a near-identical name, the word is descriptive and weak as a trademark, and it clashes with the Core's own Orchestrator).

## Decision

- **The product is Navarch.** A navarch commanded a fleet in ancient Greece; Navarch coordinates a fleet of agents without being one of them (§1.2). Checked: free on npm and PyPI, `navarch.dev` free (`.com` and `.io` taken), only small unrelated GitHub projects (the largest, a GPU fleet manager, has 8 stars), no software of that name in web searches. **Not yet checked: trademark registries** (INPI, USPTO, WIPO, classes 9 and 42); that stays a precondition for publishing packages or making the repository public.
- **Names in code and on disk:** CLI `navarch` with the short alias `nav` (`nvc` was considered, but it is the NVIDIA HPC SDK's C compiler), daemon `navarchd`, packages `@navarch/*`, home `~/.navarch` (`NAVARCH_HOME`), run branches `navarch/<run-id>/<task>`, per-repository configuration `.navarch/project.yaml`, Vault environment overrides `NAVARCH_SECRET_<NAME>`, keychain service `navarch`. The spec file is `docs/navarch-especificacao.md`.
- **The GitHub repository becomes `nadezhdkov/nav`**, short like the user's other projects; GitHub redirects the old URLs.
- **State from before the rename keeps working in place**, without a migration step:
  - Home: `NAVARCH_HOME`, then `VECTR_HOME`, then an existing `~/.vectr` when there is no `~/.navarch`, else `~/.navarch`. A home is not moved because its worktrees are registered in the operator's repositories under their absolute paths.
  - A home that holds `vectr.db` keeps using `vectr.db`, `vectrd.json` and `vectrd.log`, so the new CLI finds a daemon started by the old code.
  - The Vault also reads `VECTR_SECRET_<NAME>` and the keychain service `vectr`; `navarch secret set` writes only the new service.
  - Agents and setup/verify commands never receive `VECTR_SECRET_*` either: an operator's shell may still export it.
  - `.vectr/project.yaml` is read when a repository has no `.navarch/project.yaml`.
- **Only `navarch/*` branches can be pushed.** No PR is pending on a `vectr/*` branch (the only one, the sandbox smoke test, was already pushed), so the old prefix is not kept as an exception to the push rule.

## Consequences

- Documents, ADRs and the go/no-go report were updated mechanically (name, commands, paths); the decisions they record did not change.
- The compatibility code is small and tested (`apps/daemon/test/legacy.test.ts`, vault and scrub tests). It can be removed once no `~/.vectr` home or `VECTR_*` setting is in use.
- Making the repository public, and the auto-merge workflow that depends on it, wait for the trademark check.
