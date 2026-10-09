import { and, eq, inArray } from 'drizzle-orm';
import { subscriptions } from '../../db/schema.ts';
import type { ImportStep } from '../importer.ts';
import { importedUsers } from './common.ts';
import { FEEDS } from './feeds.ts';

/** Keys of `af_readability` plugin storage that list feeds getting full text. */
const OPT_IN_KEYS = ['enabled_feeds', 'append_feeds'];

/**
 * Feed ids listed under `key` in plugin storage, stored as JSON or as PHP-serialised arrays
 * (`s:13:"enabled_feeds";a:2:{i:0;i:12;i:1;s:2:"34";}`).
 */
export function storedFeedIds(content: string, key: string): number[] {
  try {
    const value: unknown = JSON.parse(content);
    if (value && typeof value === 'object') {
      const list = (value as Record<string, unknown>)[key];
      const items: unknown[] = Array.isArray(list)
        ? list
        : list && typeof list === 'object'
          ? Object.values(list)
          : [];
      return items.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);
    }
  } catch {
    // Not JSON: PHP serialisation, below.
  }
  const array = new RegExp(`s:\\d+:"${key}";a:\\d+:\\{([^}]*)\\}`).exec(content)?.[1] ?? '';
  // Keys and values alternate: i:<n>; or s:<length>:"<text>";
  const tokens = [...array.matchAll(/i:(-?\d+);|s:\d+:"([^"]*)";/g)].map((m) => m[1] ?? m[2] ?? '');
  return tokens
    .filter((_, index) => index % 2 === 1)
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0);
}

/**
 * Full-text opt-ins from TTRSS's Readability plugin: the subscriptions of the feeds it lists get
 * full text here.
 */
export const fullTextStep: ImportStep = {
  name: 'full-text opt-ins',
  async run(context) {
    const { source, map, report, write } = context;
    for (const { source: user, userId } of await importedUsers(context)) {
      const { login } = user;
      const rows = await source.query<{ content: string }>(
        `SELECT content FROM ttrss_plugin_storage
         WHERE owner_uid = $1 AND lower(name) = 'af_readability'`,
        [user.id],
      );
      const feedIds = [
        ...new Set(
          rows.flatMap((r) => OPT_IN_KEYS.flatMap((key) => storedFeedIds(r.content, key))),
        ),
      ];
      report.count(login, 'full-text opt-ins', { source: feedIds.length });
      if (feedIds.length === 0) continue;
      const subs = await map.targets(FEEDS, feedIds);
      for (const id of feedIds)
        if (!subs.has(id)) report.skip(login, 'full-text opt-ins', id, 'its feed was not imported');
      const ids = [...subs.values()];
      if (ids.length > 0)
        await write((tx) =>
          tx
            .update(subscriptions)
            .set({ fullText: true })
            .where(and(eq(subscriptions.userId, userId), inArray(subscriptions.id, ids))),
        );
      report.count(login, 'full-text opt-ins', { imported: ids.length });
    }
  },
};
