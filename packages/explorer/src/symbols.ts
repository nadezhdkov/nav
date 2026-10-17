import type { CodeSymbol, SymbolKind } from "@navarch/contracts";

/** One extractor per language (ADR 0042): line-based, replaceable by a parser later. */
export type SymbolExtractor = {
  lang: string;
  extensions: string[];
  extract(text: string, file: string): CodeSymbol[];
};

type Rule = { re: RegExp; kind: SymbolKind | ((m: RegExpExecArray) => SymbolKind); exported?: (m: RegExpExecArray) => boolean };

function byRules(lang: string, rules: Rule[]): (text: string, file: string) => CodeSymbol[] {
  return (text, file) => {
    const out: CodeSymbol[] = [];
    text.split("\n").forEach((line, i) => {
      for (const rule of rules) {
        const m = rule.re.exec(line);
        if (!m?.groups?.name) continue;
        const kind = typeof rule.kind === "function" ? rule.kind(m) : rule.kind;
        out.push({ name: m.groups.name, kind, lang, file, line: i + 1, exported: rule.exported ? rule.exported(m) : true });
        break;
      }
    });
    return out;
  };
}

const ts = (lang: string): SymbolExtractor => ({
  lang,
  extensions: lang === "typescript" ? [".ts", ".tsx", ".mts", ".cts", ".vue"] : [".js", ".jsx", ".mjs", ".cjs"],
  extract: byRules(lang, [
    { re: /^(?<exp>export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?function\*?\s+(?<name>[A-Za-z_$][\w$]*)/, kind: "function", exported: (m) => Boolean(m.groups?.exp) },
    { re: /^(?<exp>export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?class\s+(?<name>[A-Za-z_$][\w$]*)/, kind: "class", exported: (m) => Boolean(m.groups?.exp) },
    { re: /^(?<exp>export\s+)?(?:declare\s+)?interface\s+(?<name>[A-Za-z_$][\w$]*)/, kind: "interface", exported: (m) => Boolean(m.groups?.exp) },
    { re: /^(?<exp>export\s+)?(?:declare\s+)?type\s+(?<name>[A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/, kind: "type", exported: (m) => Boolean(m.groups?.exp) },
    { re: /^(?<exp>export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+(?<name>[A-Za-z_$][\w$]*)/, kind: "enum", exported: (m) => Boolean(m.groups?.exp) },
    { re: /^(?<exp>export\s+)?(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*[=:]/, kind: "const", exported: (m) => Boolean(m.groups?.exp) },
  ]),
});

const python: SymbolExtractor = {
  lang: "python",
  extensions: [".py"],
  extract: byRules("python", [
    { re: /^class\s+(?<name>\w+)/, kind: "class", exported: (m) => !m.groups!.name!.startsWith("_") },
    { re: /^(?<indent>\s*)(?:async\s+)?def\s+(?<name>\w+)/, kind: (m) => (m.groups!.indent ? "method" : "function"), exported: (m) => !m.groups!.name!.startsWith("_") },
  ]),
};

const go: SymbolExtractor = {
  lang: "go",
  extensions: [".go"],
  extract: byRules("go", [
    { re: /^func\s+\([^)]*\)\s*(?<name>\w+)/, kind: "method", exported: (m) => /^[A-Z]/.test(m.groups!.name!) },
    { re: /^func\s+(?<name>\w+)/, kind: "function", exported: (m) => /^[A-Z]/.test(m.groups!.name!) },
    { re: /^type\s+(?<name>\w+)\s+struct\b/, kind: "struct", exported: (m) => /^[A-Z]/.test(m.groups!.name!) },
    { re: /^type\s+(?<name>\w+)\s+interface\b/, kind: "interface", exported: (m) => /^[A-Z]/.test(m.groups!.name!) },
    { re: /^type\s+(?<name>\w+)\s/, kind: "type", exported: (m) => /^[A-Z]/.test(m.groups!.name!) },
  ]),
};

const rust: SymbolExtractor = {
  lang: "rust",
  extensions: [".rs"],
  extract: byRules("rust", [
    { re: /^(?<indent>\s*)(?<pub>pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(?<name>\w+)/, kind: (m) => (m.groups!.indent ? "method" : "function"), exported: (m) => Boolean(m.groups!.pub) },
    { re: /^(?<pub>pub(?:\([^)]*\))?\s+)?struct\s+(?<name>\w+)/, kind: "struct", exported: (m) => Boolean(m.groups!.pub) },
    { re: /^(?<pub>pub(?:\([^)]*\))?\s+)?enum\s+(?<name>\w+)/, kind: "enum", exported: (m) => Boolean(m.groups!.pub) },
    { re: /^(?<pub>pub(?:\([^)]*\))?\s+)?trait\s+(?<name>\w+)/, kind: "trait", exported: (m) => Boolean(m.groups!.pub) },
    { re: /^(?<pub>pub(?:\([^)]*\))?\s+)?type\s+(?<name>\w+)/, kind: "type", exported: (m) => Boolean(m.groups!.pub) },
    { re: /^(?<pub>pub(?:\([^)]*\))?\s+)?mod\s+(?<name>\w+)/, kind: "module", exported: (m) => Boolean(m.groups!.pub) },
    { re: /^(?<pub>pub(?:\([^)]*\))?\s+)?(?:const|static)\s+(?<name>\w+)\s*:/, kind: "const", exported: (m) => Boolean(m.groups!.pub) },
  ]),
};

export const EXTRACTORS: SymbolExtractor[] = [ts("typescript"), ts("javascript"), python, go, rust];

export function extractorFor(file: string): SymbolExtractor | undefined {
  const dot = file.lastIndexOf(".");
  const ext = dot < 0 ? "" : file.slice(dot).toLowerCase();
  return EXTRACTORS.find((e) => e.extensions.includes(ext));
}
