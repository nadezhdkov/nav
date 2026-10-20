// A stand-in for `claude -p --input-format stream-json --permission-prompt-tool stdio` (ADR 0074).
// A message containing "write" makes it ask permission to use Write and wait for the answer; any
// other message is answered at once. "apikey" makes it announce an API key login.
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const stateDir = process.argv[2];
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const log = (o) => stateDir && appendFileSync(`${stateDir}/session.jsonl`, `${JSON.stringify(o)}\n`);
const sessionId = process.argv.find((a, i, all) => all[i - 1] === "--session-id" || all[i - 1] === "--resume") ?? "fake-session";
log({ args: process.argv.slice(3), cwd: process.cwd() });

let init = false;
const waiting = new Map();
let cost = 0;

function ensureInit(text) {
  if (init) return;
  init = true;
  out({ type: "system", subtype: "init", session_id: sessionId, apiKeySource: /apikey/.test(text) ? "ANTHROPIC_API_KEY" : "none" });
}

async function turn(msg) {
  const text = msg.message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const images = msg.message.content.filter((b) => b.type === "image").length;
  log({ user: text, images });
  ensureInit(text);
  out({ type: "stream_event", event: { type: "message_start", message: {} }, parent_tool_use_id: null });
  for (const word of ["Working", " on", " it"]) out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: word } }, parent_tool_use_id: null });
  if (/write/.test(text)) {
    const request_id = `req-${cost}`;
    const answer = new Promise((resolve) => waiting.set(request_id, resolve));
    out({ type: "control_request", request_id, request: { subtype: "can_use_tool", tool_name: "Write", display_name: "Write", input: { file_path: `${process.cwd()}/hello.txt`, content: "hi" }, description: "hello.txt", tool_use_id: "toolu_1" } });
    const response = await answer;
    log({ response });
    if (response.behavior === "allow") {
      writeFileSync("hello.txt", response.updatedInput.content);
      out({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "Write", input: response.updatedInput }] }, parent_tool_use_id: null });
    }
    out({ type: "assistant", message: { content: [{ type: "text", text: response.behavior === "allow" ? "Wrote hello.txt." : `Refused: ${response.message}` }] }, parent_tool_use_id: null });
  } else {
    out({ type: "assistant", message: { content: [{ type: "text", text: `Working on it${images ? ` (saw ${images} image)` : ""}` }] }, parent_tool_use_id: null });
  }
  cost += 0.01;
  out({ type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: cost });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === "user") void turn(msg);
  else if (msg.type === "control_response") waiting.get(msg.response.request_id)?.(msg.response.response);
});
process.stdin.on("end", () => process.exit(0));
