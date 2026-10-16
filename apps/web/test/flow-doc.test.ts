// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { addNode, connect, disconnect, placeAfter, duplicateYaml, edit, moveNode, readDraft, removeNode, renameNode, setField, setMeta, setParam } from "../src/lib/flowDoc.ts";
import { hunks, lineDiff } from "../src/lib/lineDiff.ts";

const FLOWS = fileURLToPath(new URL("../../../flows/", import.meta.url));
const builtins = readdirSync(FLOWS).filter((f) => f.endsWith(".yaml")).map((f) => [f, readFileSync(FLOWS + f, "utf8")] as const);
const changed = (a: string, b: string) => lineDiff(a, b).filter((d) => d.kind !== "same");

describe("lossless editing (ADR 0033)", () => {
  it.each(builtins)("%s: a visual edit changes only the lines it concerns", (_file, text) => {
    const view = readDraft(text)!;
    const first = view.nodes.find((n) => n.type !== "trigger")!;
    // Naming a node adds one line and touches nothing else: comments and `[a]` spacing stay.
    const named = edit(text, setField(first.id, ["name"], "Renamed step"));
    expect(changed(text, named)).toEqual([{ kind: "add", text: expect.stringContaining("name: Renamed step"), b: expect.any(Number) }]);
    // Removing it again gives back the original text, byte for byte.
    expect(edit(named, setField(first.id, ["name"], undefined))).toBe(text);
    // An edit that changes nothing changes nothing.
    expect(edit(text, setMeta("name", view.name!))).toBe(text);
  });

  it("keeps comments and flow collections when the chain changes", () => {
    const text = builtins.find(([f]) => f === "fix-issue.yaml")![1];
    const out = edit(text, moveNode("review", -1));
    expect(changed(text, out)).toEqual([
      { kind: "del", text: "  - start -> triage -> plan -> approve_plan -> implement_loop -> review -> open_pr", a: expect.any(Number) },
      { kind: "add", text: "  - start -> triage -> plan -> approve_plan -> review -> implement_loop -> open_pr", b: expect.any(Number) },
    ]);
    expect(out).toContain("# Issue → verified draft PR");
    expect(out).toContain("on: [github.issue.labeled]");
  });
});

const base = `apiVersion: navarch/v1
kind: Flow
metadata:
  name: t
nodes:
  - id: implement
    type: agent
    profile: implementer
edges:
  - implement
`;

describe("Flow document operations", () => {
  it("adds nodes after the selected one, in the chain, with unique ids", () => {
    const out = { id: "" } as { id?: string };
    let text = edit(base, addNode("action", "implement", true, out));
    expect(out.id).toBe("verify");
    text = edit(text, addNode("agent", "implement"));
    const view = readDraft(text)!;
    expect(view.nodes.map((n) => n.id)).toEqual(["implement", "implement_2", "verify"]);
    expect(view.chain).toEqual(["implement", "implement_2", "verify"]);
  });

  it("leaves a dropped node disconnected until it is connected", () => {
    let text = edit(base, addNode("approval", null, false));
    expect(readDraft(text)!.chain).toEqual(["implement"]);
    text = edit(text, connect("implement", "approve"));
    expect(readDraft(text)!.chain).toEqual(["implement", "approve"]);
    text = edit(text, disconnect("implement"));
    expect(readDraft(text)!.chain).toEqual(["approve"]);
  });

  it("places a node after another or first, after the trigger", () => {
    let text = edit(base, addNode("approval", null, false));
    text = edit(text, addNode("trigger", null));
    expect(readDraft(edit(text, placeAfter("approve", null)))!.chain).toEqual(["start", "approve", "implement"]);
    expect(readDraft(edit(text, placeAfter("approve", "implement")))!.chain).toEqual(["start", "implement", "approve"]);
  });

  it("puts a trigger first, and refuses to connect anything before it", () => {
    const text = edit(base, addNode("trigger", "implement"));
    expect(readDraft(text)!.chain).toEqual(["start", "implement"]);
    expect(() => edit(text, connect("implement", "start"))).toThrow(/trigger comes first/);
  });

  it("adds a loop with its body, and agents inside a loop body", () => {
    let text = edit(base, addNode("loop", "implement"));
    const loop = readDraft(text)!.nodes.find((n) => n.type === "loop")!;
    expect(loop.body.map((b) => b.id)).toEqual(["implement_2", "verify"]);
    expect(loop.raw.until).toBe("${{ nodes.verify.outputs.passed }}");
    text = edit(text, addNode("agent", "implement_2"));
    expect(readDraft(text)!.nodes.find((n) => n.type === "loop")!.body.map((b) => b.id)).toEqual(["implement_2", "implement_3", "verify"]);
    expect(() => edit(text, addNode("approval", "verify"))).toThrow(/inside a loop/);
  });

  it("removes a node and closes the chain", () => {
    let text = edit(base, addNode("action", "implement"));
    text = edit(text, addNode("github", "verify"));
    text = edit(text, removeNode("verify"));
    expect(readDraft(text)!.chain).toEqual(["implement", "open_pr"]);
  });

  it("renames a node in the chain and in expressions", () => {
    let text = edit(base, addNode("loop", "implement"));
    text = edit(text, renameNode("verify", "check"));
    const view = readDraft(text)!;
    expect(view.nodes[1]!.raw.until).toBe("${{ nodes.check.outputs.passed }}");
    expect(() => edit(text, renameNode("check", "implement"))).toThrow(/already exists/);
    expect(() => edit(text, renameNode("check", "Bad"))).toThrow(/lowercase/);
  });

  it("adds and removes params before the nodes", () => {
    let text = edit(base, setParam("tries", { type: "int", default: 2 }));
    expect(text).toContain("params:\n  tries: { type: int, default: 2 }\nnodes:");
    text = edit(text, setParam("tries", null));
    expect(text).toBe(base);
  });

  it("duplicates a Flow under a new name", () => {
    expect(readDraft(duplicateYaml(base, "copy"))!.name).toBe("copy");
  });

  it("reads invalid YAML as null and refuses to edit it", () => {
    expect(readDraft("nodes: [")).toBeNull();
    expect(() => edit("nodes: [", setMeta("name", "x"))).toThrow(/does not parse/);
  });
});

describe("lineDiff", () => {
  it("diffs a first version as all additions, blank lines included", () => {
    expect(lineDiff("", "a\n\nb").map((d) => d.kind)).toEqual(["add", "add", "add"]);
  });
});

describe("hunks", () => {
  it("keeps context around changes and marks gaps", () => {
    const a = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
    const b = a.replace("l10", "L10");
    const h = hunks(lineDiff(a, b), 1);
    expect(h.map((d) => (d ? `${d.kind}:${d.text}` : "…"))).toEqual(["same:l9", "del:l10", "add:L10", "same:l11"]);
    const two = hunks(lineDiff(a, b.replace("l2", "L2")), 1);
    expect(two.filter((d) => d === null)).toHaveLength(1);
  });
});
