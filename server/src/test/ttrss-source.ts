import { readFileSync } from 'node:fs';
import { createTestDatabase, type TestDatabase } from './database.ts';

/** The TTRSS schema the importer is tested against. */
const SCHEMA = readFileSync(
  new URL('../importer/fixtures/ttrss-schema.sql', import.meta.url),
  'utf8',
);

/** A TTRSS source database: the fixture schema at `schemaVersion`, without rows. */
export async function createTtrssSource(schemaVersion: number): Promise<TestDatabase> {
  const database = await createTestDatabase({ migrate: false });
  // The dump clears search_path for its session, so it runs on a connection of its own.
  const client = await database.pool.connect();
  try {
    await client.query(SCHEMA);
  } finally {
    client.release(true);
  }
  await database.pool.query('INSERT INTO ttrss_version (schema_version) VALUES ($1)', [
    schemaVersion,
  ]);
  return database;
}
