import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type Db } from '../../db/client.ts';
import {
  accessKeys,
  entries,
  feedSources,
  pluginDeliveries,
  pluginEvents,
  pluginSettings,
  pluginUserSettings,
  subscriptions,
  userEntries,
  users,
} from '../../db/schema.ts';
import { createTestDatabase, type TestDatabase } from '../../test/database.ts';
import { RecordingRealtime, silentLogger } from '../../test/fakes.ts';
import { createEntryServices } from '../entries/index.ts';
import type { EventHookName, EventRunOutcome, PluginCatalog, PluginInfo } from './catalog.ts';
import {
  MAX_DELIVERY_ATTEMPTS,
  PluginEventService,
  recordEntriesAdded,
  retryDelaySeconds,
} from './events.ts';
import { PluginWaker, wakingRealtime } from './waker.ts';

const plugin = (
  id: string,
  events: Partial<Record<EventHookName, number>>,
  scopes: ('instance' | 'user')[] = ['instance'],
): PluginInfo => ({
  id,
  version: '1.0.0',
  source: `${id}@1.0.0`,
  scopes,
  hosts: [],
  settings: { instance: null, user: null },
  messages: {},
  events: new Map(
    Object.entries(events).map(([hook, debounceSeconds]) => [
      hook as EventHookName,
      { debounceSeconds },
    ]),
  ),
  testable: false,
  digests: false,
  estimates: false,
});

const webhook = plugin('webhook', { 'published.changed': 120 }, ['user']);
const summary = plugin('summary', { 'entries.added': 0 });

let database: TestDatabase;
let db: Db;
let installed: PluginInfo[];
let runs: { plugin: string; hook: string; userId: number; event: unknown }[];
let outcome: EventRunOutcome;
let service: PluginEventService;
let alice: number;
let bob: number;
let subscription: number;
let feedSource: number;

const catalog: PluginCatalog = {
  get: (id) => installed.find((p) => p.id === id),
  list: () => installed,
};

/** Puts the recorded events back, as if their window had passed. */
const age = (seconds: number) =>
  db.update(pluginEvents).set({ createdAt: sql`created_at - make_interval(secs => ${seconds})` });

const events = () =>
  db
    .select({
      pluginId: pluginEvents.pluginId,
      userId: pluginEvents.userId,
      hook: pluginEvents.hook,
      published: pluginEvents.published,
    })
    .from(pluginEvents)
    .orderBy(pluginEvents.id);

async function entryFor(userId: number, guid: string, published = false): Promise<number> {
  const [entry] = await db
    .insert(entries)
    .values({
      feedSourceId: feedSource,
      guid,
      title: `Title ${guid}`,
      link: `https://a.example/${guid}`,
      contentHash: guid,
      content: `<p>Text of ${guid}</p>`,
    })
    .returning();
  const [row] = await db
    .insert(userEntries)
    .values({
      userId,
      entryId: entry?.id ?? 0,
      subscriptionId: userId === alice ? subscription : null,
      sortAt: new Date(),
      published,
    })
    .returning();
  return row?.id ?? 0;
}

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
});

beforeEach(async () => {
  for (const table of [pluginDeliveries, pluginEvents, pluginUserSettings, pluginSettings])
    await db.delete(table);
  await db.delete(users);
  await db.delete(feedSources);
  installed = [webhook, summary];
  runs = [];
  outcome = 'ok';
  service = new PluginEventService({
    db,
    catalog,
    runner: {
      run: (p, hook, userId, event) => {
        runs.push({ plugin: p.id, hook, userId, event });
        return Promise.resolve(outcome);
      },
    },
    logger: silentLogger,
    publicUrl: 'https://reader.example/',
  });
  [alice, bob] = (
    await db
      .insert(users)
      .values([
        { login: 'alice', passwordHash: 'x' },
        { login: 'bob', passwordHash: 'x' },
      ])
      .returning()
  ).map((u) => u.id) as [number, number];
  const [source] = await db
    .insert(feedSources)
    .values({ url: 'https://a.example/feed', title: 'A blog' })
    .returning();
  feedSource = source?.id ?? 0;
  const [sub] = await db
    .insert(subscriptions)
    .values({ userId: alice, feedSourceId: feedSource, title: 'My A' })
    .returning();
  subscription = sub?.id ?? 0;
  // Both on for the instance; the webhook, with user scope, on for alice only.
  await db.insert(pluginSettings).values([
    { pluginId: 'webhook', enabled: true },
    { pluginId: 'summary', enabled: true },
  ]);
  await db.insert(pluginUserSettings).values({ pluginId: 'webhook', userId: alice, enabled: true });
  await service.syncInstalled();
});

afterAll(async () => {
  await database.drop();
});

describe('recording events', () => {
  it('tells the database which hooks the installed plugins implement', async () => {
    await db
      .insert(pluginSettings)
      .values({ pluginId: 'gone', enabled: true, hooks: ['entries.added'] });
    await service.syncInstalled();
    const rows = await db
      .select({
        id: pluginSettings.pluginId,
        hooks: pluginSettings.hooks,
        user: pluginSettings.userScope,
      })
      .from(pluginSettings)
      .orderBy(pluginSettings.pluginId);
    expect(rows).toEqual([
      { id: 'gone', hooks: [], user: false },
      { id: 'summary', hooks: ['entries.added'], user: false },
      { id: 'webhook', hooks: ['published.changed'], user: true },
    ]);
  });

  it('records every change to a published feed, by any statement, for plugins listening', async () => {
    const entryServices = createEntryServices(db, new RecordingRealtime());
    const one = await entryFor(alice, 'one');
    const two = await entryFor(alice, 'two', true);
    await entryFor(bob, 'three', true);
    expect(await events()).toEqual([
      { pluginId: 'webhook', userId: alice, hook: 'published.changed', published: true },
    ]);
    await db.delete(pluginEvents);

    await entryServices.entries.setState(alice, [one], { published: true });
    await entryServices.entries.setState(alice, [one], { published: true });
    await entryServices.entries.toggle(alice, [two], 'published');
    await entryServices.entries.setState(alice, [one], { unread: false });
    await db.delete(userEntries).where(eq(userEntries.id, one));
    expect((await events()).map((e) => e.published)).toEqual([true, false, false]);
  });

  it('records nothing for plugins that are off, or off for the user', async () => {
    await db.update(pluginUserSettings).set({ enabled: false });
    await entryFor(alice, 'one', true);
    await db.update(pluginSettings).set({ enabled: false });
    await entryFor(alice, 'two', true);
    await recordEntriesAdded(db, [{ id: 1, userId: alice }]);
    expect(await events()).toEqual([]);
  });

  it('records new entries for each subscriber, and goes with a deleted user', async () => {
    const one = await entryFor(alice, 'one');
    const two = await entryFor(bob, 'two');
    await recordEntriesAdded(db, [
      { id: one, userId: alice },
      { id: two, userId: bob },
    ]);
    expect(await events()).toEqual([
      { pluginId: 'summary', userId: alice, hook: 'entries.added', published: null },
      { pluginId: 'summary', userId: bob, hook: 'entries.added', published: null },
    ]);
    await entryFor(alice, 'three', true);
    await db.delete(users).where(eq(users.id, alice));
    expect((await events()).map((e) => e.userId)).toEqual([bob]);
  });
});

describe('PluginEventService.dispatch', () => {
  it('waits out the debounce window, then delivers a burst as one event of the entries now', async () => {
    const entryServices = createEntryServices(db, new RecordingRealtime());
    await db.insert(accessKeys).values({ userId: alice, purpose: 'published', key: 'k1' });
    const one = await entryFor(alice, 'one');
    const two = await entryFor(alice, 'two');
    await entryServices.entries.setState(alice, [one, two], { published: true });
    await entryServices.entries.setState(alice, [two], { published: false });
    expect(await service.nextDueSeconds()).toBeGreaterThan(110);
    expect(await service.dispatch()).toBe(0);
    expect(runs).toEqual([]);

    await age(121);
    expect(await service.nextDueSeconds()).toBe(0);
    expect(await service.dispatch()).toBe(1);
    expect(runs).toEqual([
      {
        plugin: 'webhook',
        hook: 'published.changed',
        userId: alice,
        event: {
          userId: alice,
          feedUrl: 'https://reader.example/public/feeds/k1',
          published: [
            expect.objectContaining({
              id: one,
              title: 'Title one',
              link: 'https://a.example/one',
              published: true,
              feed: {
                id: subscription,
                title: 'My A',
                url: 'https://a.example/feed',
                withLogin: false,
              },
            }),
          ],
          unpublished: [two],
        },
      },
    ]);
    expect(runs[0]?.event).not.toHaveProperty('published.0.text');
    expect(await db.select().from(pluginEvents)).toEqual([]);
    expect(await db.select().from(pluginDeliveries)).toEqual([]);
    expect(await service.nextDueSeconds()).toBeNull();
  });

  it('gives entries.added the text of entries the user still has', async () => {
    const one = await entryFor(alice, 'one');
    await recordEntriesAdded(db, [
      { id: one, userId: alice },
      { id: 999_999, userId: alice },
    ]);
    await service.dispatch();
    expect(runs).toEqual([
      expect.objectContaining({
        hook: 'entries.added',
        event: {
          userId: alice,
          entries: [expect.objectContaining({ id: one, text: 'Text of one', contentHash: 'one' })],
        },
      }),
    ]);
  });

  it('retries a failed delivery with backoff, and drops it after the last attempt', async () => {
    const one = await entryFor(alice, 'one');
    await recordEntriesAdded(db, [{ id: one, userId: alice }]);
    outcome = 'failed';
    await service.dispatch();
    const [delivery] = await db.select().from(pluginDeliveries);
    expect(delivery).toMatchObject({ attempts: 1, leasedUntil: null });
    expect((delivery?.dueAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(
      (retryDelaySeconds(1) - 5) * 1000,
    );
    // Not due yet: nothing runs.
    await service.dispatch();
    expect(runs).toHaveLength(1);

    for (let attempt = 2; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
      await db.update(pluginDeliveries).set({ dueAt: sql`now() - interval '1 second'` });
      await service.dispatch();
    }
    expect(runs).toHaveLength(MAX_DELIVERY_ATTEMPTS);
    expect(await db.select().from(pluginDeliveries)).toEqual([]);
  });

  it('does not run a delivery another process holds, and takes it once its lease lapses', async () => {
    const one = await entryFor(alice, 'one');
    await recordEntriesAdded(db, [{ id: one, userId: alice }]);
    outcome = 'failed';
    await service.dispatch();
    await db.update(pluginDeliveries).set({
      dueAt: sql`now() - interval '1 second'`,
      leasedUntil: sql`now() + interval '1 minute'`,
    });
    await service.dispatch();
    expect(runs).toHaveLength(1);
    await db.update(pluginDeliveries).set({ leasedUntil: sql`now() - interval '1 second'` });
    outcome = 'ok';
    await service.dispatch();
    expect(runs).toHaveLength(2);
  });

  it('drops deliveries of plugins that are off, or no longer installed', async () => {
    const one = await entryFor(alice, 'one');
    await recordEntriesAdded(db, [{ id: one, userId: alice }]);
    outcome = 'disabled';
    await service.dispatch();
    expect(await db.select().from(pluginDeliveries)).toEqual([]);

    await recordEntriesAdded(db, [{ id: one, userId: alice }]);
    installed = [webhook];
    await service.dispatch();
    expect(runs).toHaveLength(1);
    expect(await db.select().from(pluginEvents)).toEqual([]);
  });

  it('runs only where hooks can run', async () => {
    const recorder = new PluginEventService({
      db,
      catalog,
      runner: null,
      logger: silentLogger,
      publicUrl: null,
    });
    await expect(recorder.dispatch()).rejects.toThrow('This process runs no plugin hooks');
  });
});

describe('PluginWaker', () => {
  it('queues a wake for the next due delivery, once per process for that time', async () => {
    const enqueue = vi.fn(() => Promise.resolve(true));
    const waker = new PluginWaker({ events: service, queue: { enqueue }, logger: silentLogger });
    await waker.wake();
    expect(enqueue).not.toHaveBeenCalled();

    const realtime = new RecordingRealtime();
    const waking = wakingRealtime(realtime, waker);
    const entryServices = createEntryServices(db, waking);
    const one = await entryFor(alice, 'one');
    await entryServices.entries.setState(alice, [one], { published: true });
    expect(realtime.published).toEqual([{ userId: alice, event: { type: 'counters' } }]);
    expect(enqueue).toHaveBeenCalledWith(
      'plugin.dispatch',
      {},
      { key: 'plugin.dispatch', delaySeconds: expect.any(Number) as number },
    );
    const [, , options] = enqueue.mock.calls[0] as unknown as [
      string,
      object,
      { delaySeconds: number },
    ];
    expect(options.delaySeconds).toBeGreaterThan(110);
    await waker.wake();
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("keeps the realtime's change markers, which clients poll on AWS", () => {
    class Marked extends RecordingRealtime {
      readonly prefix = 'changes/';
      changesPath(userId: number) {
        return `${this.prefix}${String(userId)}`;
      }
    }
    const wake = () => Promise.resolve();
    expect(wakingRealtime(new Marked(), { wake }).changesPath?.(7)).toBe('changes/7');
    expect(wakingRealtime(new RecordingRealtime(), { wake })).not.toHaveProperty('changesPath');
  });

  it('wakes nothing where no installed plugin has event hooks, and never throws', async () => {
    const enqueue = vi.fn(() => Promise.reject(new Error('SQS down')));
    installed = [plugin('quiet', {})];
    await new PluginWaker({ events: service, queue: { enqueue }, logger: silentLogger }).wake();
    expect(enqueue).not.toHaveBeenCalled();
    installed = [webhook];
    const one = await entryFor(alice, 'one', true);
    expect(one).toBeGreaterThan(0);
    await expect(
      new PluginWaker({ events: service, queue: { enqueue }, logger: silentLogger }).wake(),
    ).resolves.toBeUndefined();
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
