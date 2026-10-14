import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** A scripted OpenAI-compatible `/chat/completions` endpoint. */

export type Scripted =
  | { tool_calls: { name: string; args: Record<string, unknown> }[]; content?: string; cost?: number }
  | { content: string; cost?: number }
  | { status: number; body: unknown };

export type FakeServer = {
  baseUrl: string;
  requests: { model: string; messages: { role: string; content: string | null; tool_call_id?: string }[]; tools?: { function: { name: string } }[] }[];
  close: () => Promise<void>;
};

export async function fakeModelServer(script: Scripted[]): Promise<FakeServer> {
  const requests: FakeServer["requests"] = [];
  let turn = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      requests.push(JSON.parse(body));
      const step = script[Math.min(turn++, script.length - 1)]!;
      if ("status" in step) {
        res.writeHead(step.status, { "content-type": "application/json" }).end(JSON.stringify(step.body));
        return;
      }
      const toolCalls =
        "tool_calls" in step
          ? step.tool_calls.map((c, i) => ({ id: `call_${turn}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }))
          : undefined;
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: step.content ?? null, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 50, completion_tokens: 10, ...(step.cost !== undefined ? { cost: step.cost } : {}) },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
