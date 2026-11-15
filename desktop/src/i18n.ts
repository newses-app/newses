import { DEFAULT_LOCALE, LOCALES, negotiateLocale } from '@newses/shared/locales';
import { formatMessage, type MessageParams } from '@newses/shared/messages';
import de from './locales/de.json' with { type: 'json' };
import en from './locales/en.json' with { type: 'json' };
import es from './locales/es.json' with { type: 'json' };
import it from './locales/it.json' with { type: 'json' };

type Messages = typeof en;

/** One static import per language, as the main process is bundled. */
export const MESSAGES: Record<string, Partial<Messages>> = { de, en, es, it };

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

/**
 * Text of the app's own menus, in the web app's message syntax with params shown as its are
 * (`formatMessage`); what the window shows comes from the web app's locale files.
 */
export function t(key: keyof Messages, params: MessageParams = {}): string {
  const own = MESSAGES[shown]?.[key];
  return own === undefined
    ? formatMessage(shown, en[key], params, DEFAULT_LOCALE)
    : formatMessage(shown, own, params);
}
