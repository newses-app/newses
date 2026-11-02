import { LOCALES } from '@newses/shared/locales';
import { afterEach, describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { useI18n } from 'vue-i18n';
import { i18n, setLocale, vuetifyLocale } from './i18n.ts';
import en from '../locales/en.json';
import { mountWithPlugins } from '../test/mount.ts';

const { t } = i18n.global;

const leaves = (node: object, path = ''): [string, string][] =>
  Object.entries(node).flatMap(([key, value]: [string, string | object]) =>
    typeof value === 'string' ? [[`${path}${key}`, value]] : leaves(value, `${path}${key}.`),
  );
const pluralKeys = leaves(en).filter(([, message]) => message.includes(' | '));

afterEach(async () => {
  await setLocale('en');
});

describe('setLocale', () => {
  it('shows the language, with its direction on the document', async () => {
    await setLocale('ar-XB');
    expect(i18n.global.locale.value).toBe('ar-XB');
    expect(document.documentElement.lang).toBe('ar-XB');
    expect(document.documentElement.dir).toBe('rtl');
    await setLocale('en');
    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('keeps the current language when one cannot be loaded', async () => {
    await expect(setLocale('tlh')).resolves.toBeUndefined();
    expect(i18n.global.locale.value).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('lets the last choice win while an earlier one loads', async () => {
    await Promise.all([setLocale('en-XA'), setLocale('ar-XB')]);
    expect(i18n.global.locale.value).toBe('ar-XB');
  });

  it('translates through the pseudo-locale', async () => {
    await setLocale('en-XA');
    expect(t('errors.generic')).toContain('⟦');
  });
});

describe.each(LOCALES.map(({ code }) => code))('%s plural messages', (code) => {
  it.each(pluralKeys)('%s has a form for every count', async (key, message) => {
    await setLocale(code);
    const params = Object.fromEntries(
      [...message.matchAll(/\{(\w+)\}/g)].map(([, name]) => [name ?? '', 'x']),
    );
    for (const count of [0, 1, 2, 3, 11, 100, 1_000_000]) {
      const text = t(key, params, count);
      expect(text).not.toBe('');
      expect(text).not.toContain('undefined');
      expect(text).not.toBe(key);
    }
  });
});

describe('message parameters', () => {
  const NewsTitle = defineComponent({
    setup() {
      const { t } = useI18n();
      return () => h('p', t('appearance.saved', { name: 'חדשות' }));
    },
  });

  it('are isolated in components too, through the one composer they use', () => {
    expect(mountWithPlugins(NewsTitle).text()).toContain('\u2068חדשות\u2069');
  });

  it('format numbers, keeping the plural choice with or without an explicit count', () => {
    expect(t('tags.count', { n: 1234 }, 1234)).toBe('1,234 articles');
    expect(t('tags.count', { n: 1234 })).toBe('1,234 articles');
    expect(t('tags.count', { n: 1 })).toBe('1 article');
    expect(t('ops.serverErrors', { count: 1 })).toBe('1 server error');
    expect(t('ops.serverErrors', { count: 2000 })).toBe('2,000 server errors');
  });

  it('leave English left-to-right text as it was', () => {
    expect(t('appearance.saved', { name: 'Fish' })).toBe(
      en.appearance.saved.replace('{name}', 'Fish'),
    );
  });

  it('isolate all text in a right-to-left UI', async () => {
    await setLocale('ar-XB');
    expect(t('appearance.saved', { name: 'Fish' })).toContain('\u2068Fish\u2069');
  });

  it('fill positional text too', () => {
    expect(vuetifyLocale.adapter.t('$vuetify.input.clear', 'חדשות')).toContain('\u2068חדשות\u2069');
  });
});

describe('vuetifyLocale', () => {
  it("serves Vuetify's own text in the app's language", async () => {
    const { adapter } = vuetifyLocale;
    expect(adapter.t('$vuetify.noDataText')).toBe('No data available');
    await setLocale('en-XA');
    expect(adapter.t('$vuetify.noDataText')).toContain('⟦');
  });

  it('fills positional params', () => {
    expect(vuetifyLocale.adapter.t('$vuetify.carousel.ariaLabel.delimiter', 2, 5)).toBe(
      'Carousel slide 2 of 5',
    );
  });

  it('marks right-to-left languages', () => {
    expect(vuetifyLocale.rtl).toMatchObject({ en: false, 'ar-XB': true });
  });
});
