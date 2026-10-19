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

it("limits how often the audit routes may scan the whole event log", async () => {
  const home = tempHome();
  daemon = new Daemon({ home, config: Config.parse({ daemon: { port: 0 }, routing: { enabled: false } }), adapters: { "claude-code": fakeClaude("flow").options } });
  await daemon.start();
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const get = async (path: string) => (await fetch(daemon!.url + path, { headers: { authorization: `Bearer ${token}` } })).status;

  const first = await Promise.all(Array.from({ length: 30 }, () => get("/api/v1/audit")));
  expect(first.every((s) => s === 200)).toBe(true);
  expect(await get("/api/v1/audit")).toBe(429);
  // Other routes are not limited.
  expect(await get("/api/v1/runs")).toBe(200);
});
