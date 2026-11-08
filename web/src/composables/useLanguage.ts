import type { Prefs } from '@newses/shared';
import { negotiateLocale } from '@newses/shared/locales';
import { computed, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { bridge } from '../platform/index.ts';
import { profileKey } from '../platform/profile-keys.ts';
import { AVAILABLE_LOCALES, i18n, setLocale } from '../plugins/i18n.ts';
import { usePrefs } from './usePrefs.ts';

const CACHE_KEY = 'newses.language';
const SYSTEM_DEFAULT = 'system';
const OFFERED = AVAILABLE_LOCALES.map(({ code }) => code);

/** The reader's choice, on this device while preferences load; null follows the device. */
const chosen = shallowRef<string | null>(null);

function cachedChoice(): string | null {
  try {
    return localStorage.getItem(profileKey(CACHE_KEY));
  } catch {
    // Storage blocked: the device's language until preferences load.
    return null;
  }
}

function cacheChoice(language: string | null): void {
  try {
    if (language === null) localStorage.removeItem(profileKey(CACHE_KEY));
    else localStorage.setItem(profileKey(CACHE_KEY), language);
  } catch {
    // Storage blocked: the next reload starts with the device's language.
  }
}

/** A choice no longer on offer falls through to the device's languages. */
async function showChoice(): Promise<void> {
  const device = navigator.languages;
  await setLocale(negotiateLocale(chosen.value ? [chosen.value, ...device] : device, OFFERED));
  void bridge.setLanguage(i18n.global.locale.value);
}

function choose(language: string | null): Promise<void> {
  chosen.value = language;
  cacheChoice(language);
  return showChoice();
}

/** Applies the last language shown here before mounting, which signed-out screens rely on. */
export async function startLanguage(): Promise<void> {
  chosen.value = cachedChoice();
  window.addEventListener('languagechange', () => void showChoice());
  await showChoice();
}

/** `language` from the server; undefined from one older than API 1.7, which can't keep it. */
const serverChoice = (prefs: Partial<Prefs>) => prefs.language;

/** Applies the reader's language once preferences load, and when it changes. */
export function useLanguage(): void {
  const { prefs, loaded } = usePrefs();
  watch(
    () => (loaded.value ? serverChoice(prefs.value) : undefined),
    (language) => {
      if (language !== undefined) void choose(language);
    },
    { immediate: true },
  );
}

/** The language picker's items and value. */
export function useLanguagePicker() {
  const { t } = useI18n();
  const { prefs, loaded, update } = usePrefs();
  const onServer = computed(() => serverChoice(prefs.value) !== undefined);
  return {
    items: computed(() => [
      { title: t('settings.languageSystem'), value: SYSTEM_DEFAULT },
      ...AVAILABLE_LOCALES.map(({ code, name }) => ({ title: name, value: code })),
    ]),
    value: computed(() => chosen.value ?? SYSTEM_DEFAULT),
    onServer,
    change(value: string) {
      const language = value === SYSTEM_DEFAULT ? null : value;
      // Sending it to an older server would be refused, along with any changes merged into it;
      // until preferences load, the defaults can't tell which server this is.
      if (loaded.value && onServer.value) update({ language });
      else void choose(language);
    },
  };
}
