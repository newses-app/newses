import { and, eq, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { accessKeys, pluginDeliveries, pluginSettings } from '../../db/schema.ts';
import type { Logger } from '../ports.ts';
import {
  EVENT_HOOKS,
  type EventHookName,
  type PluginCatalog,
  type PluginEventRunner,
} from './catalog.ts';
import { readPluginEntries } from './entries.ts';

/** Changes one delivery carries at most; a larger window is split. */
export const MAX_DELIVERY_EVENTS = 500;
/** Attempts of a delivery before it is dropped. */
export const MAX_DELIVERY_ATTEMPTS = 6;
/** How long a claimed delivery stays claimed: beyond the hook's limit. */
const LEASE_SECONDS = 180;

/** Seconds before the next attempt of a delivery that failed `attempts` times: 1 min to 6 h. */
export const retryDelaySeconds = (attempts: number) =>
  Math.min(60 * 4 ** Math.max(attempts - 1, 0), 6 * 60 * 60);

/** Records `entries.added` for the plugins listening, in the fan-out's transaction. */
export async function recordEntriesAdded(
  executor: Pick<Db, 'execute'>,
  delivered: readonly { id: number; userId: number }[],
): Promise<void> {
  if (delivered.length === 0) return;
  await executor.execute(sql`
    INSERT INTO plugin_events (plugin_id, user_id, hook, user_entry_id)
    SELECT l.plugin_id, d.user_id, 'entries.added', d.id
    FROM unnest(
      ${sql.param(delivered.map((d) => d.id))}::bigint[],
      ${sql.param(delivered.map((d) => d.userId))}::int[]
    ) AS d(id, user_id)
    CROSS JOIN LATERAL plugin_listeners('entries.added', d.user_id) AS l(plugin_id)
    WHERE plugin_hook_listened('entries.added')`);
}

/**
 * Plugins' event hooks: the changes the fan-out and triggers recorded become deliveries once each
 * hook's debounce window has passed, and deliveries run, at least once, with retries.
 */
export class PluginEventService {
  readonly #db: Db;
  readonly #catalog: PluginCatalog;
  readonly #runner: PluginEventRunner | null;
  readonly #logger: Logger;
  readonly #publicUrl: string | null;

  constructor(deps: {
    db: Db;
    catalog: PluginCatalog;
    /** Runs hooks; null where this process only records and wakes. */
    runner: PluginEventRunner | null;
    logger: Logger;
    /** Origin of published feed URLs; null leaves them out. */
    publicUrl: string | null;
  }) {
    this.#db = deps.db;
    this.#catalog = deps.catalog;
    this.#runner = deps.runner;
    this.#logger = deps.logger;
    this.#publicUrl = deps.publicUrl?.replace(/\/+$/, '') ?? null;
  }

  /** Whether an installed plugin implements an event hook. */
  get listening(): boolean {
    return this.#catalog.list().some((plugin) => plugin.events.size > 0);
  }

  /**
   * Tells the triggers which event hooks the installed plugins implement and which have user
   * scope; plugins no longer installed listen to none. Run at startup.
   */
  async syncInstalled(): Promise<void> {
    const installed = this.#catalog.list();
    await this.#db.transaction(async (tx) => {
      for (const plugin of installed)
        await tx
          .update(pluginSettings)
          .set({ hooks: [...plugin.events.keys()], userScope: plugin.scopes.includes('user') })
          .where(eq(pluginSettings.pluginId, plugin.id));
      await tx
        .update(pluginSettings)
        .set({ hooks: [] })
        .where(
          installed.length > 0
            ? sql`${pluginSettings.pluginId} <> ALL(${sql.param(installed.map((p) => p.id))}::text[])`
            : sql`true`,
        );
    });
  }

  /**
   * Groups the events whose window has passed into deliveries, then runs due deliveries until
   * `deadline` (epoch ms). Returns how many deliveries ran.
   */
  async dispatch(deadline = Date.now() + 60_000): Promise<number> {
    if (!this.#runner) throw new Error('This process runs no plugin hooks');
    await this.#group();
    let ran = 0;
    while (Date.now() < deadline) {
      const delivery = await this.#claim();
      if (!delivery) break;
      await this.#deliver(delivery);
      ran++;
    }
    return ran;
  }

  /** Seconds until something is next due (0 when something is due now); null when nothing waits. */
  async nextDueSeconds(): Promise<number | null> {
    const groups = await this.#db.execute<{ plugin_id: string; hook: string; first: string }>(sql`
      SELECT plugin_id, hook, min(created_at)::text AS first FROM plugin_events
      GROUP BY plugin_id, hook`);
    const [delivery] = await this.#db
      .execute<{ due: string | null }>(
        sql`
      SELECT min(greatest(due_at, coalesce(leased_until, due_at)))::text AS due
      FROM plugin_deliveries`,
      )
      .then((r) => r.rows);
    const times = groups.rows.map(
      (g) => Date.parse(g.first) + this.#window(g.plugin_id, g.hook) * 1000,
    );
    if (delivery?.due) times.push(Date.parse(delivery.due));
    if (times.length === 0) return null;
    return Math.max(0, Math.ceil((Math.min(...times) - Date.now()) / 1000));
  }

  /** The hook's debounce window; events of plugins no longer listening are due at once. */
  #window(pluginId: string, hook: string): number {
    return this.#catalog.get(pluginId)?.events.get(hook as EventHookName)?.debounceSeconds ?? 0;
  }

  /** Moves events whose window has passed into deliveries, a plugin, user, and hook at a time. */
  async #group(): Promise<void> {
    const groups = await this.#db.execute<{
      plugin_id: string;
      user_id: number;
      hook: string;
      first: string;
    }>(sql`
      SELECT plugin_id, user_id, hook, min(created_at)::text AS first FROM plugin_events
      GROUP BY plugin_id, user_id, hook`);
    for (const group of groups.rows) {
      const due = Date.parse(group.first) + this.#window(group.plugin_id, group.hook) * 1000;
      if (due > Date.now()) continue;
      await this.#db.transaction(async (tx) => {
        for (;;) {
          const claimed = await tx.execute<{ user_entry_id: string; published: boolean | null }>(
            sql`
            DELETE FROM plugin_events WHERE id IN (
              SELECT id FROM plugin_events
              WHERE plugin_id = ${group.plugin_id} AND user_id = ${group.user_id}
                AND hook = ${group.hook}
              ORDER BY id LIMIT ${MAX_DELIVERY_EVENTS}
              FOR UPDATE SKIP LOCKED)
            RETURNING id, user_entry_id, published`,
          );
          if (claimed.rows.length === 0) break;
          // The last change of an entry is its state.
          const byEntry = new Map<number, { id: number; published?: boolean }>();
          for (const row of claimed.rows) {
            const id = Number(row.user_entry_id);
            byEntry.delete(id);
            byEntry.set(id, row.published === null ? { id } : { id, published: row.published });
          }
          await tx.insert(pluginDeliveries).values({
            pluginId: group.plugin_id,
            userId: group.user_id,
            hook: group.hook,
            events: [...byEntry.values()],
          });
          if (claimed.rows.length < MAX_DELIVERY_EVENTS) break;
        }
      });
    }
  }

  /** A due delivery nobody holds, now held for the lease. */
  async #claim() {
    const [delivery] = await this.#db.transaction(async (tx) => {
      const [due] = await tx
        .select({ id: pluginDeliveries.id })
        .from(pluginDeliveries)
        .where(
          and(
            lte(pluginDeliveries.dueAt, sql`now()`),
            or(isNull(pluginDeliveries.leasedUntil), lt(pluginDeliveries.leasedUntil, sql`now()`)),
          ),
        )
        .orderBy(pluginDeliveries.dueAt)
        .limit(1)
        .for('update', { skipLocked: true });
      if (!due) return [];
      return tx
        .update(pluginDeliveries)
        .set({
          leasedUntil: sql`now() + make_interval(secs => ${LEASE_SECONDS})`,
          attempts: sql`${pluginDeliveries.attempts} + 1`,
        })
        .where(eq(pluginDeliveries.id, due.id))
        .returning();
    });
    return delivery;
  }

  async #deliver(delivery: typeof pluginDeliveries.$inferSelect): Promise<void> {
    const plugin = this.#catalog.get(delivery.pluginId);
    const hook = EVENT_HOOKS.find((h) => h === delivery.hook);
    const done = () =>
      this.#db.delete(pluginDeliveries).where(eq(pluginDeliveries.id, delivery.id));
    // A plugin no longer installed, or no longer implementing the hook, is not told.
    if (!plugin || !hook || !plugin.events.has(hook) || !this.#runner) {
      await done();
      return;
    }
    let outcome: Awaited<ReturnType<PluginEventRunner['run']>>;
    try {
      const event = await this.#event(hook, delivery.userId, delivery.events);
      outcome = event ? await this.#runner.run(plugin, hook, delivery.userId, event) : 'ok';
    } catch (err) {
      this.#logger.error({ err, plugin: plugin.id, hook }, 'Plugin delivery not prepared');
      outcome = 'failed';
    }
    if (outcome !== 'failed') {
      await done();
      return;
    }
    if (delivery.attempts >= MAX_DELIVERY_ATTEMPTS) {
      this.#logger.warn(
        { plugin: plugin.id, hook, userId: delivery.userId, attempts: delivery.attempts },
        'Plugin delivery dropped after repeated failures',
      );
      await done();
      return;
    }
    await this.#db
      .update(pluginDeliveries)
      .set({
        leasedUntil: null,
        dueAt: sql`now() + make_interval(secs => ${retryDelaySeconds(delivery.attempts)})`,
      })
      .where(eq(pluginDeliveries.id, delivery.id));
  }

  /** The event a delivery carries, read as the user sees the entries now; null when it is empty. */
  async #event(
    hook: EventHookName,
    userId: number,
    events: { id: number; published?: boolean }[],
  ): Promise<object | null> {
    const withText = hook === 'entries.added';
    const read = await readPluginEntries(
      this.#db,
      userId,
      events.map((e) => e.id),
      { text: withText },
    );
    if (withText) {
      if (read.length === 0) return null;
      return {
        userId,
        entries: read.map(({ entry, text, contentHash }) => ({
          ...entry,
          text: text ?? '',
          contentHash,
        })),
      };
    }
    const rows = read.map(({ entry }) => entry);
    const present = new Map(rows.map((row) => [row.id, row]));
    const published = rows.filter((row) => row.published);
    const unpublished = events.map((e) => e.id).filter((id) => present.get(id)?.published !== true);
    if (published.length === 0 && unpublished.length === 0) return null;
    return { userId, feedUrl: await this.#feedUrl(userId), published, unpublished };
  }

  /** The published feed's address, when the user has one and the server a public URL. */
  async #feedUrl(userId: number): Promise<string | null> {
    if (!this.#publicUrl) return null;
    const [row] = await this.#db
      .select({ key: accessKeys.key })
      .from(accessKeys)
      .where(and(eq(accessKeys.userId, userId), eq(accessKeys.purpose, 'published')));
    return row ? `${this.#publicUrl}/public/feeds/${encodeURIComponent(row.key)}` : null;
  }
}
