import type { CodeSymbol, SymbolKind } from "@navarch/contracts";
import { listFiles, readText, treeKey } from "./files.ts";
import { extractorFor } from "./symbols.ts";

export { readText } from "./files.ts";
export { repoMap } from "./map.ts";
export { searchText } from "./search.ts";
export { extractorFor, EXTRACTORS, type SymbolExtractor } from "./symbols.ts";

const cache = new Map<string, { key: string; symbols: CodeSymbol[] }>();

/** Every symbol of the files git sees, kept in memory until HEAD or the working tree changes (ADR 0042). */
export async function indexSymbols(root: string): Promise<CodeSymbol[]> {
  const key = await treeKey(root);
  const hit = cache.get(root);
  if (hit?.key === key) return hit.symbols;
  const symbols: CodeSymbol[] = [];
  for (const file of await listFiles(root)) {
    const extractor = extractorFor(file);
    if (!extractor) continue;
    const text = await readText(root, file);
    if (text !== undefined) symbols.push(...extractor.extract(text, file));
  }
  cache.set(root, { key, symbols });
  return symbols;
}

/** Case-insensitive substring match on the name; exact matches come first. */
export function findSymbols(index: CodeSymbol[], query: string, opts: { kind?: SymbolKind; limit?: number } = {}): CodeSymbol[] {
  const q = query.toLowerCase();
  const rank = (s: CodeSymbol) => (s.name === query ? 0 : s.name.toLowerCase() === q ? 1 : 2);
  return index
    .filter((s) => s.name.toLowerCase().includes(q) && (!opts.kind || s.kind === opts.kind))
    .sort((a, b) => rank(a) - rank(b) || a.file.localeCompare(b.file) || a.line - b.line)
    .slice(0, opts.limit ?? 50);
}
