import type { Entry, EntryListResponse } from '@rss-reader/shared';
import type { InfiniteData } from '@tanstack/vue-query';
import { describe, expect, it } from 'vitest';
import { patchEntryPages, statePatch } from './entry-cache.ts';

const entry = (id: number): Entry => ({
  id,
  subscriptionId: 1,
  feedTitle: 'F',
  title: `E${String(id)}`,
  link: null,
  author: null,
  publishedAt: null,
  sortAt: '2026-10-04T00:00:00.000Z',
  unread: true,
  starred: false,
  published: false,
  score: 0,
  note: null,
  labels: [],
  tags: [],
  shareId: null,
  excerpt: null,
});

describe('patchEntryPages', () => {
  it('patches matching entries across pages and keeps the rest', () => {
    const data: InfiniteData<EntryListResponse> = {
      pages: [
        { entries: [entry(1), entry(2)], cursor: 'x', view: 'unread' },
        { entries: [entry(3)], cursor: null, view: 'unread' },
      ],
      pageParams: ['', 'x'],
    };
    const patched = patchEntryPages(
      data,
      new Set([1, 3]),
      statePatch({ unread: false, starred: undefined }),
    );
    expect(
      patched?.pages.flatMap((p) => p.entries.map((e) => [e.id, e.unread, e.starred])),
    ).toEqual([
      [1, false, false],
      [2, true, false],
      [3, false, false],
    ]);
    expect(patchEntryPages(undefined, new Set([1]), {})).toBeUndefined();
  });
});
