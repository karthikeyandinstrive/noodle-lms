"use client";

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import en from "@/i18n/en.json";
import es from "@/i18n/es.json";

/**
 * Minimal, dependency-free i18n.
 *
 *   const t = useT();
 *   t("course.enrol", "Enrol me")                       // key + English fallback
 *   t("grades.outOf", "{grade} out of {max}", { grade, max })
 *
 * Messages live in src/i18n/<locale>.json (flat "dot.keys"). A missing key
 * falls back to the inline English text, so untranslated UI never breaks.
 * Locale: the user's profile locale, else the browser language, else English.
 */

export const LOCALES = { en: "English", es: "Español" } as const;
export type Locale = keyof typeof LOCALES;

const dictionaries: Record<Locale, Record<string, string>> = { en, es };

const STORAGE_KEY = "lms.locale";
const listeners = new Set<() => void>();

function readStoredLocale(): Locale | null {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v && v in LOCALES ? (v as Locale) : null;
  } catch {
    return null;
  }
}

function browserLocale(): Locale {
  const lang = typeof navigator !== "undefined" ? navigator.language.slice(0, 2) : "en";
  return lang in LOCALES ? (lang as Locale) : "en";
}

/** Remembers the chosen locale on this device (the profile locale is saved via the API). */
export function setStoredLocale(locale: Locale) {
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // storage unavailable (private mode) — the profile locale still applies
  }
  for (const l of listeners) l();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

type Vars = Record<string, string | number>;
export type Translate = (key: string, fallback: string, vars?: Vars) => string;

const LocaleContext = createContext<Locale>("en");

export function format(template: string, vars?: Vars) {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

export function LocaleProvider({ userLocale, children }: { userLocale?: string | null; children: React.ReactNode }) {
  const stored = useSyncExternalStore(subscribe, readStoredLocale, () => null);
  const locale: Locale = (userLocale && userLocale in LOCALES ? (userLocale as Locale) : null) ?? stored ?? (typeof window === "undefined" ? "en" : browserLocale());
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  return useContext(LocaleContext);
}

export function useT(): Translate {
  const locale = useLocale();
  const dict = dictionaries[locale];
  return useCallback((key: string, fallback: string, vars?: Vars) => format(dict[key] ?? fallback, vars), [dict]);
}

/** Locale-aware date/number formatters. */
export function useFormat() {
  const locale = useLocale();
  return useMemo(
    () => ({
      date: (v: string | Date | null | undefined, withTime = true) =>
        v ? new Date(v).toLocaleString(locale, withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" }) : "—",
      number: (n: number, opts?: Intl.NumberFormatOptions) => new Intl.NumberFormat(locale, opts).format(n),
    }),
    [locale],
  );
}
