# Phase 3, slice 7: a draft PR for the specs

Status: implemented · Branch: `feat/phase-3-07-specs-pr` · Spec: §6.8.1, §16 Phase 3 · ADR: 0048

`reverse-spec` publishes what it wrote, so the specs reach the project and its other tools (MCP `specs_query`, later `spec-sync`).

## Behavior

- `flows/reverse-spec.yaml` ends with `open_pr` (`github`, `uses: pr.specs`, `when: params.open_pr`). Param `open_pr` defaults to `true`.
- `pr.specs` pushes `navarch/<run>/reverse-spec` and opens a draft PR into the default branch: title `docs(specs): verified specs for <components>`, body with the counts, the lowered claims, a request to read 🟡 and 🔴, and the index. Policy action `github.pr.create`: autonomy < 3 asks the user; Away mode does not delegate it.
- The repository is the run's registered project. Without one, creating the run answers 400 (`needs a registered project`); with one, the token's push access is checked then.
- `--param open_pr=false` keeps the specs on the local branch, as before.

## Acceptance

- With a project and the fake GitHub, the run waits for an approval whose summary names the files, then, once approved, a draft PR exists with the specs branch (also on the remote), the coverage and the index, `github.pr.opened` is recorded and the run is `done`.
- Without a project the run is refused; with `open_pr=false` it finishes with no PR.

## Not in this slice

- `spec-sync` addenda after merges, a Web UI view of the specs, merging new specs into earlier ones, a PR without a registered project.
