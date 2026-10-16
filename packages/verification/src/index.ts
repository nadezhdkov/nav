import { redact, type ContainerIsolation, type VerificationCheck, type VerificationReport } from "@navarch/contracts";
import { containerRuntimeProblem, gitCommonDir, hostUser, runInContainer, runShell } from "@navarch/runner";

/**
 * Verification (spec §6.6): runs the project's own checks in a task's worktree and turns them into
 * a `VerificationReport`. The commands come from `.navarch/project.yaml` at the run's base commit,
 * never from the worktree the agent changed.
 */

export type CheckSpec = { name: string; run: string; required: boolean };

export type VerifySpec = {
  cwd: string;
  checks: CheckSpec[];
  /** Files the task changed, relative to the repository root. */
  changedFiles: string[];
  protectedPaths: string[];
  env: NodeJS.ProcessEnv;
  /** Per check. */
  timeoutMs: number;
  onOutput: (chunk: string) => void;
  signal?: AbortSignal;
  /** L2 (ADR 0035): each check runs in a container of this runtime, never on the host. */
  container?: { runtime: string; isolation: ContainerIsolation; name: string };
};

export async function verify(spec: VerifySpec): Promise<VerificationReport> {
  const checks: VerificationCheck[] = [];
  const blocking: string[] = [];
  const warnings: string[] = [];
  const container = spec.container;
  const sandbox = container ? { sandbox: { kind: "container" as const, image: container.isolation.image, network: container.isolation.network } } : {};
  const gitDir = container && spec.checks.length ? await gitCommonDir(spec.cwd).catch(() => undefined) : undefined;
  if (container && spec.checks.length) {
    // Never fall back to the host: the project asked for its checks to be isolated.
    const problem = await containerRuntimeProblem(container.runtime);
    if (problem) return { checks, passed: false, blocking_failures: [redact(`container runtime unavailable: ${problem}`)], warnings, ...sandbox };
  }

  for (const [i, check] of spec.checks.entries()) {
    if (spec.signal?.aborted) break;
    spec.onOutput(`--- verify: ${check.name}: ${check.run}${container ? ` (container ${container.isolation.image})` : ""}\n`);
    const started = Date.now();
    const options = {
      timeoutMs: spec.timeoutMs,
      onOutput: (chunk: string) => spec.onOutput(redact(chunk)),
      ...(spec.signal ? { signal: spec.signal } : {}),
    };
    const { code, tail } = container
      ? await runInContainer({ runtime: container.runtime, isolation: container.isolation, name: `${container.name}-${i + 1}`, worktree: spec.cwd, ...(gitDir ? { gitDir } : {}), user: hostUser() }, check.run, options)
      : await runShell(check.run, { cwd: spec.cwd, env: spec.env, ...options });
    const outputTail = redact(tail);
    checks.push({
      name: check.name,
      command: check.run,
      required: check.required,
      exit_code: code,
      duration_ms: Date.now() - started,
      output_tail: outputTail,
    });
    if (code === 0) continue;
    const how = code === null ? "was killed (timeout or cancel)" : `exited with ${code}`;
    const line = `\`${check.run}\` ${how}${outputTail ? `: ${outputTail}` : ""}`;
    if (check.required) blocking.push(`${check.name}: ${line}`);
    else warnings.push(`${check.name} (optional): ${line}`);
  }

  if (spec.signal?.aborted && !blocking.length) blocking.push("verification was cancelled");
  if (!spec.checks.length) warnings.push("unverified: the project defines no verify commands (.navarch/project.yaml)");
  for (const file of spec.changedFiles) {
    if (spec.protectedPaths.some((pattern) => matchesPath(pattern, file))) warnings.push(`protected path changed: ${file}`);
  }
  return { checks, passed: blocking.length === 0, blocking_failures: blocking, warnings, ...sandbox };
}

/**
 * Gitignore-like matching: `*` stays within a path segment, `**` crosses them, and a pattern
 * without a slash matches the file name at any depth.
 */
export function matchesPath(pattern: string, path: string): boolean {
  const anchored = pattern.includes("/") ? pattern.replace(/^\//, "") : `**/${pattern}`;
  let re = "";
  for (let i = 0; i < anchored.length; i++) {
    const c = anchored[i]!;
    if (c === "*" && anchored[i + 1] === "*") {
      if (anchored[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(path);
}
