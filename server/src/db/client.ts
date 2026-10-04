import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import * as schema from './schema.ts';

export function createDb(pool: pg.Pool) {
  return drizzle({ client: pool, schema });
}

export type Db = ReturnType<typeof createDb>;
