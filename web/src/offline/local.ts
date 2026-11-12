import type {
  Category,
  Entry,
  EntryListResponse,
  Label,
  MarkReadRequest,
  SearchTerm,
  Prefs,
  Subscription,
} from '@newses/shared';
import { DEFAULT_PREFS, localTimeZone, parseSearchQuery } from '@newses/shared/client';
import Dexie from 'dexie';
import { proxiedHtml } from '../lib/offline-content.ts';
import { isCjk, matchesFilters, searchTerms, tokenise } from '../lib/offline-search.ts';
import { type Stem, stemmersFor } from '../lib/stemmers.ts';
import {
  type LocalListQuery,
  localPage,
  type StreamContext,
  streamFilter,
} from '../lib/offline-streams.ts';
import { connectivity } from './connectivity.ts';
import { fromStoredEntry, type OfflineDb, type StoredContent, toStoredEntry } from './db.ts';
import { withChange, withPendingResources } from './outbox.ts';
import { readQuery, type SnapshotQuery } from './snapshot.ts';
import { currentStore } from './store.ts';

/** Queries with a stored answer run even offline, so they can fall back to it instead of pausing. */
export const storeNetworkMode = (): 'always' | 'online' => (currentStore() ? 'always' : 'online');

/**
 * The server's answer, or the store's when the server cannot be reached and the store has one.
 * Without a network the server is not asked at all.
 */
export async function networkOrStore<T>(
  remote: () => Promise<T>,
  local: (db: OfflineDb) => Promise<T | undefined>,
): Promise<T> {
  const db = currentStore();
  if (db && connectivity.value === 'offline') {
    const stored = await local(db).catch(() => undefined);
    if (stored !== undefined) return stored;
  }
  try {
    return await remote();
  } catch (error) {
    if (db && connectivity.value !== 'online') {
      const stored = await local(db).catch(() => undefined);
      if (stored !== undefined) return stored;
    }
    throw error;
  }
}

/** Query options for a snapshot query: the server's answer, or the stored one when it cannot be reached. */
export function storedQuery<T>(name: SnapshotQuery, remote: () => Promise<T>) {
  // Changes still waiting show over either answer.
  const pending = async (data: T) => {
    const db = currentStore();
    return db ? withPendingResources(db, name, data) : data;
  };
  return {
    queryFn: () =>
      networkOrStore(
        async () => pending(await remote()),
        async (db) => {
          const stored = await readQuery<T>(db, name);
          return stored === undefined ? undefined : pending(stored);
        },
      ),
    networkMode: storeNetworkMode(),
  };
}

async function storedPrefs(db: OfflineDb): Promise<Prefs> {
  return { ...DEFAULT_PREFS, ...(await readQuery<Partial<Prefs>>(db, 'prefs')) };
}

/**
 * An entry with its stored content as the server would serve it: images at their proxy paths
 * for readers who proxy them. `content` is null when none is stored.
 */
function withContent(
  entry: Entry,
  content: StoredContent | undefined,
  proxyImages: boolean,
): Entry {
  if (!content) return { ...entry, content: null, fullContent: null, enclosures: [] };
  const serve = (html: string | null) =>
    html && proxyImages
      ? proxiedHtml(html, new Map(content.images.map((i) => [i.url, i.proxy])))
      : html;
  return {
    ...entry,
    content: serve(content.content),
    fullContent: serve(content.fullContent),
    enclosures: content.enclosures,
  };
}

/** The tree and preferences that stream membership and counters depend on, as stored. */
export async function storedStreamContext(db: OfflineDb, now = Date.now()) {
  const [categories, subscriptions, prefs] = await Promise.all([
    readQuery<Category[]>(db, 'categories'),
    readQuery<Subscription[]>(db, 'subscriptions'),
    storedPrefs(db),
  ]);
  const context: StreamContext = {
    categories: categories ?? [],
    subscriptions: subscriptions ?? [],
    scoreHideBelow: prefs.scoreHideBelow,
    freshMaxAgeHours: prefs.freshMaxAgeHours,
    now,
  };
  return { context, prefs };
}

/**
 * Ids of stored entries whose headline or content has a word, or (as `prefix`) one starting so.
 * A whole word also matches the stored words with its stem in one of `stems`' languages.
 */
async function matching(
  db: OfflineDb,
  word: string,
  prefix: boolean,
  stems: readonly Stem[] = [],
): Promise<Set<number>> {
  const tables = [db.entries, db.contents] as const;
  if (prefix) {
    const found = await Promise.all(
      tables.map((table) => table.where('words').startsWith(word).primaryKeys()),
    );
    return new Set(found.flat());
  }
  const forms = new Set([word]);
  if (!isCjk(word))
    for (const stem of stems) {
      const root = stem(word);
      // Stems are mostly a prefix of their words; one character less covers most that are not.
      const chars = Array.from(root);
      const start = chars.length > 3 ? chars.slice(0, -1).join('') : root;
      for (const table of tables)
        for (const key of await table.where('words').startsWith(start).uniqueKeys())
          if (typeof key === 'string' && stem(key) === root) forms.add(key);
    }
  const found = await Promise.all(
    tables.map((table) =>
      table
        .where('words')
        .anyOf([...forms])
        .primaryKeys(),
    ),
  );
  return new Set(found.flat());
}

/**
 * Ids of stored entries with every word of `text`, with `prefixed` the last one as a prefix;
 * null without words.
 */
async function withWords(
  db: OfflineDb,
  text: string,
  prefixed: boolean,
  stems: readonly Stem[],
): Promise<Set<number> | null> {
  const { words, prefix } = prefixed
    ? searchTerms(text)
    : { words: [...new Set(tokenise(text))], prefix: null };
  const sets = await Promise.all([
    ...words.map((word) => matching(db, word, false, stems)),
    // The word being typed: a prefix, or a word of its own.
    ...(prefix === null
      ? []
      : [
          Promise.all([matching(db, prefix, true), matching(db, prefix, false, stems)]).then(
            ([started, whole]) => new Set([...started, ...whole]),
          ),
        ]),
  ]);
  if (sets.length === 0) return null;
  // Smallest first, so the intersection stays small.
  const [first, ...rest] = sets.sort((a, b) => a.size - b.size);
  return new Set([...(first ?? [])].filter((id) => rest.every((set) => set.has(id))));
}

const LANGUAGES_TTL = 5 * 60_000;
const storedLanguageTags = new WeakMap<OfflineDb, { at: number; tags: Promise<string[]> }>();

/** Languages to stem a search in: the stored entries' (looked up every few minutes) and the app's. */
async function searchLanguageTags(db: OfflineDb): Promise<string[]> {
  let cached = storedLanguageTags.get(db);
  if (!cached || Date.now() - cached.at > LANGUAGES_TTL) {
    const tags = new Set<string>();
    cached = {
      at: Date.now(),
      tags: db.entries
        .each((entry) => {
          if (entry.lang) tags.add(entry.lang);
        })
        .then(() => [...tags]),
    };
    storedLanguageTags.set(db, cached);
  }
  return [...(await cached.tags), document.documentElement.lang, ...navigator.languages];
}

/**
 * Stored entries matching a search's free text, as the server matches it: every group of
 * alternatives (terms joined by `OR`), a term when the headline or content has all its words,
 * as written or in another form of their language, the last word typed as a prefix; a negated
 * term when it has not. Null when the search has no words.
 */
export async function searchStore(db: OfflineDb, q: string): Promise<Set<number> | null> {
  const { groups } = parseSearchQuery(q);
  if (groups.length === 0) return null;
  const stems = await stemmersFor(await searchLanguageTags(db));
  const typing = groups.at(-1)?.at(-1);
  let all: Set<number> | undefined;
  const termIds = async (term: SearchTerm): Promise<Set<number>> => {
    const ids =
      (await withWords(db, term.value, term === typing && !term.negated, stems)) ?? new Set();
    if (!term.negated) return ids;
    all ??= new Set<number>(await db.entries.toCollection().primaryKeys());
    return new Set([...all].filter((id) => !ids.has(id)));
  };
  const sets = await Promise.all(
    groups.map(
      async (group) => new Set((await Promise.all(group.map(termIds))).flatMap((ids) => [...ids])),
    ),
  );
  // Smallest first, so the intersection stays small.
  const [first, ...rest] = sets.sort((a, b) => a.size - b.size);
  return new Set([...(first ?? [])].filter((id) => rest.every((set) => set.has(id))));
}

/**
 * One page of a stream from the store, with content when asked for; with `q`, only the entries
 * matching its free text and filters, newest first.
 */
export async function localList(
  db: OfflineDb,
  query: LocalListQuery & { content: boolean; q?: string | null },
): Promise<EntryListResponse> {
  const found = query.q ? await searchStore(db, query.q) : null;
  const [{ context, prefs }, stored, labels] = await Promise.all([
    storedStreamContext(db),
    found
      ? db.entries.bulkGet([...found]).then((rows) => rows.filter((r) => r !== undefined))
      : db.entries.toArray(),
    readQuery<Label[]>(db, 'labels'),
  ]);
  const filters = query.q ? parseSearchQuery(query.q).filters : [];
  const filterContext = {
    labels: new Map((labels ?? []).map((l) => [l.id, l.caption])),
    timeZone: localTimeZone(),
    now: new Date(),
  };
  const page = localPage(
    stored.map(fromStoredEntry).filter((e) => matchesFilters(e, filters, filterContext)),
    query,
    context,
  );
  if (!query.content) return page;
  const contents = await db.contents.bulkGet(page.entries.map((e) => e.id));
  return {
    ...page,
    entries: page.entries.map((e, i) => withContent(e, contents[i], prefs.proxyImages)),
  };
}

/**
 * A stored entry with its content. With `current`, only when the stored content is the entry's
 * latest version, so it can be shown without asking the server.
 */
export async function localEntry(
  db: OfflineDb,
  id: number,
  current = false,
): Promise<Entry | undefined> {
  const [entry, content, prefs] = await Promise.all([
    db.entries.get(id),
    db.contents.get(id),
    storedPrefs(db),
  ]);
  if (!entry) return undefined;
  if (current && content?.contentVersion !== entry.contentVersion) return undefined;
  return withContent(fromStoredEntry(entry), content, prefs.proxyImages);
}

/** The highest entry id the store has, the newest the device knows of. */
export async function newestStoredId(db: OfflineDb): Promise<number | undefined> {
  return (await db.entries.orderBy(':id').lastKey()) as number | undefined;
}

/**
 * Catch-up on the stored entries, as the server will apply it: the stream's unread entries, older
 * than `olderThanDays` and up to `maxId` when given. Returns the entries as they were.
 */
export async function localCatchUp(
  db: OfflineDb,
  request: MarkReadRequest,
  now = Date.now(),
): Promise<Entry[]> {
  const { context } = await storedStreamContext(db, now);
  const inStream = streamFilter(request, context);
  const before =
    request.olderThanDays === undefined
      ? null
      : new Date(now - request.olderThanDays * 86_400_000).toISOString();
  return db.transaction('rw', db.entries, async () => {
    const caught = (
      await db.entries
        .where('[unread+sortAt]')
        .between([1, Dexie.minKey], [1, Dexie.maxKey])
        .toArray()
    )
      .map(fromStoredEntry)
      .filter(
        (e) =>
          inStream(e) &&
          (before === null || e.sortAt < before) &&
          (request.maxId === undefined || e.id <= request.maxId),
      );
    await db.entries.bulkPut(
      caught.map((e) => toStoredEntry(withChange(e, { unread: false }, now))),
    );
    return caught;
  });
}

/** Applies a change made on this device to the stored copies of entries; returns them as they were. */
export async function changeStored(
  db: OfflineDb,
  ids: readonly number[],
  patch: Partial<Entry>,
  now = Date.now(),
): Promise<Entry[]> {
  return db.transaction('rw', db.entries, async () => {
    const before = (await db.entries.bulkGet([...ids]))
      .filter((e) => e !== undefined)
      .map(fromStoredEntry);
    await db.entries.bulkPut(before.map((e) => toStoredEntry(withChange(e, patch, now))));
    return before;
  });
}
