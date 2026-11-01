import type { Entry } from '@newses/shared';
import { describe, expect, it } from 'vitest';
import en from '../locales/en.json' with { type: 'json' };
import { notFoundPage, sharedEntryPage } from './public-page.ts';

const entry = {
  title: null,
  link: 'https://news.example/a',
  publishedAt: '2026-10-04T12:00:00Z',
  sortAt: '2026-10-04T12:00:00Z',
  content: '<p>Text</p>',
  enclosures: [{ url: 'https://news.example/a.mp3' }],
} as unknown as Entry;

describe('public pages', () => {
  it('take their text from the locale file', () => {
    const page = sharedEntryPage(entry);
    expect(page).toContain('<html lang="en">');
    expect(page).toContain(`<title>${en.untitled}</title>`);
    expect(page).toContain(`<h2>${en.attachments}</h2>`);
    expect(page).toContain(`>${en.readOriginal}</a>`);
    expect(page).toContain(`<footer>${en.sharedFrom}</footer>`);
    expect(page).toContain('October 4, 2026');
  });

  it('say when a link leads nowhere', () => {
    const page = notFoundPage();
    expect(page).toContain(`<title>${en.notAvailable}</title>`);
    expect(page).toContain(`<p>${en.notAvailableText}</p>`);
  });
});
