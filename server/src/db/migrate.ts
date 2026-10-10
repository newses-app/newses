import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';
import type { Db } from './client.ts';

// Arbitrary constant shared by every instance; serialises concurrent migration runs.
const MIGRATION_LOCK_KEY = 7310001;

export const migrationsFolder = fileURLToPath(new URL('./migrations', import.meta.url));

export async function runMigrations(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await migrate(drizzle({ client }), { migrationsFolder });
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

/** Whether the database has exactly this build's migrations applied. */
export async function schemaMatches(db: Pick<Db, 'execute'>): Promise<boolean> {
  const expected = readMigrationFiles({ migrationsFolder }).map((m) => m.hash);
  const table = await db.execute<{ name: string | null }>(
    sql`SELECT to_regclass('drizzle.__drizzle_migrations')::text AS name`,
  );
  if (!table.rows[0]?.name) return expected.length === 0;
  const result = await db.execute<{ hash: string }>(
    sql`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id`,
  );
  const applied = result.rows.map((row) => row.hash);
  return applied.length === expected.length && applied.every((hash, i) => hash === expected[i]);
}
