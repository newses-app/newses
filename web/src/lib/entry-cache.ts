import type { Entry, EntryListResponse, EntryState } from '@rss-reader/shared';
import type { InfiniteData } from '@tanstack/vue-query';

/** The flags of `state` that are set, as a partial entry. */
export const statePatch = (state: EntryState): Partial<Entry> =>
  Object.fromEntries(Object.entries(state).filter(([, value]) => value !== undefined));

/** Applies `patch` to the listed entries in every loaded page, keeping list order and length. */
export function patchEntryPages(
  data: InfiniteData<EntryListResponse> | undefined,
  ids: ReadonlySet<number>,
  patch: Partial<Entry>,
): InfiniteData<EntryListResponse> | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      entries: page.entries.map((entry) => (ids.has(entry.id) ? { ...entry, ...patch } : entry)),
    })),
  };
}
