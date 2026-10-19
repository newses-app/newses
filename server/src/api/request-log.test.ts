import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { createDb } from '../db/client.ts';
import { HttpFetcher } from '../core/feeds/http.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { createTestServices } from '../test/services.ts';
import { buildApp } from './app.ts';

const KEY = 'published-feed-key-1234';
const SHARE = '6f1c2b0e-4a5d-4e3f-9b8a-7c6d5e4f3a2b';
const SIGNATURE = 'c2lnbmF0dXJlLW9mLXRoZS1pbWFnZQ';
const IMAGE = Buffer.from('https://images.example/photo.jpg').toString('base64url');
const PAGE = 'https%3A%2F%2Fpages.example%2Farticle';
const PASSWORD = 'query-string-password';

let database: TestDatabase;
const logs: string[] = [];
const apps: FastifyInstance[] = [];

async function appAt(level: 'info' | 'debug') {
  const logger = pino({ level }, { write: (line: string) => logs.push(line) });
  const services = createTestServices(createDb(database.pool), new HttpFetcher());
  const app = buildApp({ logger, healthChecks: {}, services });
  await app.ready();
  apps.push(app);
  return app;
}

async function requestSecrets(app: FastifyInstance) {
  for (const url of [
    `/public/feeds/${KEY}`,
    `/public.php?op=rss&id=-2&key=${KEY}`,
    `/public/share/${SHARE}`,
    `/api/v1/images/${SIGNATURE}/${IMAGE}`,
    `/publish?url=${PAGE}`,
  ])
    await app.inject({ method: 'GET', url });
  await app.inject({ method: 'POST', url: `/accounts/ClientLogin?Email=ivy&Passwd=${PASSWORD}` });
}

beforeAll(async () => {
  database = await createTestDatabase();
});

beforeEach(() => {
  logs.length = 0;
});

afterAll(async () => {
  await Promise.all(apps.map((app) => app.close()));
  await database.drop();
});

describe('request logs', () => {
  it('show only route patterns below debug', async () => {
    await requestSecrets(await appAt('info'));
    const text = logs.join('\n');
    for (const secret of [KEY, SHARE, SIGNATURE, IMAGE, 'pages.example', 'images.example'])
      expect(text).not.toContain(secret);
    expect(text).toContain('"url":"/public/feeds/:key"');
    expect(text).toContain('"url":"/api/v1/images/:signature/:url"');
    expect(text).toContain('"url":"unmatched"');
  });

  it('show URLs at debug, with keys and share ids redacted', async () => {
    await requestSecrets(await appAt('debug'));
    const text = logs.join('\n');
    for (const secret of [KEY, SHARE, SIGNATURE, PASSWORD]) expect(text).not.toContain(secret);
    expect(text).toContain('"url":"/accounts/ClientLogin?Email=ivy&Passwd=[redacted]"');
    expect(text).toContain('"url":"/public/feeds/[redacted]"');
    expect(text).toContain('"url":"/public.php?op=rss&id=-2&key=[redacted]"');
    expect(text).toContain('"url":"/public/share/[redacted]"');
    expect(text).toContain(`"url":"/api/v1/images/[redacted]/${IMAGE}"`);
    expect(text).toContain(`"url":"/publish?url=${PAGE}"`);
  });
});
