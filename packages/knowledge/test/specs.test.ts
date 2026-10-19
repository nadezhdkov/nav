import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { coverageOf, parseSpecDrafts, type SpecDraft } from "@navarch/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { renderIndex, renderSpec, searchSpecs, verifyDrafts } from "../src/index.ts";

let root: string;
function put(rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "navarch-specs-"));
  put("src/auth.ts", ["export function login(user: string) {", "  if (!user) throw new Error('missing user');", "  return createSession(user);", "}"].join("\n"));
  const outside = mkdtempSync(join(tmpdir(), "navarch-outside-"));
  writeFileSync(join(outside, "secret.ts"), "export const SECRET = 'outside the repo';\n");
  symlinkSync(join(outside, "secret.ts"), join(root, "src", "link.ts"));
  for (const args of [["init", "-q", "-b", "main"], ["add", "."]]) execFileSync("git", args, { cwd: root });
});

const draft = (claims: SpecDraft["claims"]): SpecDraft => ({ component: "auth", title: "Authentication", summary: "How login works.", claims });

describe("parseSpecDrafts", () => {
  const block = (o: unknown) => "```navarch-spec\n" + JSON.stringify(o) + "\n```";
  const good = { component: "auth", title: "Auth", summary: "s", claims: [{ id: "c1", text: "t", confidence: "confirmed", evidence: [{ file: "a.ts", line: 1, quote: "x" }] }] };

  it("reads every block and defaults missing evidence to none", () => {
    const text = `intro\n${block(good)}\n${block({ ...good, component: "db", claims: [{ id: "g1", text: "unknown", confidence: "gap" }] })}`;
    const { drafts, errors } = parseSpecDrafts(text);
    expect(errors).toEqual([]);
    expect(drafts.map((d) => d.component)).toEqual(["auth", "db"]);
    expect(drafts[1]!.claims[0]!.evidence).toEqual([]);
  });

  it("reports bad JSON, bad shapes, repeated components and a missing block, keeping the good ones", () => {
    const text = `${block(good)}\n\`\`\`navarch-spec\n{oops\n\`\`\`\n${block({ ...good, component: "Bad Name" })}\n${block(good)}`;
    const { drafts, errors } = parseSpecDrafts(text);
    expect(drafts).toHaveLength(1);
    expect(errors).toHaveLength(3);
    expect(errors[0]).toContain("not valid JSON");
    expect(parseSpecDrafts("nothing here").errors).toEqual(["no ```navarch-spec block in the summary"]);
  });
});

describe("verifyDrafts", () => {
  it("keeps a confirmed claim whose file, line and quote are in the code", async () => {
    const [spec] = await verifyDrafts(root, [draft([{ id: "c1", text: "login rejects an empty user", confidence: "confirmed", evidence: [{ file: "src/auth.ts", line: 2, quote: "throw new Error('missing user')" }] }])]);
    expect(spec!.claims[0]).toMatchObject({ confidence: "confirmed", stated: "confirmed" });
    expect(spec!.claims[0]!.reason).toBeUndefined();
  });

  it("accepts a quote within two lines of the cited one, and ignores whitespace differences", async () => {
    const [spec] = await verifyDrafts(root, [draft([{ id: "c1", text: "creates a session", confidence: "confirmed", evidence: [{ file: "src/auth.ts", line: 1, quote: "return   createSession(user);" }] }])]);
    expect(spec!.claims[0]!.confidence).toBe("confirmed");
  });

  it("lowers a confirmed claim to inferred, saying why", async () => {
    const claim = (id: string, evidence: SpecDraft["claims"][number]["evidence"]) => ({ id, text: id, confidence: "confirmed" as const, evidence });
    const [spec] = await verifyDrafts(root, [
      draft([
        claim("none", []),
        claim("nofile", [{ file: "src/missing.ts", line: 1, quote: "whatever it says" }]),
        claim("noline", [{ file: "src/auth.ts", line: 99, quote: "createSession(user)" }]),
        claim("wrongquote", [{ file: "src/auth.ts", line: 2, quote: "this text is not in the file" }]),
        claim("noquote", [{ file: "src/auth.ts", line: 2 }]),
        claim("shortquote", [{ file: "src/auth.ts", line: 3, quote: "user" }]),
        claim("escape", [{ file: "../etc/passwd", line: 1, quote: "root:x:0:0" }]),
        claim("absolute", [{ file: "/etc/passwd", line: 1, quote: "root:x:0:0" }]),
        claim("symlink", [{ file: "src/link.ts", line: 1, quote: "export const SECRET" }]),
      ]),
    ]);
    const by = Object.fromEntries(spec!.claims.map((c) => [c.id, c]));
    for (const id of Object.keys(by)) expect(by[id]!.confidence, id).toBe("inferred");
    expect(by.none!.reason).toBe("no evidence given");
    expect(by.nofile!.reason).toContain("not found");
    expect(by.noquote!.reason).toContain("no quote");
    expect(by.escape!.evidence[0]!.valid).toBe(false);
    expect(by.symlink!.evidence[0]!.valid).toBe(false);
  });

  it("lowers a confirmed claim when one of its citations is not found, even if another checks out", async () => {
    const [spec] = await verifyDrafts(root, [
      draft([{ id: "mixed", text: "mixed", confidence: "confirmed", evidence: [{ file: "src/auth.ts", line: 1, quote: "return createSession(user);" }, { file: "src/auth.ts", line: 99 }] }]),
    ]);
    expect(spec!.claims[0]!.confidence).toBe("inferred");
    expect(spec!.claims[0]!.reason).toContain("not found");
  });

  it("keeps inferred and gap claims as they are, and marks their evidence", async () => {
    const [spec] = await verifyDrafts(root, [
      draft([
        { id: "i1", text: "probably", confidence: "inferred", evidence: [{ file: "src/auth.ts", line: 1 }, { file: "src/nope.ts", line: 1 }] },
        { id: "g1", text: "who calls it?", confidence: "gap", evidence: [] },
      ]),
    ]);
    expect(spec!.claims.map((c) => c.confidence)).toEqual(["inferred", "gap"]);
    expect(spec!.claims[0]!.evidence.map((e) => e.valid)).toEqual([true, false]);
  });
});

describe("rendering and coverage", () => {
  it("counts the green share and the downgraded claims", async () => {
    const specs = await verifyDrafts(root, [
      draft([
        { id: "ok", text: "ok", confidence: "confirmed", evidence: [{ file: "src/auth.ts", line: 2, quote: "throw new Error('missing user')" }] },
        { id: "bad", text: "bad", confidence: "confirmed", evidence: [] },
        { id: "gap", text: "gap", confidence: "gap" , evidence: []},
        { id: "inf", text: "inf", confidence: "inferred", evidence: [] },
      ]),
    ]);
    expect(coverageOf(specs)).toEqual({ components: 1, claims: 4, confirmed: 1, inferred: 2, gap: 1, downgraded: 1, green_rate: 0.25 });
  });

  it("writes a component file and an index with the evidence and the lowered claims", async () => {
    const specs = await verifyDrafts(root, [draft([{ id: "ok", text: "login rejects an empty user", confidence: "confirmed", evidence: [{ file: "src/auth.ts", line: 2, quote: "throw new Error('missing user')" }] }, { id: "bad", text: "x\nwith a newline", confidence: "confirmed", evidence: [] }])]);
    const meta = { runId: "run_1", generatedAt: "2026-10-19T10:00:00.000Z" };
    const md = renderSpec(specs[0]!, meta);
    expect(md).toContain("- 🟢 **ok** login rejects an empty user — `src/auth.ts:2`");
    expect(md).toContain("- 🟡 **bad** x with a newline _(stated confirmed; lowered: no evidence given)_");
    const index = renderIndex(specs, meta);
    expect(index.markdown).toContain("| [Authentication](auth.md) | 2 | 1 | 1 | 0 | 50 % |");
    expect(JSON.parse(index.json).coverage).toMatchObject({ claims: 2, confirmed: 1, green_rate: 0.5 });
  });
});

describe("searchSpecs", () => {
  it("finds lines with every word in the spec files, and nothing without them", async () => {
    const { mkdtemp, mkdir, writeFile, symlink } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "specs-"));
    await mkdir(join(dir, ".navarch/specs"), { recursive: true });
    await writeFile(join(dir, ".navarch/specs/auth.md"), "# Auth\n- 🟢 **c1** Creates a Session for the user\n- 🔴 **c2** who revokes?\n");
    await writeFile(join(dir, "secret.md"), "creates a session outside\n");
    await symlink(join(dir, "secret.md"), join(dir, ".navarch/specs/link.md"));
    const hits = await searchSpecs(dir, "creates SESSION");
    expect(hits).toEqual([{ file: ".navarch/specs/auth.md", line: 2, text: "- 🟢 **c1** Creates a Session for the user" }]);
    expect(await searchSpecs(dir, "")).toEqual([]);
    expect(await searchSpecs(join(dir, "nothing"), "auth")).toEqual([]);
  });
});
