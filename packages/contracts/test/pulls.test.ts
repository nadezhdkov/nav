import { describe, expect, it } from "vitest";
import { CreateRunRequest, parseDeclaredOutputs, parseReviewDraft } from "../src/index.ts";

const fence = (lang: string, body: string) => "Done.\n\n```" + lang + "\n" + body + "\n```\n";

describe("parseReviewDraft", () => {
  it("reads the last navarch-review block", () => {
    const text = fence("navarch-review", '{"summary":"old","verdict":"comment"}') + fence("navarch-review", JSON.stringify({ summary: "Looks fine", verdict: "approve", comments: [{ path: "a.ts", line: 3, body: "nit" }] }));
    expect(parseReviewDraft(text)).toEqual({ ok: true, review: { summary: "Looks fine", verdict: "approve", comments: [{ path: "a.ts", line: 3, body: "nit" }] } });
  });

  it("explains a missing, broken or invalid block", () => {
    expect(parseReviewDraft("no block")).toMatchObject({ ok: false, error: expect.stringMatching(/no ```navarch-review/) });
    expect(parseReviewDraft(fence("navarch-review", "{"))).toMatchObject({ ok: false, error: expect.stringMatching(/not valid JSON/) });
    expect(parseReviewDraft(fence("navarch-review", '{"summary":"x","verdict":"merge"}'))).toMatchObject({ ok: false, error: expect.stringMatching(/verdict/) });
    expect(parseReviewDraft(fence("navarch-review", '{"summary":"x","verdict":"comment","comments":[{"path":"a","line":0,"body":"b"}]}'))).toMatchObject({ ok: false });
  });
});

describe("parseDeclaredOutputs", () => {
  it("keeps the scalar fields of the last block, never summary", () => {
    const text = fence("navarch-outputs", '{"kind":"infra"}') + fence("navarch-outputs", JSON.stringify({ kind: "code", confidence: 0.8, flaky: false, summary: "no", nested: { a: 1 }, list: [1], "Bad-Key": 1 }));
    expect(parseDeclaredOutputs(text)).toEqual({ kind: "code", confidence: 0.8, flaky: false });
  });

  it("adds nothing without a valid object", () => {
    expect(parseDeclaredOutputs("plain")).toEqual({});
    expect(parseDeclaredOutputs(fence("navarch-outputs", "[1]"))).toEqual({});
    expect(parseDeclaredOutputs(fence("navarch-outputs", "{oops"))).toEqual({});
  });
});

describe("CreateRunRequest", () => {
  it("takes a pull request instead of a prompt, but not with an issue", () => {
    expect(CreateRunRequest.safeParse({ repo_path: "/r", pull_request: "o/r#3" }).success).toBe(true);
    expect(CreateRunRequest.safeParse({ repo_path: "/r", pull_request: "o/r#3", issue: "o/r#4" }).success).toBe(false);
    expect(CreateRunRequest.safeParse({ repo_path: "/r", pull_request: "o/r" }).success).toBe(false);
  });
});
