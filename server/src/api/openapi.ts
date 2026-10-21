import pg from 'pg';
import pino from 'pino';
import { createDb } from '../db/client.ts';
import { FakeFetcher } from '../test/fake-fetcher.ts';
import { createTestServices } from '../test/services.ts';
import { buildApp } from './app.ts';

/**
 * The document `/api/v1/openapi.json` serves, built without a database for the release pipeline.
 * Only route registration runs, so the services' unconnected pool and fake adapters are never
 * called.
 */
export async function openApiDocument() {
  const pool = new pg.Pool();
  const app = buildApp({
    logger: pino({ level: 'silent' }),
    healthChecks: {},
    services: createTestServices(createDb(pool), new FakeFetcher()),
    events: false,
    tracing: false,
  });
  try {
    await app.ready();
    return app.swagger();
  } finally {
    await app.close();
    await pool.end();
  }
}
