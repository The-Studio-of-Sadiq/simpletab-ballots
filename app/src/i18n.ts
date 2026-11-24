import { IntlMessageFormat } from "intl-messageformat";
import bnCatalog from "../locales/bn/app.json";
import enCatalog from "../locales/en/app.json";

export type LocaleCode = "en" | "bn";
export type MessageValues = Record<string, string | number | boolean | null | undefined>;
export type TranslateFn = (key: string, values?: MessageValues) => string;

const CATALOGS: Record<LocaleCode, Record<string, string>> = {
  en: enCatalog,
  bn: bnCatalog,
};

export const SUPPORTED_LOCALES: readonly LocaleCode[] = ["en", "bn"];

export function normalizeLocale(raw: string | undefined | null): LocaleCode {
  if (!raw) return "en";
  const base = raw.trim().toLowerCase().split(/[-_]/)[0];
  return base === "bn" ? "bn" : "en";
}

export interface I18nInstance {
  getLocale(): LocaleCode;
  setLocale(locale: string): void;
  t: TranslateFn;
}

export function createI18n(initialLocale = "en"): I18nInstance {
  let currentLocale: LocaleCode = normalizeLocale(initialLocale);
  const cache = new Map<string, IntlMessageFormat>();

  function getFormatter(locale: LocaleCode, key: string, pattern: string): IntlMessageFormat {
    const cacheKey = `${locale}:${key}`;
    let fmt = cache.get(cacheKey);
    if (!fmt) {
      fmt = new IntlMessageFormat(pattern, locale);
      cache.set(cacheKey, fmt);
    }
    return fmt;
  }

  function t(key: string, values?: MessageValues): string {
    const activeCatalog = CATALOGS[currentLocale];
    const hasActive = Object.hasOwn(activeCatalog, key) && activeCatalog[key].length > 0;
    const effectiveLocale: LocaleCode = hasActive ? currentLocale : "en";
    const pattern = hasActive
      ? activeCatalog[key]
      : Object.hasOwn(CATALOGS.en, key)
        ? CATALOGS.en[key]
        : undefined;

    if (pattern === undefined) {
      return key;
    }

    try {
      const formatted = getFormatter(effectiveLocale, key, pattern).format(values ?? {});
      return Array.isArray(formatted) ? formatted.map(String).join("") : String(formatted);
    } catch {
      return pattern;
    }
  }

  return {
    getLocale: () => currentLocale,
    setLocale: (locale: string) => {
      currentLocale = normalizeLocale(locale);
    },
    t,
  };
}

const defaultI18n = createI18n("en");

export function setLocale(locale: string): void {
  defaultI18n.setLocale(locale);
}

export function getLocale(): LocaleCode {
  return defaultI18n.getLocale();
}

export function t(key: string, values?: MessageValues): string {
  return defaultI18n.t(key, values);
}
