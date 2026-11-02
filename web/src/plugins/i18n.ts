import { DEFAULT_LOCALE, type Locale, LOCALES } from '@newses/shared/locales';
import { createI18n, useI18n } from 'vue-i18n';
import { en as vuetifyEn } from 'vuetify/locale';
import { createVueI18nAdapter } from 'vuetify/locale/adapters/vue-i18n';
import { pluralRule } from '../lib/plurals.ts';
import { PSEUDO_LOCALES, pseudoMessages } from '../lib/pseudo-locale.ts';
import en from '../locales/en.json';

/** The languages on offer, with the generated ones in development. */
export const AVAILABLE_LOCALES: readonly Locale[] = import.meta.env.DEV
  ? [...LOCALES, ...PSEUDO_LOCALES]
  : LOCALES;

export type MessageSchema = typeof en & { $vuetify: typeof vuetifyEn };

/** A language's messages: `MessageSchema`, though `en` fills any gaps. */
type MessageFile<T> = () => Promise<{ default: T }>;

// As chunks the service worker precaches, so every language works offline. `en` is always loaded,
// as it fills the gaps of the others.
const messageFiles: Record<string, MessageFile<typeof en>> = import.meta.glob<{
  default: typeof en;
}>(['../locales/*.json', '!../locales/en.json']);
const vuetifyFiles: Record<string, MessageFile<typeof vuetifyEn>> = import.meta.glob<{
  default: typeof vuetifyEn;
}>('../locales/vuetify/*.ts');

export const i18n = createI18n<[MessageSchema], string, false>({
  legacy: false,
  locale: DEFAULT_LOCALE,
  fallbackLocale: DEFAULT_LOCALE,
  messages: { [DEFAULT_LOCALE]: { ...en, $vuetify: vuetifyEn } },
  // `en` keeps vue-i18n's rule: its messages with a zero form have no CLDR equivalent.
  pluralRules: Object.fromEntries(
    LOCALES.filter(({ code }) => code !== DEFAULT_LOCALE).map((locale) => [
      locale.code,
      pluralRule(locale),
    ]),
  ),
});

/** Vuetify's locale options: its own text and direction follow the app's language. */
export const vuetifyLocale = {
  adapter: createVueI18nAdapter({ i18n, useI18n }),
  rtl: Object.fromEntries(
    AVAILABLE_LOCALES.map(({ code, direction }) => [code, direction === 'rtl']),
  ),
};

async function loadMessages(code: string): Promise<MessageSchema> {
  if (import.meta.env.DEV && PSEUDO_LOCALES.some((locale) => locale.code === code))
    return pseudoMessages(code, i18n.global.getLocaleMessage(DEFAULT_LOCALE));
  const load = messageFiles[`../locales/${code}.json`];
  if (!load) throw new Error(`No messages for ${code}`);
  const [messages, vuetify] = await Promise.all([
    load(),
    vuetifyFiles[`../locales/vuetify/${code}.ts`]?.(),
  ]);
  return { ...messages.default, $vuetify: vuetify?.default ?? vuetifyEn };
}

let requested: string = DEFAULT_LOCALE;

/** Shows a language, loading it first; the document's `lang` and `dir` change with it. */
export async function setLocale(code: string): Promise<void> {
  requested = code;
  if (!i18n.global.availableLocales.includes(code)) {
    try {
      i18n.global.setLocaleMessage(code, await loadMessages(code));
    } catch {
      // A chunk replaced by an update, or no network without a service worker: this language
      // stays, as a rejection here would leave a blank page at startup.
      return;
    }
  }
  // A later choice won while this one loaded.
  if (requested !== code) return;
  i18n.global.locale.value = code;
  const locale = AVAILABLE_LOCALES.find((candidate) => candidate.code === code);
  document.documentElement.lang = code;
  document.documentElement.dir = locale?.direction ?? 'ltr';
}
