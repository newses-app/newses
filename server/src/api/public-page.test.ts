import type { Entry } from '@newses/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../i18n.ts';
import en from '../locales/en.json' with { type: 'json' };
import { notFoundPage, sharedEntryPage } from './public-page.ts';

vi.mock('@newses/shared/locales', async (original) => {
  const actual = await original<typeof import('@newses/shared/locales')>();
  const arabic = { code: 'ar', name: 'العربية', direction: 'rtl', plurals: ['other'] };
  return { ...actual, LOCALES: [...actual.LOCALES, arabic] };
});

const entry = {
  title: null,
  link: 'https://news.example/a',
  publishedAt: '2026-10-04T12:00:00Z',
  sortAt: '2026-10-04T12:00:00Z',
  content: '<p>Text</p>',
  enclosures: [{ url: 'https://news.example/a.mp3' }],
} as unknown as Entry;

describe('public pages', () => {
  afterEach(() => {
    delete MESSAGES.es;
  });

  it('take their text from the locale file', () => {
    const page = sharedEntryPage(entry, 'en');
    expect(page).toContain('<html lang="en" dir="ltr">');
    expect(page).toContain(`<title>${en.untitled}</title>`);
    expect(page).toContain(`<h2>${en.attachments}</h2>`);
    expect(page).toContain(`>${en.readOriginal}</a>`);
    expect(page).toContain(`<footer>${en.sharedFrom}</footer>`);
    expect(page).toContain('October 4, 2026');
  });

  it('take their language, direction, and date from the locale', () => {
    MESSAGES.es = { readOriginal: 'Leer el original' };
    const page = sharedEntryPage(entry, 'es');
    expect(page).toContain('<html lang="es" dir="ltr">');
    expect(page).toContain('4 de octubre de 2026');
    expect(page).toContain('>Leer el original</a>');
    expect(page).toContain(`<footer>${en.sharedFrom}</footer>`);
    expect(notFoundPage('ar')).toContain('<html lang="ar" dir="rtl">');
  });

  it("carry the article's own direction and language, separate from the page's", () => {
    const page = sharedEntryPage(
      { ...entry, title: 'كتاب', lang: 'ar"', feedTitle: 'أخبار', author: 'A <b>' },
      'en',
    );
    expect(page).toContain('<h1 dir="auto" lang="ar&quot;">');
    expect(page).toContain('<div dir="auto" lang="ar&quot;">\n<p>Text</p>\n</div>');
    expect(page).toContain('<bdi>أخبار</bdi> · <bdi>A &lt;b&gt;</bdi>');
  });

  it('leave a language out when the feed gave none', () => {
    expect(sharedEntryPage(entry, 'en')).toContain('<div dir="auto">');
  });

  it('say when a link leads nowhere', () => {
    const page = notFoundPage('en');
    expect(page).toContain(`<title>${en.notAvailable}</title>`);
    expect(page).toContain(`<p>${en.notAvailableText}</p>`);
  });
});
