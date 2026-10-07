import { DEFAULT_PREFS, type Stream } from '@rss-reader/shared';
import { type SQL, sql } from 'drizzle-orm';
import { userPrefInt } from '../prefs.ts';

/** Recently read lists entries read within this many days. */
export const RECENTLY_READ_DAYS = 7;

/** Condition on `user_entries ue` selecting `stream` for `userId` (the user condition included). */
export function streamCondition(userId: number, stream: Stream): SQL {
  const user = sql`ue.user_id = ${userId}`;
  if (stream.subscriptionId !== undefined)
    return sql`${user} AND ue.subscription_id = ${stream.subscriptionId}`;
  if (stream.categoryId === 0)
    return sql`${user} AND ue.subscription_id IN (
      SELECT s.id FROM subscriptions s WHERE s.user_id = ${userId} AND s.category_id IS NULL)`;
  if (stream.labelId !== undefined)
    return sql`${user} AND ue.id IN (
      SELECT el.user_entry_id FROM entry_labels el WHERE el.label_id = ${stream.labelId})`;
  if (stream.tag !== undefined)
    return sql`${user} AND ue.id IN (
      SELECT et.user_entry_id FROM entry_tags et
      WHERE et.user_id = ${userId} AND et.tag = ${stream.tag})`;
  if (stream.categoryId !== undefined)
    return sql`${user} AND ue.subscription_id IN (
      SELECT s.id FROM subscriptions s WHERE s.user_id = ${userId} AND s.category_id IN (
        WITH RECURSIVE tree(id) AS (
          SELECT c.id FROM categories c WHERE c.id = ${stream.categoryId} AND c.user_id = ${userId}
          UNION SELECT c.id FROM categories c JOIN tree t ON c.parent_id = t.id)
        SELECT id FROM tree))`;
  switch (stream.special) {
    case undefined:
    case 'all':
      return user;
    case 'fresh':
      return sql`${user} AND ue.unread AND ue.sort_at > ${freshSince(userId)}`;
    case 'starred':
      return sql`${user} AND ue.starred`;
    case 'published':
      return sql`${user} AND ue.published`;
    case 'recentlyRead':
      return sql`${user} AND ue.read_at > now() - make_interval(days => ${RECENTLY_READ_DAYS})`;
  }
}

/** Start of the user's Fresh window. */
export const freshSince = (userId: number): SQL =>
  sql`now() - make_interval(hours => coalesce(${userPrefInt(sql`${userId}`, 'freshMaxAgeHours')}, ${DEFAULT_PREFS.freshMaxAgeHours}))`;
