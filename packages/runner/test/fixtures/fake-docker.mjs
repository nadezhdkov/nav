#!/usr/bin/env node
// Fake container runtime for tests (ADR 0035): records each call as a JSON line in FAKE_DOCKER_LOG
// and runs `run`'s `sh -c <command>` on the host, in --workdir, with only the --env variables
// (plus PATH, so the test's commands resolve). FAKE_DOCKER_DOWN makes `version` fail like a stopped daemon.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const log = process.env.FAKE_DOCKER_LOG;
if (log) appendFileSync(log, JSON.stringify(args) + "\n");
if (args[0] === "version") {
  if (process.env.FAKE_DOCKER_DOWN) {
    process.stderr.write("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n");
    process.exit(1);
  }
  process.stdout.write("Server: 29.0.0\n");
  process.exit(0);
}
if (args[0] !== "run") process.exit(0);
// A hardened agent (ADR 0069): `… <image> node /opt/navarch/agent-entry.mjs <socket> -- <command> [args]`. The fake runs
// the command on the host, in --workdir, with only the --env variables plus PATH, and passes stdio through.
const entry = args.indexOf("/opt/navarch/agent-entry.mjs");
if (entry !== -1) {
  const dashes = args.indexOf("--", entry);
  const agentEnv = { PATH: process.env.PATH };
  for (const f of args.filter((a) => a.startsWith("--env="))) {
    const [k, ...v] = f.slice(6).split("=");
    agentEnv[k] = v.join("=");
  }
  const workdir = args.find((a) => a.startsWith("--workdir="))?.slice(10);
  const agent = spawnSync(args[dashes + 1], args.slice(dashes + 2), { cwd: workdir, env: agentEnv, stdio: "inherit" });
  process.exit(agent.status ?? 1);
}
const shAt = args.indexOf("sh");
const flags = args.slice(1, shAt - 1);
const value = (name) => flags.find((f) => f.startsWith(`--${name}=`))?.slice(name.length + 3);
const env = { PATH: process.env.PATH };
for (const f of flags.filter((f) => f.startsWith("--env="))) {
  const [k, ...v] = f.slice(6).split("=");
  env[k] = v.join("=");
}
const result = spawnSync("sh", ["-c", args[shAt + 2]], { cwd: value("workdir"), env, stdio: "inherit" });
process.exit(result.status ?? 1);
