import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { findSymbols, indexSymbols, repoMap, searchText } from "../src/index.ts";

let root: string;

function put(rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "navarch-explorer-"));
  put("package.json", JSON.stringify({ name: "x", main: "src/main.ts", bin: { x: "bin/x.ts" }, dependencies: { vue: "^3" }, devDependencies: { vitest: "^5" } }));
  put("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  put(".gitignore", "ignored/\n");
  put("src/main.ts", "export function parseTeamPlan(text: string) {\n  return text;\n}\nexport class Runner {}\ninterface Hidden {}\nexport const LIMIT = 3;\nexport type Id = string;\n\n// padding so TypeScript is the largest language\n// padding\n// padding\n// padding\n");
  put("pkg/tool.py", "class Tool:\n    def run(self):\n        pass\n\ndef main():\n    pass\n");
  put("cmd/app/main.go", "package main\n\ntype Server struct{}\n\nfunc (s *Server) Start() {}\n\nfunc Run() {}\n");
  put("src/lib.rs", "pub struct Index;\npub trait Walk {}\npub fn build() {}\nfn private() {}\n");
  put("bin/x.ts", "export {};\n");
  put("ignored/skip.ts", "export function skipped() {}\n");
  for (const args of [["init", "-q", "-b", "main"], ["add", "."]]) execFileSync("git", args, { cwd: root });
});

describe("indexSymbols", () => {
  it("extracts symbols with file and line", async () => {
    const index = await indexSymbols(root);
    const plan = findSymbols(index, "parseTeamPlan");
    expect(plan).toEqual([{ name: "parseTeamPlan", kind: "function", lang: "typescript", file: "src/main.ts", line: 1, exported: true }]);
    expect(findSymbols(index, "Hidden")[0]).toMatchObject({ kind: "interface", exported: false, line: 5 });
    expect(findSymbols(index, "LIMIT")[0]).toMatchObject({ kind: "const", line: 6 });
  });

  it("covers python, go and rust", async () => {
    const index = await indexSymbols(root);
    expect(findSymbols(index, "Tool")[0]).toMatchObject({ kind: "class", lang: "python", line: 1 });
    expect(findSymbols(index, "run").map((s) => s.kind)).toContain("method");
    expect(findSymbols(index, "Server").map((s) => s.kind).sort()).toEqual(["struct"]);
    expect(findSymbols(index, "Start")[0]).toMatchObject({ kind: "method", lang: "go" });
    expect(findSymbols(index, "Run")[0]).toMatchObject({ kind: "function", exported: true, lang: "go" });
    expect(findSymbols(index, "build")[0]).toMatchObject({ lang: "rust", exported: true });
    expect(findSymbols(index, "private")[0]).toMatchObject({ exported: false });
  });

  it("never lists ignored files", async () => {
    expect(findSymbols(await indexSymbols(root), "skipped")).toEqual([]);
  });

  it("filters by kind and matches case-insensitively by substring", async () => {
    const index = await indexSymbols(root);
    expect(findSymbols(index, "parseteam").length).toBe(1);
    expect(findSymbols(index, "r", { kind: "class" }).every((s) => s.kind === "class")).toBe(true);
  });
});

describe("repoMap", () => {
  it("summarises languages, frameworks, entry points and directories", async () => {
    const map = await repoMap(root);
    expect(map.languages[0]?.lang).toBe("typescript");
    expect(map.frameworks).toEqual(expect.arrayContaining(["pnpm workspaces", "vue", "vitest"]));
    expect(map.entry_points).toEqual(expect.arrayContaining(["src/main.ts", "bin/x.ts", "cmd/app/main.go"]));
    expect(map.manifests).toContain("package.json");
    expect(map.directories.map((d) => d.path)).toEqual(expect.arrayContaining(["src", "pkg", "cmd"]));
    expect(map.directories.map((d) => d.path)).not.toContain("ignored");
  });
});

describe("searchText", () => {
  it("finds lines and respects ignores", async () => {
    const hits = await searchText(root, "parseTeamPlan");
    expect(hits).toEqual([{ file: "src/main.ts", line: 1, text: "export function parseTeamPlan(text: string) {" }]);
    expect(await searchText(root, "skipped")).toEqual([]);
  });

  it("gives the same hits with and without ripgrep", async () => {
    const withRg = await searchText(root, "Server");
    const without = await searchText(root, "Server", { ripgrep: false });
    expect(without).toEqual(withRg);
    expect(withRg.length).toBeGreaterThan(1);
  });
});
