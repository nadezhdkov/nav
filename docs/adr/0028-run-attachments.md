# 0028 — Documents attached to a run

- Status: accepted
- Date: 2026-10-15
- Spec: §6.12.4 (new work from the Web UI), §10.2 (T1)
- Builds on: ADR 0002 (event store), ADR 0019 (run instructions), ADR 0020 (mobile)

## Context

The user wants to start runs from a spec or other notes about a new or existing project. Until now the only input was the prompt box, so a spec had to be pasted into it.

## Decision

- **A run takes attachments**: `CreateRunRequest.attachments`, a list of `{ name, content }`. They are UTF-8 text files only, no NUL. The limits are at most 10 files, 100 kB each and 200 kB in total, and the names must be unique plain file names with no path (`RunAttachments` in `packages/contracts`). The Web UI's New run reads files with the browser (picker or drag and drop), and the CLI has `navarch run --attach <file>...`.
- **They live in `run.created`**, next to the prompt they belong with, and are never written into the worktree. The Runner commits the worktree with `git add --all`, so a file placed there would end up in the run's commit and PR. `RunDetail.attachments` lists their names and sizes.
- **Every agent of the run reads them after its task**, in an `<attachments>` block of its instructions, one `<attachment name="…">` per document. A document cannot close the block early: attachment tags inside it are escaped. The user chose these documents, so the agents read them as requirements. Unlike issue text, which is untrusted, they are not delimited as hostile data. The profile's rules and the list of allowed commands still bound what an agent does with them.
- **Team members do not get them**: a member gets only the lead's brief (ADR 0022), and the lead quotes what a member needs.
- Paired devices may attach files too, since they can already start prompt runs.

## Consequences

- Each agent pays the attachments' tokens once per session. A resumed session does not see them again.
- A spec larger than 200 kB has to be split, or kept in the repository and named in the prompt.
- Binary files (images, PDFs) are refused. Extracting their text is left for later.
