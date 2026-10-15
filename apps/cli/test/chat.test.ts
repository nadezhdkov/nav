import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { chat, type ChatApi } from "../src/chat.ts";
import { CliError } from "../src/client.ts";

type Call = { method: string; path: string; body?: unknown };

/** A Core API stand-in: conversation ids count up, replies come from `answer`. */
function stubApi(answer: (text: string, conversation: string) => unknown) {
  const calls: Call[] = [];
  let conversations = 0;
  const api: ChatApi = {
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      calls.push({ method, path, ...(body !== undefined ? { body } : {}) });
      if (path === "/api/v1/concierge/conversations") return { id: `conv_${++conversations}` } as T;
      const message = /conversations\/(\w+)\/messages$/.exec(path);
      if (message) return answer((body as { text: string }).text, message[1]!) as T;
      if (/proposals\/(\w+)$/.test(path)) {
        const decision = (body as { decision: string }).decision;
        return { reply: decision === "approve" ? "run run_9 created (executing)" : "Declined: start a run", proposal: {} } as T;
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  return { api, calls };
}

async function session(api: ChatApi, lines: string[]) {
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = "";
  output.on("data", (d) => (printed += d));
  const done = chat(api, { input, output, cwd: "/work/repo" });
  for (const line of lines) input.write(`${line}\n`);
  input.end();
  return { code: await done, printed };
}

const proposal = { id: "prop_1", tool: "start_run", args: {}, summary: "start a task run in /work/repo (routed): \"add docs\"", status: "pending" };

describe("navarch chat", () => {
  it("sends each line to the concierge in one conversation and prints the replies", async () => {
    const { api, calls } = stubApi((text) => ({ reply: `you said ${text}`, proposals: [], model: "m" }));
    const { code, printed } = await session(api, ["hello", "", "what is running?", "/exit"]);
    expect(code).toBe(0);
    expect(calls[0]).toEqual({ method: "POST", path: "/api/v1/concierge/conversations", body: { cwd: "/work/repo" } });
    expect(calls.filter((c) => c.path.endsWith("/messages")).map((c) => (c.body as { text: string }).text)).toEqual(["hello", "what is running?"]);
    expect(printed).toContain("you said hello");
    expect(printed).toContain("you said what is running?");
  });

  it("asks before running a proposal and sends the operator's answer", async () => {
    const { api, calls } = stubApi((text) => ({ reply: "I proposed a run.", proposals: text === "add docs" ? [proposal] : [], model: "m" }));
    const { printed } = await session(api, ["add docs", "y"]);
    expect(printed).toContain('Proposed: start a task run in /work/repo (routed): "add docs"');
    expect(printed).toContain("Confirm? [y/N]");
    expect(printed).toContain("run run_9 created (executing)");
    expect(calls.at(-1)).toEqual({ method: "POST", path: "/api/v1/concierge/conversations/conv_1/proposals/prop_1", body: { decision: "approve" } });
  });

  it("declines anything but an explicit yes", async () => {
    const { api, calls } = stubApi(() => ({ reply: "Proposed.", proposals: [proposal], model: "m" }));
    const { printed } = await session(api, ["add docs", "sure, why not"]);
    expect(calls.at(-1)?.body).toEqual({ decision: "reject" });
    expect(printed).toContain("Declined");
  });

  it("starts a fresh conversation on /new and keeps going after an error", async () => {
    const { api, calls } = stubApi((text) => {
      if (text === "boom") throw new CliError("503: no model for the concierge");
      return { reply: "ok", proposals: [], model: "m" };
    });
    const { code, printed } = await session(api, ["boom", "/new", "hi"]);
    expect(code).toBe(0);
    expect(printed).toContain("no model for the concierge");
    expect(calls.filter((c) => c.path === "/api/v1/concierge/conversations")).toHaveLength(2);
    expect(calls.at(-1)?.path).toBe("/api/v1/concierge/conversations/conv_2/messages");
  });
});
