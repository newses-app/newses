import type { Counters } from '@rss-reader/shared';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { categories, subscriptions } from '../../db/schema.ts';
import { freshSince, scoreShown } from './streams.ts';

interface LabelCountRow extends Record<string, unknown> {
  id: number;
  unread: string;
}

interface CountRow extends Record<string, unknown> {
  subscription_id: number | null;
  unread: string;
  fresh: string;
  starred: string;
  published: string;
}

export class CounterService {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * Unread counts per subscription, per category (including subcategories), per label, and per
   * special feed. Entries hidden by their score count only where they are listed: in Starred,
   * Published, and labels.
   */
  async get(userId: number): Promise<Counters> {
    const [counts, subs, cats, labelCounts] = await Promise.all([
      this.#db.execute<CountRow>(sql`
        SELECT ue.subscription_id, count(*) FILTER (WHERE ${scoreShown(userId)}) AS unread,
          count(*) FILTER (WHERE ${scoreShown(userId)} AND ue.sort_at > ${freshSince(userId)}) AS fresh,
          count(*) FILTER (WHERE ue.starred) AS starred,
          count(*) FILTER (WHERE ue.published) AS published
        FROM user_entries ue
        WHERE ue.user_id = ${userId} AND ue.unread
        GROUP BY ue.subscription_id`),
      this.#db
        .select({ id: subscriptions.id, categoryId: subscriptions.categoryId })
        .from(subscriptions)
        .where(eq(subscriptions.userId, userId)),
      this.#db
        .select({ id: categories.id, parentId: categories.parentId })
        .from(categories)
        .where(eq(categories.userId, userId)),
      this.#db.execute<LabelCountRow>(sql`
        SELECT l.id, count(ue.id) AS unread
        FROM labels l
        LEFT JOIN entry_labels el ON el.label_id = l.id
        LEFT JOIN user_entries ue ON ue.id = el.user_entry_id AND ue.unread
        WHERE l.user_id = ${userId}
        GROUP BY l.id`),
    ]);

    const special = { all: 0, fresh: 0, starred: 0, published: 0 };
    const bySubscription = new Map<number, number>();
    for (const row of counts.rows) {
      special.all += Number(row.unread);
      special.fresh += Number(row.fresh);
      special.starred += Number(row.starred);
      special.published += Number(row.published);
      if (row.subscription_id !== null) bySubscription.set(row.subscription_id, Number(row.unread));
    }

    // Each subscription's count is added to its category and every ancestor; 0 is uncategorised.
    const parents = new Map(cats.map((c) => [c.id, c.parentId]));
    const byCategory = new Map<number, number>([[0, 0], ...cats.map((c) => [c.id, 0] as const)]);
    for (const sub of subs) {
      const unread = bySubscription.get(sub.id) ?? 0;
      if (sub.categoryId === null) {
        byCategory.set(0, (byCategory.get(0) ?? 0) + unread);
        continue;
      }
      const seen = new Set<number>();
      for (let id: number | null | undefined = sub.categoryId; id != null && !seen.has(id);) {
        seen.add(id);
        byCategory.set(id, (byCategory.get(id) ?? 0) + unread);
        id = parents.get(id);
      }
    }

    return {
      subscriptions: subs.map((s) => ({ id: s.id, unread: bySubscription.get(s.id) ?? 0 })),
      categories: [...byCategory].map(([id, unread]) => ({ id, unread })),
      labels: labelCounts.rows.map((row) => ({ id: row.id, unread: Number(row.unread) })),
      special,
    };
  }
}
