import { createI18n } from "vue-i18n";
import { de } from "./locales/de.ts";
import { en, type Messages } from "./locales/en.ts";
import { es } from "./locales/es.ts";
import { ptBR } from "./locales/pt-BR.ts";
import { zhCN } from "./locales/zh-CN.ts";

export type { Messages };

/** UI locales, English first as the base (AGENTS.md › Language); `name` is each one's own name for itself. */
export const locales = [
  { code: "en", name: "English" },
  { code: "pt-BR", name: "Português (Brasil)" },
  { code: "es", name: "Español" },
  { code: "de", name: "Deutsch" },
  { code: "zh-CN", name: "简体中文" },
] as const;

export type Locale = (typeof locales)[number]["code"];

const messages: Record<Locale, Messages> = { en, "pt-BR": ptBR, es, de, "zh-CN": zhCN };

const KEY = "navarch.locale";

function isLocale(value: unknown): value is Locale {
  return locales.some((l) => l.code === value);
}

/** The best UI locale for a list of browser languages: an exact match, then the same language, then English. */
export function matchLocale(languages: readonly string[]): Locale {
  for (const tag of languages) {
    const exact = locales.find((l) => l.code.toLowerCase() === tag.toLowerCase());
    if (exact) return exact.code;
    const lang = tag.split("-")[0]!.toLowerCase();
    const same = locales.find((l) => l.code.split("-")[0]!.toLowerCase() === lang);
    if (same) return same.code;
  }
  return "en";
}

/** The viewer's saved choice, else the browser's languages. */
export function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(KEY);
    if (isLocale(saved)) return saved;
  } catch {
    // Storage blocked: fall back to the browser's languages.
  }
  const nav = typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
  return matchLocale(nav.filter(Boolean));
}

export const i18n = createI18n<[Messages], Locale, false>({
  legacy: false,
  locale: initialLocale(),
  fallbackLocale: "en",
  messages,
});

/** Switches the UI language, remembers it for this browser and sets `<html lang>`. */
export function setLocale(locale: Locale): void {
  i18n.global.locale.value = locale;
  if (typeof document !== "undefined") document.documentElement.lang = locale;
  try {
    localStorage.setItem(KEY, locale);
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
}
