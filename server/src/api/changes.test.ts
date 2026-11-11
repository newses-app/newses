import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpFetcher } from '../core/feeds/http.ts';
import { createDb } from '../db/client.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { RecordingRealtime } from '../test/fakes.ts';
import { createTestServices } from '../test/services.ts';
import { buildApp } from './app.ts';

let database: TestDatabase;
/** Realtime where no process holds streams open, as on AWS. */
class MarkerRealtime extends RecordingRealtime {
  changesPath(userId: number) {
    return `/changes/marker-${String(userId)}`;
  }
}
const realtime = new MarkerRealtime();

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

describe('change markers', () => {
  it('give their path with the session where the server streams no events', async () => {
    const services = createTestServices(createDb(database.pool), new HttpFetcher(), { realtime });
    const app = buildApp({
      logger: pino({ level: 'silent' }),
      healthChecks: {},
      services,
      events: false,
    });
    const user = await services.users.create('pat', 'pat password');
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: 'pat', password: 'pat password', tokenType: 'bearer' },
    });
    const path = realtime.changesPath(user.id);
    expect(login.json()).toMatchObject({ changesPath: path });
    const { token } = login.json<{ token: string }>();

    const session = await app.inject({
      url: '/api/v1/auth/session',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(session.json()).toMatchObject({ changesPath: path });

    await app.close();
  });

  it('are absent where the server streams events', async () => {
    const services = createTestServices(createDb(database.pool), new HttpFetcher());
    const app = buildApp({ logger: pino({ level: 'silent' }), healthChecks: {}, services });
    await services.users.create('sam', 'sam password');
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: 'sam', password: 'sam password', tokenType: 'bearer' },
    });
    expect(login.json()).not.toHaveProperty('changesPath');
    await app.close();
  });
});
