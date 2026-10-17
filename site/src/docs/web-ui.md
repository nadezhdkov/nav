# Web UI

The daemon serves the Web UI on `127.0.0.1`. Open it with:

```sh
navarch web           # opens your browser with a single-use sign-in code
navarch web --print   # prints the link instead
```

The sign-in code is used once, so your API token never ends up in a URL or in your shell history. Everything updates live over the daemon's event stream. The interface speaks English, Brazilian Portuguese, Spanish, German and Simplified Chinese. It follows your browser, and you can pick another language in the sidebar.

## Screens

- **Home**: what needs you (approvals, alerts), today's cost, agent quota windows, the Inbox and active runs.
- **Runs**: every run with its status, Flow, repository and cost against budget.
- **Run detail**: the live **task graph** of the run's Flow. Each node shows its status as an icon and a word, plus its agent and model, loop iterations and the fix loop. Amber gates mark where a human decides. Select a node to see its output, cost and artifacts. The **timeline** is the run's full event log, and **logs** stream the agent's output.
- **Fleet**: every agent of every active run, as a **tree** (project → run → agents) or as cards. Team runs show the lead above the members it delegated to. Each card shows step progress, cost, adapter and model, branch and what the agent is doing now.
- **Approvals**: what will happen, why it needs you, the cost so far, then approve or reject with a reason.
- **Inbox**: issues from your registered projects, triaged and estimated, ready to start as runs, alone or as a team.
- **Usage**: spend, budgets, and per-agent quality and cost.
- **Flows**: the built-in Flows and your own, with Flow Studio (desktop).
- **New run**: start from a prompt, an issue or the Inbox, in a registered project, an earlier repository or any GitHub repository your token reaches. Attach a spec or notes for the agents to read.

## Talking to an agent

Every agent card in the Fleet has a prompt box: type an instruction and the agent gets it in its next turn. Open the agent to see:

- **Chat**: progress, each attempt's result, and your instructions. A team's lead shows the whole conversation across turns.
- **Output** and **Log**: what the agent printed.
- **Worktree**: the files it changed so far, with added and removed lines, and each file's diff, read live without touching the agent's git index.

You can interrupt a running agent right away when it needs to change course. It resumes its session with your message.

## Keyboard and accessibility

The UI is dark by default and light when your system asks for it. Status never relies on colour alone. Arrow keys walk the Fleet tree, Enter opens an agent or folds a run, and Esc closes the panel.
