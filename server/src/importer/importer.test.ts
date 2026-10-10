import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db/client.ts';
import {
  entries,
  feedSources,
  importMap,
  labels,
  userEntries,
  users as usersTable,
} from '../db/schema.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { createTtrssSource } from '../test/ttrss-source.ts';
import { ImportError } from './errors.ts';
import { type ImportOptions, type ImportStep, importTtrss } from './importer.ts';
import { USERS } from './import-map.ts';
import { TtrssSource } from './source.ts';

/** The verified schema version, as the fixture dump has it. */
const VERSION = 151;
let target: TestDatabase;
let sourceDb: TestDatabase;
/** A database without TTRSS's tables. */
let otherDb: TestDatabase;
let db: Db;
let source: TtrssSource;

/** A synthetic step: creates a user per TTRSS user, or reuses the one imported before. */
const usersStep: ImportStep = {
  name: 'users',
  async run({ users, map, report, write }) {
    for (const user of users) {
      report.count(user.login, 'users', { source: 1 });
      await write(async (tx) => {
        let id = (await map.targets(USERS, [user.id])).get(user.id);
        if (id === undefined) {
          const [row] = await tx
            .insert(usersTable)
            .values({ login: user.login, passwordHash: 'imported' })
            .returning();
          id = row?.id ?? 0;
        }
        await map.record(tx, USERS, [{ sourceId: user.id, targetId: id, userId: id }]);
      });
      report.count(user.login, 'users', { imported: 1 });
    }
  },
};

const options = (changes: Partial<ImportOptions> = {}): ImportOptions => ({
  dryRun: false,
  force: false,
  ...changes,
});
const run = (changes: Partial<ImportOptions> = {}, steps: ImportStep[] = [usersStep]) =>
  importTtrss({ db, source, steps, purgeDays: 60 }, options(changes));
const imported = async () => (await db.select().from(usersTable)).map((u) => u.login).sort();

beforeAll(async () => {
  target = await createTestDatabase();
  db = createDb(target.pool);
  sourceDb = await createTtrssSource(VERSION);
  otherDb = await createTestDatabase({ migrate: false });
  await sourceDb.pool.query(
    "INSERT INTO ttrss_users (login, pwd_hash) VALUES ('admin', 'x'), ('pat', 'x')",
  );
});

beforeEach(async () => {
  await db.delete(usersTable);
  await db.delete(importMap);
  await db.delete(feedSources);
  source = await TtrssSource.open(sourceDb.url);
});

afterEach(async () => {
  await source.close();
});

afterAll(async () => {
  await sourceDb.drop();
  await otherDb.drop();
  await target.drop();
});

describe('TTRSS importer', () => {
  it('refuses sources it cannot reach', async () => {
    const url = new URL(sourceDb.url);
    url.pathname = '/missing';
    await expect(TtrssSource.open(url.href)).rejects.toThrow(
      /^Cannot connect to the source database: .*missing/,
    );
  });

  it('refuses databases that are not TTRSS or not a verified schema version', async () => {
    const notTtrss = await TtrssSource.open(otherDb.url);
    await expect(
      importTtrss({ db, source: notTtrss, steps: [], purgeDays: 60 }, options()),
    ).rejects.toThrow('not a TTRSS database');
    await notTtrss.close();
    await expect(
      importTtrss({ db, source, steps: [], purgeDays: 60, schemaVersions: [150] }, options()),
    ).rejects.toThrow(new ImportError('TTRSS schema version 151 is not supported (verified: 150)'));
  });

  it('refuses targets whose schema does not match this build', async () => {
    const [last] = (
      await db.execute<{ id: number; hash: string; created_at: string }>(
        sql`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 1`,
      )
    ).rows;
    await db.execute(sql`DELETE FROM drizzle.__drizzle_migrations WHERE id = ${last?.id}`);
    try {
      await expect(run()).rejects.toThrow(/schema does not match this build/);
      expect(await imported()).toEqual([]);
    } finally {
      await db.execute(
        sql`INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at)
          VALUES (${last?.id}, ${last?.hash}, ${last?.created_at})`,
      );
    }
    expect((await run()).reconciled).toBe(true);
  });

  it('imports, records each row, and re-runs onto the same rows', async () => {
    const report = await run();
    expect(await imported()).toEqual(['admin', 'pat']);
    expect(report.tally('pat', 'users')).toEqual({ source: 1, imported: 1 });
    expect(report.reconciled).toBe(true);
    const [pat] = await db.select().from(usersTable).where(eq(usersTable.login, 'pat'));
    const [mapped] = await db
      .select()
      .from(importMap)
      .where(eq(importMap.targetId, pat?.id ?? 0));
    expect(mapped).toMatchObject({ sourceTable: USERS, userId: pat?.id });
    expect(mapped?.completedAt).toBeInstanceOf(Date);

    await source.close();
    source = await TtrssSource.open(sourceDb.url);
    await run();
    expect(await imported()).toEqual(['admin', 'pat']);
  });

  it('imports only the named users', async () => {
    await run({ users: ['PAT'] });
    expect(await imported()).toEqual(['pat']);
    await expect(run({ users: ['pat', 'nobody'] })).rejects.toThrow('No TTRSS user: nobody');
  });

  it('writes nothing in a dry run, while later steps see earlier steps’ rows', async () => {
    const report = await run({ dryRun: true }, [usersStep, usersStep]);
    expect(await imported()).toEqual([]);
    expect(await db.select().from(importMap)).toEqual([]);
    expect(report.tally('pat', 'users')).toEqual({ source: 2, imported: 2 });
    expect(report.format()).toContain('dry run');
  });

  it('refuses users who used this instance since their import, unless forced', async () => {
    await run();
    const [pat] = await db.select().from(usersTable).where(eq(usersTable.login, 'pat'));
    const userId = pat?.id ?? 0;
    // Entries delivered by fetching are not use.
    const [feed] = await db
      .insert(feedSources)
      .values({ url: 'https://one.example/rss' })
      .returning();
    const [entry] = await db
      .insert(entries)
      .values({ feedSourceId: feed?.id ?? 0, guid: 'a', contentHash: 'a' })
      .returning();
    const [delivered] = await db
      .insert(userEntries)
      .values({ userId, entryId: entry?.id ?? 0, sortAt: new Date() })
      .returning();
    await run();

    await db
      .update(userEntries)
      .set({ unread: false })
      .where(eq(userEntries.id, delivered?.id ?? 0));
    await expect(run()).rejects.toThrow(/used this instance since their last import: pat\./);
    await run({ force: true });

    await db
      .insert(labels)
      .values({ userId, caption: 'New', fgColor: '#000000', bgColor: '#ffffff' });
    await expect(run()).rejects.toThrow('pat');
    await run({ users: ['admin'] });
  });

  it('lets a plain re-run follow runs that failed partway, but not later use', async () => {
    await run();
    const [pat] = await db.select().from(usersTable).where(eq(usersTable.login, 'pat'));
    const userId = pat?.id ?? 0;
    let n = 0;
    // Writes a label for pat, as a labels step would, then loses its connection.
    const failing: ImportStep = {
      name: 'failing',
      async run({ write }) {
        await write((tx) =>
          tx.insert(labels).values({
            userId,
            caption: `Imported ${String(++n)}`,
            fgColor: '#000000',
            bgColor: '#ffffff',
          }),
        );
        throw new Error('connection lost');
      },
    };
    await expect(run({}, [usersStep, failing])).rejects.toThrow('connection lost');
    await expect(run({}, [usersStep, failing])).rejects.toThrow('connection lost');
    expect((await run()).reconciled).toBe(true);

    // Use after a failed run still counts.
    await expect(run({}, [usersStep, failing])).rejects.toThrow('connection lost');
    await db
      .insert(labels)
      .values({ userId, caption: 'Mine', fgColor: '#000000', bgColor: '#ffffff' });
    await expect(run()).rejects.toThrow(/used this instance since their last import: pat\./);
    await run({ force: true });

    // A run cut short before recording its end cannot be told apart.
    await db
      .update(importMap)
      .set({ runStartedAt: new Date(Date.now() + 60_000), runEndedAt: null });
    await expect(run()).rejects.toThrow(/cut short.*: admin, pat\. Pass --force/);
    await run({ force: true });
    await run();
  });

  it('reads the source in one read-only snapshot, in batches', async () => {
    await sourceDb.pool.query("INSERT INTO ttrss_users (login, pwd_hash) VALUES ('late', 'x')");
    expect((await source.query('SELECT login FROM ttrss_users')).length).toBe(2);
    await expect(
      source.query("INSERT INTO ttrss_users (login, pwd_hash) VALUES ('x', 'x')"),
    ).rejects.toThrow('read-only transaction');
    await source.close();
    source = await TtrssSource.open(sourceDb.url);
    const batches: string[][] = [];
    for await (const rows of source.batches<{ id: number; login: string }>(
      (after, limit) =>
        `SELECT id, login FROM ttrss_users WHERE id > ${after} ORDER BY id LIMIT ${limit}`,
      [],
      2,
    ))
      batches.push(rows.map((r) => r.login));
    expect(batches).toEqual([['admin', 'pat'], ['late']]);
    await sourceDb.pool.query("DELETE FROM ttrss_users WHERE login = 'late'");
  });
});
