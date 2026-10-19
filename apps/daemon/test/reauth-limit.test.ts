import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { fakeClaude } from "../../../packages/adapters/claude-code/test/fake.ts";
import { tempHome } from "../../../packages/runner/test/helpers.ts";
import { Config } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";

let daemon: Daemon | undefined;
afterEach(async () => {
  await daemon?.stop().catch(() => {});
  daemon = undefined;
});

it("limits how often a re-authentication may be attempted", async () => {
  const home = tempHome();
  daemon = new Daemon({ home, config: Config.parse({ daemon: { port: 0 }, routing: { enabled: false } }), adapters: { "claude-code": fakeClaude("flow").options } });
  await daemon.start();
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const post = async (path: string) =>
    (await fetch(daemon!.url + path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" })).status;

  const statuses = await Promise.all(Array.from({ length: 21 }, () => post("/api/v1/reauth/options")));
  expect(statuses.filter((s) => s === 429)).toHaveLength(1);
  // Each route counts on its own.
  const verify = await Promise.all(Array.from({ length: 21 }, () => post("/api/v1/reauth/verify")));
  expect(verify.filter((s) => s === 429)).toHaveLength(1);
});
