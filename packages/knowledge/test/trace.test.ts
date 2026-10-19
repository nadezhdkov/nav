import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { isTestFile, parseSpecClaims, traceability } from "../src/index.ts";

let root: string;
const put = (rel: string, body: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "navarch-trace-"));
  put("src/auth.ts", "export function login() {}\n");
  put("src/auth.test.ts", "import { login } from './auth.ts';\n");
  put("src/session.ts", "export function open() {}\n");
  put("test/flow.test.ts", "import { open } from '../src/session.ts';\n");
  put("src/orphan.ts", "export const x = 1;\n");
  put("src/index.ts", "export * from './auth.ts';\n");
  put("README.md", "docs\n");
  put(
    ".navarch/specs/auth.md",
    [
      "# Authentication",
      "",
      "## Claims",
      "",
      "- 🟢 **rejects-empty** login throws when no user is given — `src/auth.ts:1`",
      "- 🟡 **sessions** login opens a session — `src/auth.ts:1`, `src/session.ts:1`",
      "- 🔴 **lockout** nothing says when an account locks",
      "- 🟡 **gone** cites a file that went away — `src/removed.ts:3` (not found) _(stated confirmed; lowered: file, line or quote not found)_",
    ].join("\n"),
  );
  put(".navarch/specs/index.md", "# Specifications\n\n- 🟢 **not-a-claim** index lines are ignored — `src/orphan.ts:1`\n");
  put(".navarch/specs/addenda/pr-7.md", "- 🟢 **late** an addendum — `src/orphan.ts:1`\n");
  for (const args of [["init", "-q", "-b", "main"], ["add", "."]]) execFileSync("git", args, { cwd: root });
});

describe("parseSpecClaims", () => {
  it("reads confidence, id and citations, and drops the lowered note", () => {
    const text = [
      "- 🟢 **a** it works — and so on — `src/a.ts:2`",
      "- 🟡 **b** two files — `src/a.ts:2`, `src/b.ts:9` (not found) _(stated confirmed; lowered: no evidence)_",
      "- 🔴 **c** a gap",
      "not a claim",
    ].join("\n");
    expect(parseSpecClaims("x", text)).toEqual([
      { component: "x", claim: "a", confidence: "confirmed", cites: [{ file: "src/a.ts", line: 2, found: true }] },
      { component: "x", claim: "b", confidence: "inferred", cites: [{ file: "src/a.ts", line: 2, found: true }, { file: "src/b.ts", line: 9, found: false }] },
      { component: "x", claim: "c", confidence: "gap", cites: [] },
    ]);
  });
});

describe("isTestFile", () => {
  it.each(["src/a.test.ts", "src/a.spec.js", "tests/x.py", "pkg/a_test.go", "pkg/test_a.py", "src/FooTest.java", "test/helpers.ts"])("%s is a test", (f) => expect(isTestFile(f)).toBe(true));
  it.each(["src/a.ts", "src/contest.ts", "lib/latest.py", ".navarch/specs/auth.md", "tests/notes.md"])("%s is not", (f) => expect(isTestFile(f)).toBe(false));
});

describe("traceability", () => {
  it("ties cited files to their claims and to tests by name and by import", async () => {
    const t = await traceability(root);
    expect(t.has_specs).toBe(true);
    expect(t.code_spec.map((r) => r.file)).toEqual(["src/auth.ts", "src/session.ts"]);
    const auth = t.code_spec.find((r) => r.file === "src/auth.ts")!;
    expect(auth.claims.map((c) => `${c.component}/${c.claim}`)).toEqual(["auth/rejects-empty", "auth/sessions"]);
    expect(auth.tests).toEqual([{ file: "src/auth.test.ts", via: "name" }]);
    expect(t.code_spec.find((r) => r.file === "src/session.ts")!.tests).toEqual([{ file: "test/flow.test.ts", via: "import" }]);
  });

  it("lists source files nothing cites, and leaves out tests, docs and the specs themselves", async () => {
    const t = await traceability(root);
    expect(t.uncovered).toEqual(["src/index.ts", "src/orphan.ts"]);
    expect(t.uncovered_total).toBe(2);
    expect(t.totals).toMatchObject({ source_files: 4, cited_files: 2, cited_share: 0.5 });
  });

  it("maps each claim to the files it cites and the tests tied to them, and reports broken citations", async () => {
    const t = await traceability(root);
    const row = (claim: string) => t.spec_test.find((r) => r.claim === claim)!;
    expect(row("rejects-empty")).toMatchObject({ files: ["src/auth.ts"], tests: [{ file: "src/auth.test.ts", via: "name" }] });
    expect(row("sessions").tests.map((x) => x.file)).toEqual(["src/auth.test.ts", "test/flow.test.ts"]);
    expect(row("lockout")).toMatchObject({ files: [], tests: [], confidence: "gap" });
    expect(t.broken).toEqual([{ component: "auth", claim: "gone", file: "src/removed.ts", line: 3 }]);
    // The index and the addenda are not components: their lines are not claims.
    expect(t.spec_test.map((r) => r.claim)).not.toContain("not-a-claim");
    expect(t.spec_test.map((r) => r.claim)).not.toContain("late");
  });

  it("counts claims with files and with tests, per component and in total", async () => {
    const t = await traceability(root);
    expect(t.components).toEqual([{ component: "auth", claims: 4, claims_with_files: 2, claims_with_tests: 2, files: 2 }]);
    expect(t.totals).toMatchObject({ claims: 4, claims_with_files: 2, claims_with_tests: 2, tested_share: 1 });
  });

  it("says there are no specs for a repository without them", async () => {
    const bare = mkdtempSync(join(tmpdir(), "navarch-trace-bare-"));
    writeFileSync(join(bare, "a.ts"), "export {};\n");
    for (const args of [["init", "-q", "-b", "main"], ["add", "."]]) execFileSync("git", args, { cwd: bare });
    const t = await traceability(bare);
    expect(t).toMatchObject({ has_specs: false, components: [], code_spec: [], spec_test: [], totals: { source_files: 1, cited_files: 0, cited_share: 0, claims: 0, tested_share: null } });
    expect(t.uncovered).toEqual(["a.ts"]);
  });
});
