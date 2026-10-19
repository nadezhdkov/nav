# Talk to it

Run `navarch` with no arguments (or `navarch chat`) and ask in plain language:

- "What is running?"
- "Why did the last run fail?"
- "Start a run here to add a CONTRIBUTING.md."
- "Approve the plan for brave-frigate."

The **concierge** is an agent that runs inside the daemon and reads Navarch's state on its own: runs, events, approvals, the Inbox, usage.

In a terminal, `navarch` greets you with the mascot, a helm wheel and the name, then where you are: project, repository (without credentials), workspace, branch and how many agents are running, and `System ready`. The mascot needs a terminal with true colour and at least 78 columns; narrower terminals get the name and the lines of text only, and `NO_COLOR` turns colour off. Without a terminal, such as in a pipe, it prints one plain line. The prompt is `nav>`. The same chat is on your phone: see [On your phone](/docs/phone).

## It proposes, you decide

Read tools run at once. Anything that **changes something** (starting, cancelling, pausing or resuming a run, sending an instruction to its agents, approving or rejecting) becomes a **single-use proposal**. It runs, as you, only after you type `y`.

```text
› resume the run that failed on lint
proposal: resume_run witty-knarr  [y/N] y
resumed · its failed tasks are ready again
```

`navarch ask "<question>"` asks once and never acts: proposals are shown, not run.

## Pick its model

The concierge needs an API model with tool calling. Pin one in `~/.navarch/config.yaml`:

```yaml
concierge:
  model: ollama/qwen2.5:7b                      # local, slower
  # model: openrouter/<model>:free              # free, with a daily limit
```

Without `concierge.model`, it uses the first usable `native` model of the `fast` tier from your routing config, and falls back to the next one on rate limits.

Conversations live in the daemon's memory, and each message is also recorded as an event.
