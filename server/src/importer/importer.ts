import { type SQL, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { schemaMatches } from '../db/migrate.ts';
import { ImportError } from './errors.ts';
import { ImportMap, USERS, type Writer } from './import-map.ts';
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
    const { used, interrupted } = await activeUsers(db, map, users);
    if (used.length > 0)
      throw new ImportError(
        `These users have used this instance since their last import: ${used.join(', ')}. ` +
          'Re-importing would overwrite their changes; pass --force to do it anyway.',
      );
    if (interrupted.length > 0)
      throw new ImportError(
        `The last import of these users was cut short, so its changes cannot be told from ` +
          `theirs: ${interrupted.join(', ')}. Pass --force to re-import anyway.`,
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
  const ids = users.map((u) => u.id);
  await map.start(ids);
  try {
    await runSteps(db);
    await map.complete(ids);
  } finally {
    // Recorded when a run fails too, so the next run can tell its changes from the users'.
    await map.end(ids).catch(() => undefined);
  }
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

/**
 * Logins of imported users with changes here since their last import finished (`used`), and of
 * those whose last run was cut short before recording its end (`interrupted`). Changes made
 * while runs that did not finish were going are the importer's own and do not count.
 */
async function activeUsers(
  db: Db,
  map: ImportMap,
  users: SourceUser[],
): Promise<{ used: string[]; interrupted: string[] }> {
  const imported = await map.users(users.map((u) => u.id));
  const used: string[] = [];
  const interrupted: string[] = [];
  for (const { sourceId, userId, completedAt } of imported) {
    if (!completedAt) continue;
    const login = users.find((u) => u.id === sourceId)?.login ?? String(sourceId);
    const state = await usedSince(db, userId, sourceId);
    if (state.interrupted) interrupted.push(login);
    else if (state.used) used.push(login);
  }
  return { used, interrupted };
}

/**
 * Whether the user changed anything since their last import finished, outside the window of runs
 * that did not finish since: entry state (entries delivered by fetching do not count),
 * subscriptions, categories, or labels, including deletions. Times are compared in the database,
 * at full precision.
 */
async function usedSince(
  db: Db,
  userId: number,
  sourceId: number,
): Promise<{ used: boolean; interrupted: boolean }> {
  const changed = (table: SQL, column: SQL, extra: SQL = sql``) => sql`
    EXISTS (SELECT 1 FROM ${table} t WHERE t.user_id = ${userId} AND t.${column} > m.since
      AND NOT coalesce(t.${column} BETWEEN m.run_from AND m.run_to, false) ${extra})`;
  const result = await db.execute<{ used: boolean; interrupted: boolean }>(sql`
    WITH m AS (
      SELECT completed_at AS since, run_ended_at AS run_to,
        CASE WHEN run_started_at > completed_at THEN run_started_at END AS run_from
      FROM import_map WHERE source_table = ${USERS} AND source_id = ${sourceId})
    SELECT m.run_from IS NOT NULL AND m.run_to IS NULL AS interrupted,
      ${changed(sql`user_entries`, sql`updated_at`, sql`AND t.updated_at > t.created_at`)}
      OR ${changed(sql`subscriptions`, sql`updated_at`)}
      OR ${changed(sql`categories`, sql`updated_at`)}
      OR ${changed(sql`labels`, sql`updated_at`)}
      OR ${changed(sql`tombstones`, sql`deleted_at`, sql`AND t.entity IN ('subscription', 'category', 'label')`)}
        AS used
    FROM m`);
  return result.rows[0] ?? { used: false, interrupted: false };
}
