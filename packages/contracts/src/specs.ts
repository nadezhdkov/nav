import { z } from "zod";

/**
 * Traceable specifications (spec §6.8.1, ADR 0045). A spec-writing agent ends with one fenced
 * `navarch-spec` JSON block per component; Navarch checks every claim's evidence against the code
 * before writing `.navarch/specs/`. Everything in a draft is untrusted until it is verified.
 */

export const SpecConfidence = z.enum(["confirmed", "inferred", "gap"]);
export type SpecConfidence = z.infer<typeof SpecConfidence>;

export const SPEC_ICON: Record<SpecConfidence, string> = { confirmed: "🟢", inferred: "🟡", gap: "🔴" };

const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "lowercase letters, digits and dashes, up to 40 characters");

export const SpecEvidence = z.object({
  /** Repository-relative path. */
  file: z.string().min(1).max(300),
  line: z.number().int().positive(),
  /** Text of the code at (or within two lines of) `line`; a confirmed claim needs one. */
  quote: z.string().max(300).optional(),
});
export type SpecEvidence = z.infer<typeof SpecEvidence>;

export const SpecClaim = z.object({
  id: Slug,
  text: z.string().min(1).max(600),
  confidence: SpecConfidence,
  evidence: z.array(SpecEvidence).max(6).default([]),
});
export type SpecClaim = z.infer<typeof SpecClaim>;

export const SpecDraft = z.object({
  component: Slug,
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(1_000),
  claims: z.array(SpecClaim).min(1).max(60),
});
export type SpecDraft = z.infer<typeof SpecDraft>;

/** A claim after Navarch checked its evidence; `confidence` is what it earned, `stated` what the agent said. */
export const VerifiedClaim = z.object({
  id: z.string(),
  text: z.string(),
  stated: SpecConfidence,
  confidence: SpecConfidence,
  /** Why a stated 🟢 was lowered. */
  reason: z.string().optional(),
  evidence: z.array(SpecEvidence.extend({ valid: z.boolean() })),
});
export type VerifiedClaim = z.infer<typeof VerifiedClaim>;

export const VerifiedSpec = z.object({
  component: z.string(),
  title: z.string(),
  summary: z.string(),
  claims: z.array(VerifiedClaim),
});
export type VerifiedSpec = z.infer<typeof VerifiedSpec>;

/** Counts over verified claims; `green_rate` is the share of 🟢 (the Phase 3 go/no-go wants ≥ 0.7). */
export const SpecCoverage = z.object({
  components: z.number().int().nonnegative(),
  claims: z.number().int().nonnegative(),
  confirmed: z.number().int().nonnegative(),
  inferred: z.number().int().nonnegative(),
  gap: z.number().int().nonnegative(),
  /** Claims the agent called confirmed that failed the check. */
  downgraded: z.number().int().nonnegative(),
  green_rate: z.number().min(0).max(1).nullable(),
});
export type SpecCoverage = z.infer<typeof SpecCoverage>;

const BLOCK = /```navarch-spec[ \t]*\r?\n([\s\S]*?)```/g;

/** Every `navarch-spec` block of an agent's summary. Invalid blocks are reported and skipped. */
export function parseSpecDrafts(text: string): { drafts: SpecDraft[]; errors: string[] } {
  const drafts: SpecDraft[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  let n = 0;
  for (const match of text.matchAll(BLOCK)) {
    n++;
    let json: unknown;
    try {
      json = JSON.parse(match[1]!);
    } catch (err) {
      errors.push(`block ${n} is not valid JSON: ${(err as Error).message}`);
      continue;
    }
    const parsed = SpecDraft.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      errors.push(`block ${n} ${issue.path.join(".") || "draft"}: ${issue.message}`);
      continue;
    }
    const draft = parsed.data;
    if (seen.has(draft.component)) {
      errors.push(`block ${n}: component "${draft.component}" appears twice`);
      continue;
    }
    const ids = new Set<string>();
    const dup = draft.claims.find((c) => (ids.has(c.id) ? true : (ids.add(c.id), false)));
    if (dup) {
      errors.push(`block ${n}: claim id "${dup.id}" appears twice in "${draft.component}"`);
      continue;
    }
    seen.add(draft.component);
    drafts.push(draft);
  }
  if (!n) errors.push("no ```navarch-spec block in the summary");
  return { drafts, errors };
}

export function coverageOf(specs: readonly VerifiedSpec[]): SpecCoverage {
  const claims = specs.flatMap((s) => s.claims);
  const count = (c: SpecConfidence) => claims.filter((x) => x.confidence === c).length;
  const confirmed = count("confirmed");
  return {
    components: specs.length,
    claims: claims.length,
    confirmed,
    inferred: count("inferred"),
    gap: count("gap"),
    downgraded: claims.filter((c) => c.stated === "confirmed" && c.confidence !== "confirmed").length,
    green_rate: claims.length ? Math.round((confirmed / claims.length) * 1000) / 1000 : null,
  };
}

/** One finished `reverse-spec` write, newest first (`GET /api/v1/specs`). */
export const SpecRunView = SpecCoverage.extend({
  run_id: z.string(),
  run_name: z.string().nullable(),
  ts: z.string(),
  branch: z.string(),
  files: z.array(z.string()),
});
export type SpecRunView = z.infer<typeof SpecRunView>;

// --- addenda (spec-sync, ADR 0049) ---

export const AddendumKind = z.enum(["added", "changed", "removed"]);
export type AddendumKind = z.infer<typeof AddendumKind>;

/** What a merged pull request did to the behavior one component's spec describes. */
export const AddendumChange = z.object({
  id: Slug,
  component: Slug,
  kind: AddendumKind,
  text: z.string().min(1).max(600),
  confidence: SpecConfidence,
  evidence: z.array(SpecEvidence).max(6).default([]),
});
export type AddendumChange = z.infer<typeof AddendumChange>;

/** A claim of the existing specs that the pull request may have made untrue. */
export const StaleClaim = z.object({
  component: Slug,
  claim: Slug,
  reason: z.string().min(1).max(400),
});
export type StaleClaim = z.infer<typeof StaleClaim>;

export const AddendumDraft = z.object({
  summary: z.string().min(1).max(1_000),
  changes: z.array(AddendumChange).max(40).default([]),
  stale: z.array(StaleClaim).max(40).default([]),
});
export type AddendumDraft = z.infer<typeof AddendumDraft>;

const ADDENDUM_BLOCK = /```navarch-addendum[ \t]*\r?\n([\s\S]*?)```/g;

/** The one `navarch-addendum` block of a spec-syncer's summary; the last one wins when it writes two. */
export function parseAddendumDraft(text: string): { draft?: AddendumDraft; errors: string[] } {
  const blocks = [...text.matchAll(ADDENDUM_BLOCK)];
  const last = blocks.at(-1);
  if (!last) return { errors: ["no ```navarch-addendum block in the summary"] };
  let json: unknown;
  try {
    json = JSON.parse(last[1]!);
  } catch (err) {
    return { errors: [`the block is not valid JSON: ${(err as Error).message}`] };
  }
  const parsed = AddendumDraft.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return { errors: [`the block ${issue.path.join(".") || "draft"}: ${issue.message}`] };
  }
  const draft = parsed.data;
  const ids = new Set<string>();
  const dup = draft.changes.find((c) => (ids.has(c.id) ? true : (ids.add(c.id), false)));
  if (dup) return { errors: [`change id "${dup.id}" appears twice`] };
  if (!draft.changes.length && !draft.stale.length) return { errors: ["the block lists no change and no stale claim; say what the pull request changed in the specs' terms"] };
  return { draft, errors: [] };
}

// --- traceability matrices (ADR 0054) ---

/** How a test was tied to a code file: the same name (`auth.test.ts` for `auth.ts`), or it imports the module. */
export const TraceVia = z.enum(["name", "import"]);
export type TraceVia = z.infer<typeof TraceVia>;

export const TraceTest = z.object({ file: z.string(), via: TraceVia });
export type TraceTest = z.infer<typeof TraceTest>;

/** A claim of the specs that cites a code file. */
export const TraceClaimRef = z.object({ component: z.string(), claim: z.string(), confidence: SpecConfidence, line: z.number().int().positive() });
export type TraceClaimRef = z.infer<typeof TraceClaimRef>;

/** `code ↔ spec`: a code file the specs cite, with the claims that cite it and the tests tied to it. */
export const CodeSpecRow = z.object({ file: z.string(), claims: z.array(TraceClaimRef), tests: z.array(TraceTest) });
export type CodeSpecRow = z.infer<typeof CodeSpecRow>;

/** `spec ↔ test`: a claim, the code files it cites and the tests tied to them (inferred, never confirmed). */
export const SpecTestRow = z.object({
  component: z.string(),
  claim: z.string(),
  confidence: SpecConfidence,
  files: z.array(z.string()),
  tests: z.array(TraceTest),
});
export type SpecTestRow = z.infer<typeof SpecTestRow>;

export const TraceComponent = z.object({
  component: z.string(),
  claims: z.number().int().nonnegative(),
  /** Claims citing at least one code file that exists. */
  claims_with_files: z.number().int().nonnegative(),
  claims_with_tests: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
});
export type TraceComponent = z.infer<typeof TraceComponent>;

export const TraceabilityView = z.object({
  /** False when the project has no `.navarch/specs/` yet. */
  has_specs: z.boolean(),
  components: z.array(TraceComponent),
  code_spec: z.array(CodeSpecRow),
  /** Source files no claim cites, capped; `uncovered_total` counts them all. */
  uncovered: z.array(z.string()),
  uncovered_total: z.number().int().nonnegative(),
  spec_test: z.array(SpecTestRow),
  /** Citations whose file or line is not in the code any more. */
  broken: z.array(z.object({ component: z.string(), claim: z.string(), file: z.string(), line: z.number().int().positive() })),
  totals: z.object({
    source_files: z.number().int().nonnegative(),
    cited_files: z.number().int().nonnegative(),
    /** Cited source files over all source files; null with no source files. */
    cited_share: z.number().min(0).max(1).nullable(),
    claims: z.number().int().nonnegative(),
    claims_with_files: z.number().int().nonnegative(),
    claims_with_tests: z.number().int().nonnegative(),
    /** Claims with a tied test over claims with a file; null with none. */
    tested_share: z.number().min(0).max(1).nullable(),
  }),
});
export type TraceabilityView = z.infer<typeof TraceabilityView>;
