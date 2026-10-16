# 0033 — Flow Studio: Studio Flows in the event store, YAML text as the source of truth

- Status: accepted
- Date: 2026-10-16
- Spec: §6.2.3 (Flow Studio), §9.4 (Flow format), §15.1, §16 (Phase 2 go/no-go), UC-11
- Slice: [`docs/specs/phase-2-04-flow-studio.md`](../specs/phase-2-04-flow-studio.md)
- Builds on: ADR 0011 (Flow engine), ADR 0017 (Web UI), ADR 0032 (subflows)

## Context

§6.2.3 asks for a visual editor with a library and a properties panel, a lossless Visual ⇄ YAML switch where "the YAML is the source of truth", live validation, a dry run with simulated outputs, and versions: Save Draft and an immutable Publish used by new runs. The Phase 2 go/no-go is to create a new Flow only in the UI and run it without editing YAML.

Today Flows are the YAML files of `flows/`, read once when the daemon starts. A Flow written in the UI needs somewhere to live, a version that runs can name, and a way to stay lossless while two views edit it.

## Decision

1. **Studio Flows live in the event store, as YAML text.** `flow.draft.saved`, `flow.draft.discarded` and `flow.published` carry the document's text, so comments and formatting survive, and the projections `flows` and `flow_versions` serve the API. A published version is immutable. Writing files into the repository or into `~/.navarch/flows/` was rejected: it would bypass the event log (architecture rule 2) and need a watcher to see edits made outside the Studio.
2. **Built-in Flows stay files and stay read-only in the Studio.** They ship with Navarch and change through pull requests. The Studio duplicates them under a new name. A Studio Flow cannot take a built-in's name, and a built-in added later shadows a Studio Flow with the same name instead of being shadowed by it, so an update can never be overridden silently.
3. **Runs name a Flow, and get its latest published version.** Built-ins are looked up first, then published Studio Flows. Drafts never run. The run records the source and version and keeps its copy (ADR 0011, ADR 0032), so publishing never changes a running run.
4. **Lossless editing works on the document, not on an object.** The canvas and the properties panel turn every gesture into edits on the `yaml` library's `Document` (set, delete, insert in a sequence, rewrite the `edges` chain), and the YAML view shows `String(document)`. Nothing re-serializes the Flow from a parsed object, so whatever the gesture did not touch stays byte for byte. Node positions are not stored: the layout comes from the chain, as in the run's TaskGraph, so the YAML holds no presentation data.
5. **The daemon validates and simulates. The UI only presents.** `checkFlow` and `simulateFlow` live in `packages/flow-engine`, and the Studio calls them through `POST /api/v1/flows/validate` and `/simulate` (architecture rule 1). The UI parses YAML only to draw the canvas, which must also draw invalid Flows: a disconnected node is something the user is in the middle of fixing.
6. **The simulation runs the engine's own step function.** `simulateFlow` feeds `next()` synthetic tasks that finish at once with the outputs the user chose, so it takes exactly the paths a run would take. `team` and `compete` nodes are one step each, because what happens inside them is decided by agents.
7. **Editing Flows is the user's alone.** `flow.save` and `flow.publish` are policy actions allowed only for the user. The routes are not open to paired devices, and the concierge has no tool for them. A Flow cannot raise privileges: it can only name known `uses`, profiles and adapters, and the policy decides approvals by action and autonomy level whatever the Flow contains.
8. **Drafts are guarded by a revision.** Saving, discarding and publishing name the draft revision the editor loaded, so a second tab gets `409` instead of overwriting.

## Consequences

- The go/no-go path exists: library → canvas → properties → Publish → New run.
- `parseFlow` keeps its behavior. `checkFlow` adds a list of problems with lines, and the orchestrator resolves Flows through a catalog of built-ins plus published Studio Flows instead of a fixed map.
- `apps/web` depends on `yaml` (already a dependency of `packages/flow-engine`) for the document model.
- Event payloads carry Flow YAML up to 64 KiB per save. That is small next to task logs, and saves are explicit actions, not keystrokes.
- Open: branching node types (`switch`, `parallel`, `join`) and free layout, deleting or archiving Studio Flows, promoting a Studio Flow into `flows/`, and a richer YAML editor.
