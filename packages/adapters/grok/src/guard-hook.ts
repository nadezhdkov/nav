import { readFileSync } from "node:fs";
import { guardDecision, type GuardPolicy } from "./guard.ts";

/**
 * Entry point Grok runs for each tool call (`node guard-hook.ts <policy.json>`, event on stdin).
 * A deny is written as JSON and also signalled by exit 2, so either way Grok refuses the call.
 * Anything unexpected denies too: a guard that cannot read its policy must not let calls through.
 */

try {
  const policy = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as GuardPolicy;
  const event = JSON.parse(readFileSync(0, "utf8"));
  const decision = guardDecision(event, policy);
  if (decision) {
    process.stdout.write(JSON.stringify(decision));
    process.stderr.write(`${decision.reason}\n`);
    process.exitCode = 2;
  }
} catch (err) {
  const reason = `Navarch guard: could not check this call (${err instanceof Error ? err.message : String(err)}).`;
  process.stdout.write(JSON.stringify({ decision: "deny", reason }));
  process.stderr.write(`${reason}\n`);
  process.exitCode = 2;
}
