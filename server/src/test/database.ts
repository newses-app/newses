import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import pg from 'pg';
import { inject } from 'vitest';
import { runMigrations } from '../db/migrate.ts';

export interface TestDatabase {
  url: string;
  pool: pg.Pool;
  drop(): Promise<void>;
}

/** Creates an isolated database on the shared test container, migrated unless `migrate` is false. */
export async function createTestDatabase({ migrate = true } = {}): Promise<TestDatabase> {
  const adminUrl = inject('postgresUrl');
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.href });
  if (migrate) await runMigrations(pool);

  return {
    url: url.href,
    pool,
    async drop() {
      await pool.end();
      const client = new pg.Client({ connectionString: adminUrl });
      await client.connect();
      // pool.end() resolves before its connections finish closing; forcing the drop while they
      // close fails them with errors nobody listens for. Leaks still get forced after 5 s.
      for (let waited = 0; waited < 5000; waited += 50) {
        const { rows } = await client.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1',
          [name],
        );
        if (rows[0]?.n === 0) break;
        await setTimeout(50);
      }
      await client.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await client.end();
    },
  };
}
