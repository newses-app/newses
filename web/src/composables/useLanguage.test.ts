import type { Prefs } from '@newses/shared';
import { DEFAULT_PREFS } from '@newses/shared/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, defineComponent, h, nextTick, shallowRef } from 'vue';
import { bridge } from '../platform/index.ts';
import { i18n, setLocale } from '../plugins/i18n.ts';
import { mountWithPlugins } from '../test/mount.ts';
import { startLanguage, useLanguage, useLanguagePicker } from './useLanguage.ts';

const prefs = shallowRef<Partial<Prefs>>(DEFAULT_PREFS);
const loaded = shallowRef(true);
const update = vi.fn((changes: Partial<Prefs>) => {
  prefs.value = { ...prefs.value, ...changes };
});

vi.mock('./usePrefs.ts', () => ({
  usePrefs: () => ({ prefs: computed(() => prefs.value), loaded, update }),
}));

const CACHE_KEY = 'newses.language';
const shown = () => i18n.global.locale.value;

function deviceLanguages(languages: string[]) {
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(languages);
}

/** What a component using `setup` returns, with its scope alive so watchers run. */
function inComponent<T>(setup: () => T): T {
  let result: T | undefined;
  mountWithPlugins(
    defineComponent({
      setup() {
        result = setup();
        return () => h('div');
      },
    }),
  );
  return result as T;
}

/** Lets the language load after a change, then what follows from it. */
const settle = async () => {
  await nextTick();
  await vi.waitFor(() => {
    expect(i18n.global.availableLocales).toBeDefined();
  });
  await new Promise((resolve) => setTimeout(resolve));
};

beforeEach(async () => {
  vi.restoreAllMocks();
  update.mockClear();
  localStorage.clear();
  prefs.value = DEFAULT_PREFS;
  loaded.value = true;
  deviceLanguages(['en-US']);
  await setLocale('en');
  await startLanguage();
});

describe('startLanguage', () => {
  it('takes the language last shown here over the device', async () => {
    localStorage.setItem(CACHE_KEY, 'en-XA');
    deviceLanguages(['ar-XB']);
    await startLanguage();
    expect(shown()).toBe('en-XA');
  });

  it("follows the device's languages without one", async () => {
    deviceLanguages(['tlh', 'ar-XB', 'en']);
    await startLanguage();
    expect(shown()).toBe('ar-XB');
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('tells the shell the language shown, for its menus', async () => {
    const setLanguage = vi.spyOn(bridge, 'setLanguage');
    deviceLanguages(['ar-XB']);
    await startLanguage();
    expect(setLanguage).toHaveBeenLastCalledWith('ar-XB');
  });

  it('falls through a choice no longer on offer', async () => {
    localStorage.setItem(CACHE_KEY, 'tlh');
    deviceLanguages(['en-XA']);
    await startLanguage();
    expect(shown()).toBe('en-XA');
  });

  it('ends at English', async () => {
    deviceLanguages(['tlh']);
    await startLanguage();
    expect(shown()).toBe('en');
  });

  it('applies before mounting, which signed-out screens rely on', async () => {
    localStorage.setItem(CACHE_KEY, 'en-XA');
    await startLanguage();
    expect(document.documentElement.lang).toBe('en-XA');
  });
});

describe('a device language change', () => {
  it('is followed while no language is chosen', async () => {
    deviceLanguages(['en-XA']);
    window.dispatchEvent(new Event('languagechange'));
    await settle();
    expect(shown()).toBe('en-XA');
  });

  it('is ignored with a language chosen', async () => {
    localStorage.setItem(CACHE_KEY, 'ar-XB');
    await startLanguage();
    deviceLanguages(['en-XA']);
    window.dispatchEvent(new Event('languagechange'));
    await settle();
    expect(shown()).toBe('ar-XB');
  });
});

describe('useLanguage', () => {
  it('applies and caches the preference once loaded', async () => {
    loaded.value = false;
    prefs.value = { ...DEFAULT_PREFS, language: 'en-XA' };
    inComponent(useLanguage);
    await settle();
    expect(shown()).toBe('en');
    loaded.value = true;
    await settle();
    expect(shown()).toBe('en-XA');
    expect(localStorage.getItem(CACHE_KEY)).toBe('en-XA');
  });

  it('forgets the cached language when the reader goes back to the device', async () => {
    localStorage.setItem(CACHE_KEY, 'en-XA');
    await startLanguage();
    inComponent(useLanguage);
    await settle();
    expect(shown()).toBe('en');
    expect(localStorage.getItem(CACHE_KEY)).toBeNull();
  });

  it('keeps the cached language on an older server, which has no such preference', async () => {
    localStorage.setItem(CACHE_KEY, 'en-XA');
    await startLanguage();
    const { language: _, ...older } = DEFAULT_PREFS;
    prefs.value = older;
    inComponent(useLanguage);
    await settle();
    expect(shown()).toBe('en-XA');
    expect(localStorage.getItem(CACHE_KEY)).toBe('en-XA');
  });

  it("follows another device's change to the preference", async () => {
    inComponent(useLanguage);
    prefs.value = { ...DEFAULT_PREFS, language: 'ar-XB' };
    await settle();
    expect(shown()).toBe('ar-XB');
  });
});

describe('useLanguagePicker', () => {
  it('offers the system default and each language by its own name', () => {
    const { items, value } = inComponent(useLanguagePicker);
    expect(items.value[0]).toEqual({ title: 'System default', value: 'system' });
    expect(items.value).toContainEqual({ title: 'English', value: 'en' });
    expect(value.value).toBe('system');
  });

  it('saves a choice to the server', async () => {
    inComponent(useLanguage);
    const picker = inComponent(useLanguagePicker);
    expect(picker.onServer.value).toBe(true);
    picker.change('en-XA');
    await settle();
    expect(update).toHaveBeenCalledWith({ language: 'en-XA' });
    expect(shown()).toBe('en-XA');
    expect(picker.value.value).toBe('en-XA');
  });

  it('saves the system default as null', () => {
    inComponent(useLanguagePicker).change('system');
    expect(update).toHaveBeenCalledWith({ language: null });
  });

  it('never sends the language to an older server, and keeps it on this device', async () => {
    const { language: _, ...older } = DEFAULT_PREFS;
    prefs.value = older;
    const picker = inComponent(useLanguagePicker);
    expect(picker.onServer.value).toBe(false);
    picker.change('en-XA');
    await settle();
    expect(update).not.toHaveBeenCalled();
    expect(shown()).toBe('en-XA');
    expect(localStorage.getItem(CACHE_KEY)).toBe('en-XA');
    expect(picker.value.value).toBe('en-XA');
  });
});
