import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./fixtures/fake-docker.mjs", import.meta.url));

/** A fake `docker` command (ADR 0035) and the calls it received, each as its argument list. */
export function fakeDocker(opts: { down?: boolean } = {}): { runtime: string; calls: () => string[][] } {
  const dir = mkdtempSync(join(tmpdir(), "navarch-fake-docker-"));
  const log = join(dir, "calls.jsonl");
  const runtime = join(dir, "docker");
  const env = `FAKE_DOCKER_LOG='${log}'${opts.down ? " FAKE_DOCKER_DOWN=1" : ""}`;
  writeFileSync(runtime, `#!/bin/sh\n${env} exec "${process.execPath}" '${script}' "$@"\n`);
  chmodSync(runtime, 0o755);
  return {
    runtime,
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : []),
  };
}
