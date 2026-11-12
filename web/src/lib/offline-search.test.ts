import { describe, expect, it } from 'vitest';
import { parseSearchQuery } from '@newses/shared/client';
import type { Entry } from '@newses/shared';
import { htmlText, matchesFilters, searchTerms, searchWords, tokenise } from './offline-search.ts';

describe('tokenise', () => {
  it('folds case and accents, and splits on everything but letters and digits', () => {
    expect(tokenise('Café DÉJÀ-vu, naïve 2026!')).toEqual(['cafe', 'deja', 'vu', 'naive', '2026']);
  });

  it('indexes CJK as overlapping character pairs, apart from other letters', () => {
    expect(tokenise('東京都')).toEqual(['東京', '京都']);
    expect(tokenise('iPhone用の')).toEqual(['iphone', '用の']);
    expect(tokenise('猫')).toEqual(['猫']);
    expect(tokenise('한국어')).toEqual(['한국', '국어']);
  });
});

describe('searchWords', () => {
  it('keeps each word once, across texts', () => {
    expect(searchWords('Cats and cats', null, 'Dogs and CATS')).toEqual(['cats', 'and', 'dogs']);
  });
});

describe('htmlText', () => {
  it('drops tags, scripts, and styles, and decodes entities', () => {
    const text = htmlText(
      '<p>Fish&nbsp;&amp;&#32;chips<script>x()</script><style>p{}</style> &#x263A; &bogus;</p>',
    );
    expect(text.replace(/\s+/g, ' ')).toBe(' Fish & chips ☺ &bogus; ');
  });
});

describe('searchTerms', () => {
  it('matches every word whole and the last as a prefix', () => {
    expect(searchTerms('Rust  rust comp')).toEqual({ words: ['rust'], prefix: 'comp' });
    expect(searchTerms('  ')).toEqual({ words: [], prefix: null });
  });

  it('matches CJK pairs whole, and a lone character as a prefix', () => {
    expect(searchTerms('東京都')).toEqual({ words: ['東京', '京都'], prefix: null });
    expect(searchTerms('東')).toEqual({ words: [], prefix: '東' });
  });
});

describe('matchesFilters', () => {
  const entry = { sortAt: '2026-10-01T23:30:00.000Z' } as Entry;
  const matches = (q: string, timeZone: string) =>
    matchesFilters(entry, parseSearchQuery(q).filters, {
      labels: new Map(),
      timeZone,
      now: new Date('2026-10-02T12:00:00.000Z'),
    });

  it('reads dates in the time zone given', () => {
    expect(matches('@2026-10-01', 'UTC')).toBe(true);
    expect(matches('@2026-10-02', 'Europe/Berlin')).toBe(true);
    expect(matches('@yesterday', 'UTC')).toBe(true);
    expect(matches('@today', 'Europe/Berlin')).toBe(true);
    expect(matches('-@2026-10-01', 'UTC')).toBe(false);
  });
});
