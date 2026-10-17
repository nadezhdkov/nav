# Agents

Navarch drives agent CLIs you install and sign in to yourself, plus its own tool loop for local and API models. Each one is an **adapter** behind the same contract, so a Flow never depends on a particular agent.

## Supported adapters

| Adapter | Runs | Sign-in | Resumes a session |
|---|---|---|---|
| `claude-code` (default) | `claude -p` | the `claude` CLI | yes |
| `codex` | `codex exec` | `codex login` (ChatGPT plan) | yes |
| `gemini-cli` | `gemini --prompt` | `GEMINI_API_KEY` from AI Studio | yes |
| `antigravity` | `agy --print` | a Google account | yes |
| `copilot` | `copilot -p` | `copilot login` (each prompt uses premium requests) | yes |
| `opencode` | `opencode run` | `opencode auth login`; Zen's free models need no key | yes |
| `kilo` | `kilo run` | none for the free models | yes |
| `grok` | `grok --prompt-file` | `grok login` (grok.com, free tier included) | yes |
| `native` | Navarch's own tool loop | `ollama/<model>`, `openrouter/<model>`, `opencode-zen/<model>` | no |

Keys for the `native` adapter go in the vault, never in a file:

```sh
navarch secret set openrouter/api_key
navarch secret set opencode/api_key
```

## Agents run with Navarch's configuration, not yours

Navarch starts each agent with its own settings, so your personal setup does not leak into runs. Claude Code runs without your user-level settings, and gemini-cli, OpenCode and Grok each get a per-task home or config directory. Your MCP servers, skills and memory stay out of them.

The task prompt lists the commands the agent may run, and each adapter translates that grant into the agent's own permission rules. A command outside the grant is denied.

## Pick one, or let the router pick

Pin an agent for a whole run with `--adapter` (and `--model`):

```sh
navarch run --adapter codex "Add a unit test for parse_date"
navarch run --adapter native --model ollama/qwen2.5:7b "Update the usage section in README.md"
navarch run --adapter native --model openrouter/<model>:free "…"
```

Without them, the **Model Router** chooses an agent for each task when it is dispatched:

- **Tiers per profile.** `fast` for triage, and for planning and implementation when triage says the complexity is 2 or less. `standard` otherwise, and `expert` for leads and judges.
- **A different reviewer.** The reviewer goes to a provider other than the implementer's.
- **Quota-aware.** Exhausted quotas are skipped. Agents whose quota window is 90 % used, or that failed half of their recent attempts, go to the back of the line.
- **Instant fallback.** A rate limit falls back to the next candidate at once, and the limited agent is skipped until its reset.
- **Budget-aware.** A metered agent whose usual cost is more than the budget left is skipped.

Every decision is recorded as a `model.routed` event with its reason, so you can see why a task went where it did.

## Free models

Free models are catalog entries like any other: OpenRouter `:free` models on the `native` adapter, OpenCode Zen's free models on `opencode`, and Kilo's free models on `kilo`. An entry whose provider has no key is skipped, and a provider's daily free limit counts as a quota.

Small local models are free but make more mistakes. Always read the diff.

## Adding an adapter

An adapter implements one interface from `packages/contracts`, translates the neutral tool grant into its CLI's permissions, and ships with a fake CLI and contract tests. See `AGENTS.md` in the repository.
