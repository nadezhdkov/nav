/** Links and facts shared by the pages. */
export const GITHUB = "https://github.com/nadezhdkov/nav";
export const asset = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\//, "")}`;

/** The agents Navarch runs, as the adapter table in AGENTS.md lists them. */
export const AGENTS = [
  { id: "claude-code", name: "Claude Code", runs: "claude -p", signIn: "the claude CLI" },
  { id: "codex", name: "Codex", runs: "codex exec", signIn: "codex login (ChatGPT plan)" },
  { id: "gemini-cli", name: "Gemini CLI", runs: "gemini --prompt", signIn: "GEMINI_API_KEY (AI Studio)" },
  { id: "antigravity", name: "Antigravity", runs: "agy --print", signIn: "Google account" },
  { id: "copilot", name: "GitHub Copilot CLI", runs: "copilot -p", signIn: "copilot login (Copilot plan)" },
  { id: "opencode", name: "OpenCode", runs: "opencode run", signIn: "opencode auth login; Zen's free models need no key" },
  { id: "kilo", name: "Kilo CLI", runs: "kilo run", signIn: "none for the free models" },
  { id: "grok", name: "Grok CLI", runs: "grok --prompt-file", signIn: "grok login (grok.com, free tier included)" },
  { id: "native", name: "Local & API models", runs: "Navarch's own tool loop", signIn: "Ollama, OpenRouter, OpenCode Zen" },
] as const;
