import { readFileSync } from "node:fs";
import { permissionDecision, type PermissionPolicy } from "./permission.ts";

/**
 * Entry point Copilot runs for each permission request (`node permission-hook.ts <policy.json>`,
 * event on stdin). It prints `{"behavior":"allow"}` or `{}`, which leaves the request to Copilot's
 * own rules. Anything unexpected prints `{}` too: the hook only ever adds the grant's commands.
 */

let decision: unknown;
try {
  const policy = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as PermissionPolicy;
  decision = permissionDecision(JSON.parse(readFileSync(0, "utf8")), policy);
} catch (err) {
  process.stderr.write(`Navarch permission hook: could not check this call (${err instanceof Error ? err.message : String(err)}).\n`);
}
process.stdout.write(JSON.stringify(decision ?? {}));
