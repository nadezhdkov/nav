# Budgets and quotas

Navarch keeps two kinds of spending apart:

- **Billed** use: API keys you pay per token (the `native` adapter, OpenCode with a key, Claude Code with an API key). **Budgets count only this.**
- **Plan** use: subscriptions such as Claude Code signed in to claude.ai, Codex, Copilot, Gemini or Antigravity. Navarch records its API-equivalent cost separately and bounds it with **quotas**, not budgets.

## Budgets

| Scope | Default | Set with |
|---|---|---|
| Per run | $2 | `--budget <usd>` on `navarch run` |
| Per project, per local day | none | `navarch budget set --project <id> --daily <usd>` |
| Global, per local month | $100 | `navarch budget set --monthly <usd>` |

```sh
navarch budget                         # current limits and spend
navarch budget set --monthly 50
navarch budget set --run brave-frigate 5
```

How they hold:

- A running billed agent **holds its cap** against every scope, so two agents cannot both spend the same remaining dollar.
- At 80 % of a budget you get a `budget.threshold` notification, and another at 100 %.
- When a scope is used up, the next agent task **waits for your approval** (`budget.exceed`) and the run shows `budget_exceeded`. Raising the limit approves the waiting tasks.
- Compete runs need an explicit `--budget`, since several agents work at once.

## Quotas

Agents report their own limits: Claude Code and Codex quota windows, Copilot's monthly premium requests, free-tier daily limits. Navarch records them as `quota.observed` events and shows them on Home and on the Usage screen.

When an agent runs out:

- The task **waits for the reset** the agent reported (or backs off), then resumes the same conversation.
- If the reset is **more than 12 hours away**, the run pauses until `navarch run resume <id>`.
- The Model Router skips exhausted agents and keeps a reserve: agents above 90 % of a window go after the others.

## Usage

The **Usage** screen in the Web UI shows spend today and this month, budget bars, and a table per agent and model. The table covers tasks, success and error rates, tokens, cost per succeeded attempt, billed versus plan-equivalent cost, and median time. From the terminal:

```sh
navarch usage --days 30
navarch usage --profile implementer
```
