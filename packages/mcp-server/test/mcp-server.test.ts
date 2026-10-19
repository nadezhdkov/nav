import { describe, expect, it } from "vitest";
import { handleMessage, PROTOCOL_VERSION, serveStdio, TOOLS } from "../src/index.ts";

const calls: string[] = [];
const api = {
  get: async (path: string) => {
    calls.push(path);
    if (path.startsWith("/search?q=boom")) throw new Error("404: project");
    return [{ file: "a.ts", line: 1, text: "x" }];
  },
};

describe("MCP server", () => {
  it("answers initialize with the client's version when supported, else its own", async () => {
    const ok = await handleMessage(api, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    expect((ok!.result as { protocolVersion: string }).protocolVersion).toBe("2024-11-05");
    const other = await handleMessage(api, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999" } });
    expect((other!.result as { protocolVersion: string }).protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it("lists only read-only tools", async () => {
    const res = await handleMessage(api, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (res!.result as { tools: { name: string; annotations: { readOnlyHint: boolean } }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
  });

  it("calls the Core API with the arguments encoded", async () => {
    calls.length = 0;
    const res = await handleMessage(api, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "repo_symbols", arguments: { query: "a b&c", kind: "function" } } });
    expect(calls).toEqual(["/symbols?q=a%20b%26c&kind=function"]);
    expect((res!.result as { content: { text: string }[] }).content[0]!.text).toContain("a.ts");
  });

  it("serves the traceability matrices without arguments", async () => {
    calls.length = 0;
    await handleMessage(api, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "traceability", arguments: {} } });
    expect(calls).toEqual(["/traceability"]);
  });

  it("reports a failing call as a tool error and a missing argument as invalid params", async () => {
    const failed = await handleMessage(api, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "repo_search", arguments: { query: "boom" } } });
    expect(failed!.result).toMatchObject({ isError: true });
    const missing = await handleMessage(api, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "repo_search", arguments: {} } });
    expect(missing!.error!.code).toBe(-32602);
    const unknown = await handleMessage(api, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "cmd_run", arguments: {} } });
    expect(unknown!.error!.code).toBe(-32602);
  });

  it("ignores notifications and rejects unknown methods", async () => {
    expect(await handleMessage(api, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
    expect((await handleMessage(api, { jsonrpc: "2.0", id: 7, method: "resources/list" }))!.error!.code).toBe(-32601);
  });

  it("serves lines over a stream, including a parse error and a message split across chunks", async () => {
    const out: string[] = [];
    const line = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    async function* input() {
      yield "not json\n";
      yield line.slice(0, 10);
      yield `${line.slice(10)}\n`;
    }
    await serveStdio(api, input(), (l) => out.push(l));
    const replies = out.map((l) => JSON.parse(l));
    expect(replies.some((r) => r.error?.code === -32700)).toBe(true);
    expect(replies.some((r) => r.id === 1 && r.result)).toBe(true);
  });
});
