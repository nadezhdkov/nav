import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { CodeSpecRow, SpecConfidence, SpecTestRow, TraceabilityView, TraceClaimRef, TraceTest } from "@navarch/contracts";
import { listFiles, readText } from "@navarch/explorer";

/**
 * Traceability matrices over the specs a project keeps in `.navarch/specs/` (spec §6.8.1, ADR 0054):
 * `code ↔ spec` (which files the claims cite, and which source files nothing cites) and
 * `spec ↔ test` (which tests are tied to the files a claim cites). Computed from the files alone,
 * with no model: the spec files are text an agent wrote, and the test links are inferred from
 * names and imports, so they say "a test exists for this file", never "this test proves the claim".
 */

const SPECS_DIR = ".navarch/specs";
const MAX_UNCOVERED = 200;
const MAX_TEST_FILES = 2_000;
const MAX_TESTS_PER_FILE = 5;

const ICONS: Record<string, SpecConfidence> = { "🟢": "confirmed", "🟡": "inferred", "🔴": "gap" };
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|vue|py|go|rs|java|kt|rb|php|cs|c|cc|cpp|h|hpp|swift|scala)$/i;
const TEST_FILE = [
  /(^|\/)(tests?|__tests__|spec|specs)\//i,
  /\.(test|spec)\.[a-z]+$/i,
  /_test\.(go|py|rs|rb)$/i,
  /(^|\/)test_[^/]+\.py$/i,
  /Tests?\.(java|kt|cs)$/,
];
/** File names too generic to tie a test to by import. */
const GENERIC = new Set(["index", "main", "mod", "__init__", "lib", "app", "utils", "types"]);

/** A code file that is a test; the specs under `.navarch/specs/` match the `specs/` pattern and are not. */
export const isTestFile = (file: string): boolean => CODE_EXT.test(file) && !file.startsWith(".navarch/") && TEST_FILE.some((re) => re.test(file));
const isSourceFile = (file: string): boolean => CODE_EXT.test(file) && !isTestFile(file) && !file.startsWith(".navarch/") && !/\.d\.ts$/.test(file);

const stem = (file: string): string => (file.split("/").pop() ?? file).replace(/\.[^.]+$/, "");
/** `auth.test` → `auth`, `auth_test` → `auth`, `test_auth` → `auth`, `AuthTest` → `Auth`. */
const testStem = (file: string): string => stem(file).replace(/\.(test|spec)$/i, "").replace(/_test$/i, "").replace(/^test_/i, "").replace(/Tests?$/, "");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type ParsedClaim = { component: string; claim: string; confidence: SpecConfidence; cites: { file: string; line: number; found: boolean }[] };

/** The claims of one component file, read back from the lines `renderSpec` writes. */
export function parseSpecClaims(component: string, markdown: string): ParsedClaim[] {
  const out: ParsedClaim[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^- (🟢|🟡|🔴) \*\*([a-z0-9][a-z0-9-]*)\*\*(.*)$/u.exec(line);
    if (!m) continue;
    const rest = m[3]!.replace(/ _\(stated confirmed; lowered: .*\)_\s*$/, "");
    const at = rest.lastIndexOf(" — `");
    const cites: ParsedClaim["cites"] = [];
    if (at >= 0) {
      for (const c of rest.slice(at).matchAll(/`([^`]+):(\d+)`( \(not found\))?/g)) cites.push({ file: c[1]!, line: Number(c[2]), found: !c[3] });
    }
    out.push({ component, claim: m[2]!, confidence: ICONS[m[1]!]!, cites });
  }
  return out;
}

async function readClaims(root: string): Promise<{ claims: ParsedClaim[]; components: string[] }> {
  let names: string[];
  try {
    // Regular files only, and not the index or the addenda: a symlink in an untrusted repository must not lead outside it.
    names = (await readdir(join(root, SPECS_DIR), { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "index.md").map((e) => e.name).sort();
  } catch {
    return { claims: [], components: [] };
  }
  const claims: ParsedClaim[] = [];
  const components: string[] = [];
  for (const name of names) {
    const text = await readText(root, `${SPECS_DIR}/${name}`);
    if (text === undefined) continue;
    const component = name.replace(/\.md$/, "");
    components.push(component);
    claims.push(...parseSpecClaims(component, text));
  }
  return { claims, components };
}

/** Tests tied to a code file: same stem, or a test file importing its module. */
async function testsFor(file: string, tests: { file: string; text: () => Promise<string | undefined> }[]): Promise<TraceTest[]> {
  const base = stem(file);
  const out: TraceTest[] = [];
  for (const t of tests) {
    if (out.length >= MAX_TESTS_PER_FILE) break;
    if (testStem(t.file) === base) {
      out.push({ file: t.file, via: "name" });
      continue;
    }
    if (GENERIC.has(base)) continue;
    const text = await t.text();
    if (text === undefined) continue;
    const b = escape(base);
    const path = new RegExp(`['"\`][^'"\`\\n]*/${b}(?:\\.[a-z]+)?['"\`]`);
    const py = new RegExp(`\\b(?:from|import)\\s+[\\w.]*\\b${b}\\b`);
    if (path.test(text) || py.test(text)) out.push({ file: t.file, via: "import" });
  }
  return out;
}

/** Builds the matrices for a clone, from its specs and the files git sees. */
export async function traceability(root: string): Promise<TraceabilityView> {
  const [{ claims, components }, files] = await Promise.all([readClaims(root), listFiles(root).catch(() => [] as string[])]);
  const existing = new Set(files);
  const source = files.filter(isSourceFile);
  const testFiles = files.filter(isTestFile).slice(0, MAX_TEST_FILES);
  const cache = new Map<string, Promise<string | undefined>>();
  const tests = testFiles.map((file) => ({ file, text: () => (cache.get(file) ?? cache.set(file, readText(root, file)).get(file)!) }));

  const broken: TraceabilityView["broken"] = [];
  const byFile = new Map<string, TraceClaimRef[]>();
  for (const c of claims) {
    for (const cite of c.cites) {
      if (!cite.found || !existing.has(cite.file)) {
        broken.push({ component: c.component, claim: c.claim, file: cite.file, line: cite.line });
        continue;
      }
      byFile.set(cite.file, [...(byFile.get(cite.file) ?? []), { component: c.component, claim: c.claim, confidence: c.confidence, line: cite.line }]);
    }
  }

  const testsOf = new Map<string, TraceTest[]>();
  for (const file of [...byFile.keys()].sort()) testsOf.set(file, isSourceFile(file) ? await testsFor(file, tests) : []);

  const code_spec: CodeSpecRow[] = [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([file, refs]) => ({ file, claims: refs, tests: testsOf.get(file) ?? [] }));

  const spec_test: SpecTestRow[] = claims.map((c) => {
    const cited = [...new Set(c.cites.filter((x) => x.found && byFile.has(x.file)).map((x) => x.file))];
    const seen = new Set<string>();
    const linked = cited.flatMap((f) => testsOf.get(f) ?? []).filter((t) => (seen.has(t.file) ? false : (seen.add(t.file), true)));
    return { component: c.component, claim: c.claim, confidence: c.confidence, files: cited, tests: linked };
  });

  const cited = new Set(byFile.keys());
  const uncoveredAll = source.filter((f) => !cited.has(f));
  const withFiles = spec_test.filter((r) => r.files.length);
  const withTests = withFiles.filter((r) => r.tests.length);
  const share = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 1000 : null);

  return {
    has_specs: components.length > 0,
    components: components.map((component) => {
      const rows = spec_test.filter((r) => r.component === component);
      return {
        component,
        claims: rows.length,
        claims_with_files: rows.filter((r) => r.files.length).length,
        claims_with_tests: rows.filter((r) => r.files.length && r.tests.length).length,
        files: new Set(rows.flatMap((r) => r.files)).size,
      };
    }),
    code_spec,
    uncovered: uncoveredAll.slice(0, MAX_UNCOVERED),
    uncovered_total: uncoveredAll.length,
    spec_test,
    broken,
    totals: {
      source_files: source.length,
      cited_files: source.filter((f) => cited.has(f)).length,
      cited_share: share(source.filter((f) => cited.has(f)).length, source.length),
      claims: claims.length,
      claims_with_files: withFiles.length,
      claims_with_tests: withTests.length,
      tested_share: share(withTests.length, withFiles.length),
    },
  };
}
