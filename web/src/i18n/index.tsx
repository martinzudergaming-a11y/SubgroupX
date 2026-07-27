import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { en, type TranslationKey } from "./en";
import { zh } from "./zh";

export type Locale = "en" | "zh";
export type TranslationParams = Record<string, string | number>;
export type TFunction = (key: TranslationKey, params?: TranslationParams) => string;

type LocaleContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: TFunction;
  formatNumber: (value: number) => string;
};

const STORAGE_KEY = "oiia.locale";
const DEFAULT_LOCALE: Locale = "en";

const dictionaries = {
  en,
  zh,
} as const satisfies Record<Locale, Readonly<Record<TranslationKey, string>>>;

const LocaleContext = createContext<LocaleContextValue | null>(null);

function isLocale(value: string | null): value is Locale {
  return value === "en" || value === "zh";
}

function detectLocale(): Locale {
  if (typeof window !== "undefined") {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (isLocale(stored)) return stored;
    } catch {
    }
  }
  if (typeof navigator !== "undefined") {
    const language = navigator.languages?.[0] ?? navigator.language;
    if (/^zh(?:-|$)/i.test(language)) return "zh";
  }
  return DEFAULT_LOCALE;
}

function interpolate(template: string, params?: TranslationParams): string {
  if (!params) return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale);

  const setLocale = useCallback((nextLocale: Locale) => {
    setLocaleState(nextLocale);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
    try {
      window.localStorage.setItem(STORAGE_KEY, locale);
    } catch {
    }
  }, [locale]);

  const numberFormat = useMemo(
    () => new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US"),
    [locale],
  );

  const formatNumber = useCallback((value: number) => numberFormat.format(value), [numberFormat]);

  const t = useCallback<TFunction>(
    (key, params) => interpolate(dictionaries[locale][key], params),
    [locale],
  );

  const value = useMemo(
    () => ({ locale, setLocale, t, formatNumber }),
    [formatNumber, locale, setLocale, t],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useI18n(): LocaleContextValue {
  const ctx = use(LocaleContext);
  if (!ctx) throw new Error("useI18n must be used within LocaleProvider");
  return ctx;
}

export function useT(): TFunction {
  return useI18n().t;
}
