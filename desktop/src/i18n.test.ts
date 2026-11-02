import { LOCALES } from '@newses/shared/locales';
import { afterEach, describe, expect, it } from 'vitest';
import { MESSAGES, setLanguage, t } from './i18n.ts';
import en from './locales/en.json' with { type: 'json' };

afterEach(() => {
  MESSAGES.en = en;
});

describe('MESSAGES', () => {
  it('holds every language in the registry', () => {
    expect(Object.keys(MESSAGES).sort()).toEqual(LOCALES.map((locale) => locale.code).sort());
  });
});

describe('setLanguage', () => {
  it('takes the first language on offer, as itself or its base language', () => {
    expect(setLanguage(['tlh', 'en-GB'])).toBe('en');
  });

  it('uses the default when none is on offer', () => {
    expect(setLanguage(['tlh'])).toBe('en');
    expect(setLanguage([])).toBe('en');
  });
});

describe('t', () => {
  it('returns the text of a key', () => {
    expect(t('open')).toBe('Open');
  });

  it('shows the language set, in English where it has no translation', () => {
    MESSAGES.en = { ...en, open: 'Abrir' };
    delete MESSAGES.en.quit;
    expect(t('open')).toBe('Abrir');
    expect(t('quit')).toBe('Quit');
    MESSAGES.en = en;
  });

  it('fills in params, taking their text literally', () => {
    expect(t('signedOut', { name: 'Home' })).toBe('Home (signed out)');
    expect(t('signedOut', { name: "$& {name} $'" })).toBe("$& {name} $' (signed out)");
  });
});
