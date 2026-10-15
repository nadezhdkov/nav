import { describe, expect, it } from "vitest";
import { i18n, locales, matchLocale, setLocale } from "../src/i18n.ts";

type Tree = { [key: string]: string | Tree };

function leaves(tree: Tree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.set(path, value);
    else for (const [k, v] of leaves(value, path)) out.set(k, v);
  }
  return out;
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("UI locales", () => {
  const all = i18n.global.messages.value as unknown as Record<string, Tree>;
  const base = leaves(all.en!);

  it.each(locales.filter((l) => l.code !== "en").map((l) => l.code))("%s has every English key, with the same placeholders", (code) => {
    const messages = leaves(all[code]!);
    expect([...messages.keys()].sort()).toEqual([...base.keys()].sort());
    for (const [key, text] of base) {
      expect(messages.get(key), key).not.toBe("");
      expect(placeholders(messages.get(key)!), key).toEqual(placeholders(text));
      // vue-i18n reads these as syntax, so a translation must not introduce them.
      expect(messages.get(key), key).not.toMatch(/[|@]/);
    }
  });

  it("matches the browser's languages: exact tag, then same language, then English", () => {
    expect(matchLocale(["pt-BR", "en"])).toBe("pt-BR");
    expect(matchLocale(["pt-PT"])).toBe("pt-BR");
    expect(matchLocale(["de-AT", "en"])).toBe("de");
    expect(matchLocale(["es-419"])).toBe("es");
    expect(matchLocale(["zh-CN"])).toBe("zh-CN");
    expect(matchLocale(["zh-TW"])).toBe("zh-CN");
    expect(matchLocale(["fr-FR", "es"])).toBe("es");
    expect(matchLocale(["ja"])).toBe("en");
    expect(matchLocale([])).toBe("en");
  });

  it("switches the language, sets <html lang> and remembers the choice", () => {
    setLocale("de");
    expect(i18n.global.t("nav.approvals")).toBe("Freigaben");
    expect(document.documentElement.lang).toBe("de");
    expect(localStorage.getItem("navarch.locale")).toBe("de");
    setLocale("en");
    expect(i18n.global.t("nav.approvals")).toBe("Approvals");
  });
});
