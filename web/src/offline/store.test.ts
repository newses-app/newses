import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lastAccount, markFilled } from './account.ts';
import { queueChanges } from './outbox.ts';
import { currentStore, storeSessionEnded, storeSignedIn } from './store.ts';

/** The browser, with offline reading on and a store filled for user 1. */
async function filled(pending: number) {
  await storeSignedIn({ userId: 1, serverUrl: null });
  const db = currentStore();
  if (!db) throw new Error('No store');
  await db.meta.put({ key: 'syncToken', value: 'T1' });
  await db.contents.put({ id: 1, contentVersion: 'v', bytes: 1 } as never);
  markFilled();
  for (let i = 0; i < pending; i++) await queueChanges(db, [{ kind: 'note', id: 1, note: 'Kept' }]);
  return db.name;
}

beforeEach(() => {
  localStorage.setItem('newses.offline.enabled', 'true');
});

afterEach(async () => {
  localStorage.clear();
  for (const name of await Dexie.getDatabaseNames()) await Dexie.delete(name);
});

describe('storeSessionEnded', () => {
  it('keeps only the changes not yet sent, for the next sign-in to send', async () => {
    const name = await filled(1);
    await storeSessionEnded();
    const db = currentStore();
    expect(db?.name).toBe(name);
    expect(await db?.meta.count()).toBe(0);
    expect(await db?.contents.count()).toBe(0);
    expect(await db?.outbox.count()).toBe(1);
    // Emptied on purpose: the next sync does not report an eviction.
    expect(lastAccount()).toMatchObject({ userId: 1, filled: false });
  });

  it('deletes the store when nothing waits to be sent', async () => {
    const name = await filled(0);
    await storeSessionEnded();
    expect(await Dexie.getDatabaseNames()).not.toContain(name);
    expect(lastAccount()).toBeNull();
  });
});
