import type {
  ReactiveController,
  ReactiveControllerHost,
} from "@yukino.js/lit-jsx";
import en from "../locales/en.json";
import ja from "../locales/ja.json";
import zh from "../locales/zh.json";

export type Locale = "en" | "zh" | "ja";

export type Messages = typeof en;

const catalogs: Record<Locale, Messages> = { en, zh, ja };

export const LOCALES: readonly Locale[] = ["en", "zh", "ja"] as const;

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "EN",
  zh: "中文",
  ja: "日本語",
};

export const LOCALE_LANG_TAGS: Record<Locale, string> = {
  en: "en",
  zh: "zh-CN",
  ja: "ja",
};

type Leaves<T> = T extends string
  ? never
  : {
      [K in keyof T & string]: T[K] extends string ? K : `${K}.${Leaves<T[K]>}`;
    }[keyof T & string];

export type MessageKey = Leaves<Messages>;

const STORAGE_KEY = "yukino-locale";

function isLocale(value: unknown): value is Locale {
  return value === "en" || value === "zh" || value === "ja" || value === "lzh";
}

function detectLocale(): Locale {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {}
  const lang =
    typeof navigator !== "undefined"
      ? (navigator.language ?? "").toLowerCase()
      : "";
  if (lang.startsWith("zh")) return "zh";
  if (lang.startsWith("ja")) return "ja";
  return "en";
}

let current: Locale = detectLocale();
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale): void {
  if (!isLocale(locale) || locale === current) return;
  current = locale;
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {}
  applyDocumentMeta();
  for (const listener of [...listeners]) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function lookup(catalog: unknown, path: string): string | undefined {
  let node: unknown = catalog;
  for (const part of path.split(".")) {
    if (
      node !== null &&
      typeof node === "object" &&
      part in (node as Record<string, unknown>)
    ) {
      node = (node as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof node === "string" ? node : undefined;
}

export function t(
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  let text = lookup(catalogs[current], key) ?? lookup(en, key) ?? key;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}

function applyDocumentMeta(): void {
  document.documentElement.lang = LOCALE_LANG_TAGS[current];
  document.title = t("meta.title");
  const meta = document.querySelector('meta[name="description"]');
  if (meta) meta.setAttribute("content", t("meta.description"));
}

applyDocumentMeta();

export class LocaleController implements ReactiveController {
  private readonly host: ReactiveControllerHost;
  private unsubscribe?: () => void;

  constructor(host: ReactiveControllerHost) {
    this.host = host;
    host.addController(this);
  }

  hostConnected(): void {
    this.unsubscribe = subscribe(() => this.host.requestUpdate());
  }

  hostDisconnected(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}
