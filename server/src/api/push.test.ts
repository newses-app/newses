import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpFetcher } from '../core/feeds/http.ts';
import { createDb, type Db } from '../db/client.ts';
import { pushSubscriptions } from '../db/schema.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { createTestServices } from '../test/services.ts';
import { type ApiServices, buildApp } from './app.ts';

let database: TestDatabase;
let db: Db;
let app: ReturnType<typeof buildApp>;
let services: ApiServices;
let pat = 0;

const subscription = {
  endpoint: 'https://push.example/send/abc',
  keys: {
    p256dh:
      'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  },
};

async function bearer(): Promise<{ authorization: string; sessionId: number }> {
  const { token, session } = await services.sessions.create(pat, 'bearer', null);
  return { authorization: `Bearer ${token}`, sessionId: session.id };
}

const call = (method: 'PUT' | 'DELETE', authorization: string, payload?: object) =>
  app.inject({
    method,
    url: '/api/v1/push/subscription',
    headers: { authorization },
    ...(payload && { payload }),
  });

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
  services = createTestServices(db, new HttpFetcher());
  pat = (await services.users.create('pat', 'pat password')).id;
  app = buildApp({ logger: pino({ level: 'silent' }), healthChecks: {}, services });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe('push API', () => {
  it("binds a device's subscription to the session until it is removed or the session ends", async () => {
    const { authorization, sessionId } = await bearer();
    expect((await call('PUT', authorization, subscription)).statusCode).toBe(204);
    expect(await db.select().from(pushSubscriptions)).toEqual([
      expect.objectContaining({ userId: pat, sessionId, endpoint: subscription.endpoint }),
    ]);

    expect((await call('DELETE', authorization)).statusCode).toBe(204);
    expect(await db.select().from(pushSubscriptions)).toEqual([]);

    await call('PUT', authorization, subscription);
    await services.sessions.revoke(pat, sessionId);
    expect(await db.select().from(pushSubscriptions)).toEqual([]);
  });

  it('takes only https endpoints and well-formed keys', async () => {
    const { authorization } = await bearer();
    const refused = [
      { ...subscription, endpoint: 'http://push.example/send/abc' },
      { ...subscription, endpoint: `https://push.example/${'x'.repeat(2048)}` },
      { ...subscription, keys: { ...subscription.keys, p256dh: 'short' } },
      { ...subscription, keys: { ...subscription.keys, auth: 'not base64url!!!!!!!!!' } },
    ];
    for (const body of refused)
      expect((await call('PUT', authorization, body)).statusCode).toBe(400);
    expect(await db.select().from(pushSubscriptions)).toEqual([]);
  });

  it('needs a session', async () => {
    expect((await call('PUT', 'Bearer nope', subscription)).statusCode).toBe(401);
  });
});
