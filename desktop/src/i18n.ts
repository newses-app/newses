import { DEFAULT_LOCALE, LOCALES, negotiateLocale } from '@newses/shared/locales';
import en from './locales/en.json' with { type: 'json' };
import es from './locales/es.json' with { type: 'json' };

type Messages = typeof en;

/** One static import per language, as the main process is bundled. */
export const MESSAGES: Record<string, Partial<Messages>> = { en, es };

let shown = DEFAULT_LOCALE;

/**
 * Shows the first of these languages on offer, else the default, and returns it; a message not yet
 * translated is in English. The app sends the language it shows, which the system's only precede.
 */
export function setLanguage(requested: readonly string[]): string {
  shown = negotiateLocale(
    requested,
    LOCALES.map((locale) => locale.code),
  );
  return shown;
}

/** Text of the app's own menus; what the window shows comes from the web app's locale files. */
export function t(key: keyof Messages, params: Record<string, string> = {}): string {
  const message = MESSAGES[shown]?.[key] ?? en[key];
  return message.replace(/\{(\w+)\}/g, (_match, name: string) => params[name] ?? '');
}
