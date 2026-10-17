import 'fake-indexeddb/auto';
import { API_VERSION } from '@newses/shared/client';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInBackground, takeWorkerReport } from './background.ts';
import { openOfflineDb, type OfflineDb } from './db.ts';
import { queueChanges } from './outbox.ts';
import { storedSyncToken } from './sync.ts';
import { writeWorkerConfig } from './worker-config.ts';

const NAME = 'newses-background';
let db: OfflineDb;

beforeEach(async () => {
  db = openOfflineDb(NAME);
  await writeWorkerConfig({ dbName: NAME, unread: 5000, limitBytes: 1e9 });
});

afterEach(async () => {
  db.close();
  await Dexie.delete(NAME);
  await writeWorkerConfig(null);
});

function server(routes: Record<string, (url: URL) => Response>) {
  const asked: string[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
      'https://r.example',
    );
    const route = `${init?.method ?? 'GET'} ${url.pathname.replace('/api/v1', '')}`;
    asked.push(route);
    const answer = routes[route];
    return Promise.resolve(answer ? answer(url) : new Response(null, { status: 204 }));
  };
  return { fetch, asked };
}

const common = {
  'GET /server': () => Response.json({ product: 'newses', version: 'x', apiVersion: API_VERSION }),
  'GET /auth/session': () =>
    Response.json({ user: { id: 1 }, csrfToken: 'c', iconsPath: '/feed-icons/x' }),
};

describe('runInBackground', () => {
  it('sends kept changes and keeps a report for the next page that opens', async () => {
    await queueChanges(db, [
      {
        kind: 'label.create',
        id: -1,
        body: { caption: 'A', fgColor: '#000000', bgColor: '#ffffff' },
      },
    ]);
    const { fetch, asked } = server({
      ...common,
      'POST /labels': () =>
        Response.json({ error: 'invalid_input', message: 'No' }, { status: 400 }),
    });
    await runInBackground('outbox', fetch);
    expect(asked).toEqual(['GET /server', 'GET /auth/session', 'POST /labels']);
    expect(await takeWorkerReport(db)).toMatchObject({
      refused: [{ kind: 'label.create', message: 'No' }],
      renumbered: true,
    });
    expect(await takeWorkerReport(db)).toBeNull();
  });

  it('follows changes and downloads text on a periodic sync, once the store has synced', async () => {
    const { fetch, asked } = server({
      ...common,
      'GET /sync': () =>
        Response.json({
          categories: [],
          subscriptions: [],
          labels: [],
          entries: [],
          deleted: { categories: [], subscriptions: [], labels: [], entries: [] },
          next: 'T2',
          more: false,
        }),
    });
    await runInBackground('sync', fetch);
    // Never synced: the app's first sync loads everything.
    expect(asked).not.toContain('GET /sync');
    await db.meta.put({ key: 'syncToken', value: 'T1' });
    await runInBackground('sync', fetch);
    expect(asked).toContain('GET /sync');
    expect(await storedSyncToken(db)).toBe('T2');
    expect((await db.meta.get('syncStatus'))?.value).toMatchObject({ lastError: null });
  });

  it('does nothing while offline reading is off', async () => {
    await writeWorkerConfig(null);
    const { fetch, asked } = server(common);
    await runInBackground('sync', fetch);
    expect(asked).toEqual([]);
  });
});
