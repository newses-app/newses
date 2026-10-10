import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { schemaMatches } from '../db/migrate.ts';
import { ImportError } from './errors.ts';
import { ImportMap, type Writer } from './import-map.ts';
import { ImportReport } from './report.ts';
import type { TtrssSource } from './source.ts';

/** TTRSS schema versions the importer has been verified against (`ttrss_version`). */
export const VERIFIED_SCHEMA_VERSIONS: readonly number[] = [151];

export interface ImportOptions {
  /** TTRSS logins to import; all users when omitted. */
  users?: string[] | undefined;
  /** Entries older than this are skipped unless starred, published, labelled, or noted. */
  since?: Date | undefined;
  /** Read and map everything, then roll back every write. */
  dryRun: boolean;
  /** Import into users who have used this instance since their last import. */
  force: boolean;
}

export interface SourceUser {
  id: number;
  login: string;
}

export interface ImportContext {
  source: TtrssSource;
  map: ImportMap;
  report: ImportReport;
  options: ImportOptions;
  /** The TTRSS users being imported. */
  users: SourceUser[];
  /** Reads the target; within a dry run it sees what the run has written so far. */
  db: Writer;
  /** The instance's default purge age in days; 0 never purges. */
  purgeDays: number;
  /** Runs one batch of writes in its own transaction (a savepoint within a dry run). */
  write: <T>(work: (tx: Writer) => Promise<T>) => Promise<T>;
}

/** One part of the import, such as users or feeds; steps run in order. */
export interface ImportStep {
  name: string;
  run(context: ImportContext): Promise<void>;
}

export interface ImportDeps {
  db: Db;
  source: TtrssSource;
  steps: readonly ImportStep[];
  /** The instance's default purge age in days (`FEED_PURGE_DAYS`); 0 never purges. */
  purgeDays: number;
  /** Defaults to `VERIFIED_SCHEMA_VERSIONS`. */
  schemaVersions?: readonly number[];
}

class DryRunRollback extends Error {}

/**
 * Imports TTRSS users' data (ADR 0013). Re-runs update rows recorded in `import_map`, source
 * state winning; users who have used this instance since their last import are refused unless
 * forced, so a re-import cannot overwrite their changes.
 */
export async function importTtrss(deps: ImportDeps, options: ImportOptions): Promise<ImportReport> {
  const { db, source, steps } = deps;
  if (!(await schemaMatches(db)))
    throw new ImportError(
      "The target database's schema does not match this build; deploy or check out the matching version",
    );
  const versions = deps.schemaVersions ?? VERIFIED_SCHEMA_VERSIONS;
  const version = await source.schemaVersion();
  if (version === null) throw new ImportError('The source is not a TTRSS database');
  if (!versions.includes(version))
    throw new ImportError(
      `TTRSS schema version ${String(version)} is not supported (verified: ${versions.join(', ') || 'none'})`,
    );

  const users = await selectUsers(source, options.users);
  const map = new ImportMap(db);
  if (!options.force) {
    const active = await activeUsers(db, map, users);
    if (active.length > 0)
      throw new ImportError(
        `These users have used this instance since their last import: ${active.join(', ')}. ` +
          'Re-importing would overwrite their changes; pass --force to do it anyway.',
      );
  }

  const report = new ImportReport(options.dryRun);
  const runSteps = async (base: Writer & Pick<Db, 'transaction'>) => {
    const context: ImportContext = {
      source,
      // Within a dry run, the map reads what the run has written so far.
      map: new ImportMap(base),
      report,
      options,
      users,
      db: base,
      purgeDays: deps.purgeDays,
      write: (work) => base.transaction((tx) => work(tx)),
    };
    for (const step of steps) await step.run(context);
  };
  if (options.dryRun) {
    try {
      await db.transaction(async (tx) => {
        await runSteps(tx);
        throw new DryRunRollback();
      });
    } catch (err) {
      if (!(err instanceof DryRunRollback)) throw err;
    }
    return report;
  }
  await runSteps(db);
  await map.complete(users.map((u) => u.id));
  return report;
}

async function selectUsers(source: TtrssSource, logins: string[] | undefined) {
  const all = await source.query<SourceUser>('SELECT id, login FROM ttrss_users ORDER BY id');
  if (!logins) return all;
  const wanted = new Set(logins.map((login) => login.toLowerCase()));
  const users = all.filter((u) => wanted.has(u.login.toLowerCase()));
  const found = new Set(users.map((u) => u.login.toLowerCase()));
  const missing = [...wanted].filter((login) => !found.has(login));
  if (missing.length > 0) throw new ImportError(`No TTRSS user: ${missing.join(', ')}`);
  return users;
}

/** Logins of imported users with changes here since their last import finished. */
async function activeUsers(db: Db, map: ImportMap, users: SourceUser[]): Promise<string[]> {
  const imported = await map.users(users.map((u) => u.id));
  const active: string[] = [];
  for (const { sourceId, userId, completedAt } of imported) {
    if (!completedAt) continue;
    if (await usedSince(db, userId, completedAt))
      active.push(users.find((u) => u.id === sourceId)?.login ?? String(sourceId));
  }
  return active;
}

/**
 * Whether the user changed anything since `since`: entry state (entries delivered by fetching
 * since then do not count), subscriptions, categories, or labels, including deletions.
 */
async function usedSince(db: Db, userId: number, since: Date): Promise<boolean> {
  const at = since.toISOString();
  const result = await db.execute<{ used: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM user_entries WHERE user_id = ${userId}
        AND updated_at > ${at}::timestamptz AND updated_at > created_at)
      OR EXISTS (SELECT 1 FROM subscriptions WHERE user_id = ${userId} AND updated_at > ${at}::timestamptz)
      OR EXISTS (SELECT 1 FROM categories WHERE user_id = ${userId} AND updated_at > ${at}::timestamptz)
      OR EXISTS (SELECT 1 FROM labels WHERE user_id = ${userId} AND updated_at > ${at}::timestamptz)
      OR EXISTS (SELECT 1 FROM tombstones WHERE user_id = ${userId} AND deleted_at > ${at}::timestamptz
        AND entity IN ('subscription', 'category', 'label')) AS used`);
  return result.rows[0]?.used ?? false;
}
