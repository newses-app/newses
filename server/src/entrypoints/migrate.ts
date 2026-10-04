import pg from 'pg';
import { runMigrations } from '../db/migrate.ts';

const connectionString = process.env['DATABASE_URL'];
if (!connectionString) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString, max: 1 });
try {
  await runMigrations(pool);
  console.log('Migrations applied');
} finally {
  await pool.end();
}
