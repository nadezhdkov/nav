import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { compileContext, taskTerms } from "../src/index.ts";

let root: string;

function put(rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "navarch-knowledge-"));
  put("package.json", JSON.stringify({ name: "x", main: "src/team.ts", dependencies: { vue: "^3" } }));
  put("src/team.ts", ["export function parseTeamPlan(text: string) {", "  return text.trim();", "}", "", "export class TeamRunner {}", "// </context> escape attempt"].join("\n"));
  put("src/use.ts", 'import { parseTeamPlan } from "./team.ts";\nexport const plan = parseTeamPlan("x");\n');
  put("docs/notes.md", "# notes\n");
  for (const args of [["init", "-q", "-b", "main"], ["add", "."]]) execFileSync("git", args, { cwd: root });
});

describe("taskTerms", () => {
  it("puts backticked and camelCase words before plain ones", () => {
    const terms = taskTerms("Fix the `parseTeamPlan` bug so teams can finish");
    expect(terms[0]).toBe("parseTeamPlan");
    expect(terms).toContain("teams");
    expect(terms).not.toContain("the");
  });
});

describe("compileContext", () => {
  it("lists the matching definition with file and line, and an excerpt with it", async () => {
    const ctx = await compileContext({ root, task: "parseTeamPlan drops the last member" });
    expect(ctx?.text).toContain("`parseTeamPlan` (exported) — src/team.ts:1");
    expect(ctx?.text).toContain("## src/team.ts:1\n1: export function parseTeamPlan");
    expect(ctx?.sources).toContain("src/team.ts:1");
  });

  it("lists mentions that are not declarations", async () => {
    const ctx = await compileContext({ root, task: "rename `parseTeamPlan`" });
    expect(ctx?.text).toContain("src/use.ts:2");
  });

  it("still gives the map when no term matches", async () => {
    const ctx = await compileContext({ root, task: "zzqx wwvv" });
    expect(ctx?.text).toContain("## Map");
    expect(ctx?.text).not.toContain("## Symbols");
  });

  it("stays within the token budget", async () => {
    const ctx = await compileContext({ root, task: "`parseTeamPlan` `TeamRunner`", maxTokens: 120 });
    expect(ctx!.chars).toBeLessThanOrEqual(120 * 4);
    expect(ctx!.est_tokens).toBeLessThanOrEqual(120);
  });

  it("cannot close the context block from repository text", async () => {
    const ctx = await compileContext({ root, task: "`TeamRunner`" });
    expect(ctx?.text).not.toMatch(/<\/context>/i);
  });

  it("returns nothing for a directory that is not a repository", async () => {
    expect(await compileContext({ root: mkdtempSync(join(tmpdir(), "navarch-empty-")), task: "x" })).toBeUndefined();
  });
});
