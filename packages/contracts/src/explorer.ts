import { z } from "zod";

/** Repository exploration: map, symbols and text search (ADR 0042). All text comes from the repository and is untrusted. */

export const SymbolKind = z.enum(["function", "class", "interface", "type", "enum", "const", "method", "struct", "trait", "module"]);
export type SymbolKind = z.infer<typeof SymbolKind>;

export const CodeSymbol = z.object({
  name: z.string(),
  kind: SymbolKind,
  lang: z.string(),
  file: z.string(),
  line: z.number().int().positive(),
  exported: z.boolean(),
});
export type CodeSymbol = z.infer<typeof CodeSymbol>;

export const SearchHit = z.object({ file: z.string(), line: z.number().int().positive(), text: z.string() });
export type SearchHit = z.infer<typeof SearchHit>;

export const RepoMap = z.object({
  languages: z.array(z.object({ lang: z.string(), files: z.number().int(), lines: z.number().int() })),
  frameworks: z.array(z.string()),
  entry_points: z.array(z.string()),
  manifests: z.array(z.string()),
  directories: z.array(z.object({ path: z.string(), files: z.number().int() })),
  files: z.number().int(),
});
export type RepoMap = z.infer<typeof RepoMap>;

/** What the context compiler produced for a Task (ADR 0043). `text` comes from the repository and is untrusted. */
export const CompiledContext = z.object({
  text: z.string(),
  /** `file:line` of each item, so the agent can check it. */
  sources: z.array(z.string()),
  chars: z.number().int().nonnegative(),
  est_tokens: z.number().int().nonnegative(),
  max_tokens: z.number().int().positive(),
  ms: z.number().int().nonnegative(),
});
export type CompiledContext = z.infer<typeof CompiledContext>;
