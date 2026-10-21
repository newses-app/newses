import pg from 'pg';
import pino from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../db/client.ts';
import { FakeFetcher } from '../test/fake-fetcher.ts';
import { createTestServices } from '../test/services.ts';
import { buildApp } from './app.ts';
import { openApiDocument } from './openapi.ts';

// Serving the document reads nothing, so the pool never connects.
const pool = new pg.Pool();
const app = buildApp({
  logger: pino({ level: 'silent' }),
  healthChecks: {},
  services: createTestServices(createDb(pool), new FakeFetcher()),
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('openApiDocument', () => {
  it('is the document a server serves, with or without event streams', async () => {
    const served = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(served.statusCode).toBe(200);
    expect(await openApiDocument()).toEqual(served.json());
  });
});
