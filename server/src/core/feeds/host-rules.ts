import { asc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { fetchHostRules } from '../../db/schema.ts';
import { DomainError } from '../errors.ts';
import type { FeedUpdater } from './updater.ts';

export type HostRuleRow = typeof fetchHostRules.$inferSelect;

/** A host and optional port, as `new URL(url).host` gives it (`Example.com:443` → `example.com`). */
export function normaliseHost(input: string): string {
  const trimmed = input.trim().toLowerCase();
  if (!/^[a-z0-9.[\]:-]+$/.test(trimmed))
    throw new DomainError('invalid_input', `Not a host: ${input}`);
  try {
    return new URL(`https://${trimmed}`).host;
  } catch {
    throw new DomainError('invalid_input', `Not a host: ${input}`);
  }
}

/** Admins' minimum intervals between feed checks of a host. */
export class HostRuleService {
  readonly #db: Db;
  readonly #updater: FeedUpdater;

  constructor(db: Db, updater: FeedUpdater) {
    this.#db = db;
    this.#updater = updater;
  }

  list(): Promise<HostRuleRow[]> {
    return this.#db.select().from(fetchHostRules).orderBy(asc(fetchHostRules.host));
  }

  /** Sets the host's minimum and reschedules its feeds. */
  async set(rawHost: string, minIntervalSeconds: number, actorId: number): Promise<HostRuleRow> {
    const host = normaliseHost(rawHost);
    const [row] = await this.#db
      .insert(fetchHostRules)
      .values({ host, minIntervalSeconds, updatedBy: actorId })
      .onConflictDoUpdate({
        target: fetchHostRules.host,
        set: { minIntervalSeconds, updatedBy: actorId },
      })
      .returning();
    if (!row) throw new Error('Host rule upsert returned no row');
    await this.#updater.rescheduleHost(host);
    return row;
  }

  /** Removes the host's minimum and reschedules its feeds; returns the normalised host. */
  async clear(rawHost: string): Promise<string> {
    const host = normaliseHost(rawHost);
    const deleted = await this.#db
      .delete(fetchHostRules)
      .where(eq(fetchHostRules.host, host))
      .returning({ host: fetchHostRules.host });
    if (deleted.length === 0) throw new DomainError('not_found', 'No minimum for this host');
    await this.#updater.rescheduleHost(host);
    return host;
  }
}
