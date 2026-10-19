import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { ConciergeTurn, ProposalDecision } from "@navarch/contracts";
import { CliError } from "./client.ts";
import { stripControls } from "./safe.ts";

/**
 * `navarch` / `navarch chat`: a conversation with the concierge running in the daemon (ADR 0016).
 * The CLI only relays text; a proposal runs only after an explicit yes typed here.
 */

export type ChatApi = { request<T>(method: string, path: string, body?: unknown): Promise<T> };

const HELP = `Ask in plain language, e.g. "what is running?", "why did the last run fail?",
"start a run here to add a CONTRIBUTING.md". Changes are proposed first and need your yes.
  /new   start a fresh conversation
  /help  this text
  /exit  leave (or Ctrl-D)
`;

export async function chat(api: ChatApi, io: { input: Readable; output: Writable; cwd: string }): Promise<number> {
  const out = (text: string) => io.output.write(text);
  const lines = lineReader(io.input, io.output);
  const open = async () => (await api.request<{ id: string }>("POST", "/api/v1/concierge/conversations", { cwd: io.cwd })).id;

  out(`navarch concierge · ${io.cwd} · /help for help\n`);
  let conversation = await open();
  try {
    for (;;) {
      const line = await lines.next("navarch> ");
      if (line === undefined) break;
      const text = line.trim();
      if (!text) continue;
      if (text === "/exit" || text === "/quit") break;
      if (text === "/help") {
        out(HELP);
        continue;
      }
      if (text === "/new") {
        conversation = await open();
        out("(new conversation)\n");
        continue;
      }

      let turn: ConciergeTurn;
      try {
        turn = await api.request<ConciergeTurn>("POST", `/api/v1/concierge/conversations/${conversation}/messages`, { text });
      } catch (err) {
        if (!(err instanceof CliError) || err.exitCode !== 1) throw err;
        out(`! ${err.message}\n`);
        continue;
      }
      out(`${indent(stripControls(turn.reply))}\n`);

      for (const proposal of turn.proposals) {
        out(`\n  Proposed: ${stripControls(proposal.summary)}\n`);
        const answer = await lines.next("  Confirm? [y/N] ");
        const decision = /^(y|yes|s|sim)$/i.test(answer?.trim() ?? "") ? "approve" : "reject";
        try {
          const decided = await api.request<ProposalDecision>("POST", `/api/v1/concierge/conversations/${conversation}/proposals/${proposal.id}`, { decision });
          out(`  ${stripControls(decided.reply)}\n`);
        } catch (err) {
          if (!(err instanceof CliError) || err.exitCode !== 1) throw err;
          out(`! ${err.message}\n`);
        }
        if (answer === undefined) break;
      }
      out("\n");
    }
  } finally {
    lines.close();
  }
  return 0;
}

/** Prompts and reads one line at a time; resolves undefined once the input ends. */
function lineReader(input: Readable, output: Writable) {
  const rl = createInterface({ input, output, terminal: Boolean((input as { isTTY?: boolean }).isTTY) });
  const queued: string[] = [];
  let waiting: ((line: string | undefined) => void) | undefined;
  let closed = false;
  rl.on("line", (line) => {
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve(line);
    } else queued.push(line);
  });
  rl.on("close", () => {
    closed = true;
    waiting?.(undefined);
    waiting = undefined;
  });
  return {
    next(prompt: string): Promise<string | undefined> {
      output.write(prompt);
      if (queued.length) return Promise.resolve(queued.shift());
      if (closed) return Promise.resolve(undefined);
      return new Promise((resolve) => (waiting = resolve));
    },
    close: () => rl.close(),
  };
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => (l ? `  ${l}` : l))
    .join("\n");
}
