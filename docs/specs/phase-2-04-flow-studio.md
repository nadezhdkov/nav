# Phase 2, slice 4: Flow Studio

Status: in progress · Branch: `feat/flow-studio` · Spec: §6.2.3 (Flow Studio), §6.2.2, §9.4, §15.1, §16 (Phase 2 go/no-go "create a new Flow only in the UI and run it without editing YAML"), UC-11 · ADR: 0033

The Web UI gets a **Flow Studio**: a canvas that edits Flows visually, with a library of node types, a properties panel, a YAML view that shows the same document, live validation, a dry-run simulation, and versions (Save draft, Publish). A published Flow is what new runs of that name execute, from the Web UI, the CLI and the concierge.

## Behavior

### Built-in and Studio Flows

- **Built-in** Flows are the YAML files of `flows/`, loaded when the daemon starts, as today. They are read-only in the Studio. "Duplicate" copies one into a new Studio Flow.
- **Studio** Flows live in the event store. Their YAML text is stored as written, with comments and key order:
  - `flow.draft.saved` `{ name, yaml, revision, based_on }`: the user saved the draft. `revision` counts the saves of the current draft from 1, and `based_on` is the published version it started from (null for a new Flow).
  - `flow.draft.discarded` `{ name }`: the user dropped the draft.
  - `flow.published` `{ name, version, yaml, sha256 }`: the user published the draft as `version` (1, 2, …). A published version never changes. Publishing clears the draft.
  - Projection `flows` (one row per Studio Flow, with its draft) and `flow_versions` (one row per published version).
- A Flow's name is its `metadata.name` and never changes. A Studio Flow cannot take a built-in's name. Saving YAML whose `metadata.name` is not the Flow's name is refused. To rename a Flow, duplicate it.
- A draft may be invalid, including invalid YAML: it is work in progress. It is at most 64 KiB.
- Saving or publishing names the draft revision the editor last loaded. A stale one gets `409 conflict`, so two tabs cannot overwrite each other. The editor then offers to reload.
- Publishing needs a draft with no validation errors. It validates again on the daemon, with every Flow known at that moment.
- If an update adds a built-in with the name of an existing Studio Flow, the built-in wins. The Studio Flow is listed as `shadowed`, and runs cannot use it until it is duplicated under another name.

### Running a Studio Flow

- `--flow <name>` (CLI, `CreateRunRequest.flow`, concierge `start_run`, Inbox start) looks up the built-in Flows first, then the **latest published version** of the Studio Flows. A Studio Flow with only a draft cannot run (`invalid_request`, "publish it first").
- A Studio Flow may run as the child of a `subflow` node: a built-in or a published Studio Flow, with the usual one-level rules of ADR 0032. Built-in Flows never name Studio Flows.
- `run.created` records `flow.source` (`builtin` | `studio`) and, for Studio Flows, `flow.version`. The run already keeps a copy of its Flow and its children, so publishing a new version never changes a running run. `RunDetail.flow_version` shows it.
- Everything else about a run is the same as for built-in Flows. Policy still decides approvals by autonomy level and action (`github.pr.create`, `verification.run`, `task.start`, …), so a Flow without `approval` nodes cannot skip an approval the policy requires. A Flow with a `compete` node still needs `--budget`.

### Validation

- `checkFlow(yaml, catalog)` in `packages/flow-engine` returns **every** problem instead of the first, each with `severity` (`error` | `warning`), a `message`, and when known the `node`, the YAML `path` and the 1-based `line`. `parseFlow` still throws the first error with today's messages.
- Errors (block Publish):
  - YAML that does not parse, or a field that does not fit the schema (all Zod issues, each at its line)
  - node types not supported yet (`switch`, `parallel`, `join`, …)
  - duplicate node ids, unknown `uses`
  - **disconnected nodes**: a top-level node that is not in `edges`
  - **cycles without a loop**: a node that appears twice in `edges` ("repeat a step with a loop node")
  - more than one trigger, or a trigger that is not first
  - **unknown Agent Profile** in `agent`, `team.lead` and `compete.judge`, and an unknown `adapter`
  - unknown subflow Flow, a subflow param the child does not have, a nested composite node in the child, or a subflow naming a Studio Flow that has only a draft
  - expressions that do not parse or name an unknown node or param
  - **incompatible references**: an expression that reads `nodes.<x>` of a node that runs later in the chain, or not at all before this node (a loop's `until` may read its own body)
  - a param used as a number (`max_iterations`, `max_turns`, `competitors`, …) whose declared type is not `int`
- Warnings (shown, never block):
  - a Flow with no `agent`, `team` or `compete` node
  - a `github` `pr.create` with no node that can edit before it
- The Studio checks the open document through `POST /api/v1/flows/validate` within about 300 ms of each change. The toolbar shows "✓ Valid" or "✕ N errors · M warnings". The canvas marks nodes that have problems with an icon and the count, and the YAML view marks their lines.

### Simulation (dry run)

- `simulateFlow(flow, options)` in `packages/flow-engine` walks the Flow with the real step function, `next()`. It never creates tasks or events and never calls agents.
- Each started task finishes at once:
  - with the outputs the user gave for that node, for each iteration (the last one repeats), or else:
    - `verification.run` → `{ passed: true }`
    - an agent → `{ summary: "(simulated)" }`
  - as failed, for nodes the user marks to fail
  - approvals are approved, unless the user marks them rejected
- `team` and `compete` nodes are simulated as one step with outputs `{ summary }`. Their inside depends on what the agents decide, so it cannot be simulated. Subflows run their child's steps.
- Options: the Flow's params (defaults otherwise), `autonomy_level` (default 2) for `when` conditions on `project.autonomy_level`, and per-node outcomes. The walk stops after 200 steps.
- The result is the list of steps (`start` with the node, iteration, run stage and outputs, or `skip` with its reason) and the end: `done` (and whether a PR would open), `fail` with the reason, or `limit`.
- `POST /api/v1/flows/simulate` `{ yaml, params?, autonomy_level?, outcomes? }` validates first and simulates only a Flow without errors.
- The Studio's Simulate panel lets the user set the autonomy level, the params and, per node, "fails", "rejected" or outputs (`passed: false` for N iterations, a `kind`, …). It lights the path on the canvas and lists the steps.

### API

All routes are desktop only (not in `DEVICE_ROUTES`) and need the token:

| Route | Does |
|---|---|
| `GET /api/v1/flows` | every Flow: name, description, source, published version, draft revision and save time, node count, `shadowed` |
| `GET /api/v1/flows/:name` | one Flow: the draft's YAML, the latest published YAML (or the built-in's), and the versions with their time and actor |
| `GET /api/v1/flows/:name/versions/:version` | the YAML of a published version |
| `PUT /api/v1/flows/:name/draft` | `{ yaml, revision }` saves the draft (policy `flow.save`) |
| `DELETE /api/v1/flows/:name/draft` | `{ revision }` discards it (policy `flow.save`) |
| `POST /api/v1/flows/:name/publish` | `{ revision }` publishes the draft (policy `flow.publish`) |
| `POST /api/v1/flows/validate` | `{ yaml, name? }` → `{ problems }` |
| `POST /api/v1/flows/simulate` | see above |

- Policy actions `flow.save` and `flow.publish` are allowed for the user only. Agents, the concierge and paired devices get `deny`.
- Contracts: `FlowSummary`, `FlowDetail`, `FlowProblem`, `SimulationRequest`, `SimulationResult` in `packages/contracts`.

### CLI

- `navarch flow list`: built-in and Studio Flows with their versions.
- `navarch flow show <name> [--version N] [--draft]`: prints the YAML.
- `navarch flow validate <file>`: prints the problems with their lines, and exits 1 when there are errors.

### Web UI

- `/flows` (desktop sidebar "Flows"): the list of Flows, with source, published version, draft state and description, and the actions New Flow, Open and Duplicate.
- `/flows/:name`, the Studio, desktop only:
  - **Top bar**: the name, a version chip (`v3 · draft r2`, or `built-in`), the Visual | YAML switch, the problem indicator (opens the Problems panel), Simulate, Save draft (Ctrl+S) and Publish.
  - **Left, library**: the node types the engine runs (`agent`, `action`, `approval`, `loop`, `github`, `subflow`, `team`, `compete`, `trigger`), each with an icon, a name and one line about it. Click one to add it after the selected node, or drag it onto the canvas or onto an edge.
  - **Center, canvas** (Vue Flow, graphite theme, the TaskGraph's node style with per-type accents):
    - The Flow drawn left to right in chain order, wrapping into rows like the run's TaskGraph, with loops as groups around their body.
    - A dropped node that is not on an edge stays disconnected, off the chain, and is marked as a problem until it is connected.
    - Dragging from a node's output handle to another node puts that node right after it in the chain.
    - Delete removes the selected node and its edges (the chain closes over the gap). The arrow keys walk the nodes, and Enter focuses the properties.
    - Node positions are not stored: the layout always comes from the chain.
  - **Right, properties**: a form for the selected node type (id, name, `when`, profile from the daemon's profiles, adapter, inputs, `uses`, `with`, loop limits and `until`, team and compete fields, the subflow's Flow and params), plus the Flow's metadata and params when nothing is selected.
  - **YAML**: the same document as text, with line numbers and problem markers. Switching views loses nothing: every visual edit changes only the YAML it concerns, through the `yaml` library's document model, so comments, key order and formatting elsewhere stay as written.
  - **Bottom panels**: Problems (click one to select its node or line) and Simulation.
  - **Publish** opens a confirmation with the line diff from the last published version, the validation state, and the note "new runs use vN; running runs keep their copy".
  - A built-in Flow opens read-only, with Duplicate.
  - Leaving with unsaved changes asks first.
- New run lists the published Studio Flows under the built-in modes ("Your flows") and shows their params with their defaults. Phones keep `task`.
- The run page shows `flow · vN` for runs of Studio Flows.
- Every string goes through i18n in all five locales.

## Out of scope

- New node types (`switch`, `parallel`/`fan-out`, `join`, `judge`, `llm`) and branching edges: the engine still runs one chain (ADR 0011). The canvas shows only what the engine runs.
- Stored node positions and free layout.
- Deleting or archiving Studio Flows, and importing or exporting them as files (copy the YAML view).
- Editing Flows from the concierge or a phone.
- A code editor component (syntax highlighting, completion) for the YAML view; it is a plain monospaced text area.
- Promoting a Studio Flow into `flows/` in the repository.

## Acceptance

- A Flow created only through the Studio (library, canvas, properties; never the YAML view) validates, publishes as v1, and runs from New run like a built-in Flow (go/no-go §16).
- Switching Visual ⇄ YAML on every built-in Flow, after a visual edit, changes only the edited lines: comments and the rest of the formatting stay the same (unit test over `flows/*.yaml`).
- Validation reports disconnected nodes, cycles without a loop, unknown profiles, and references to later nodes, each with its node and line, and Publish stays disabled while there are errors.
- The simulation of `fix-issue` with `verify` failing twice and passing on the third iteration shows three implement ⇄ verify iterations, then review and PR. With it failing three times, it ends in `fail`.
- Publishing v2 while a run of v1 is running leaves that run on v1, and the next run uses v2.
- A stale `revision` gets 409. A built-in name or a renamed `metadata.name` gets 400. A paired device gets 403 on every `/api/v1/flows` route.
