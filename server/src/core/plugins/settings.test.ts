import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDb, type Db } from '../../db/client.ts';
import { pluginSettings, pluginStorage, pluginUserSettings, users } from '../../db/schema.ts';
import { createTestDatabase, type TestDatabase } from '../../test/database.ts';
import { CryptoError, deriveKey, open } from '../crypto.ts';
import { DomainError } from '../errors.ts';
import type { PluginCatalog, PluginInfo, SettingsField, SettingsSpec } from './catalog.ts';
import { PLUGIN_FAILURE_LIMIT, PluginSettingsService } from './settings.ts';
import { PluginStorageService } from './storage.ts';

const SECRET = 'the app secret of this instance, 32+ chars';
const key = deriveKey(SECRET, 'plugin-secrets');

/** A settings spec as the registry makes them, from a schema and its marked fields. */
function spec(
  schema: z.ZodObject,
  marks: Record<string, Partial<SettingsField>> = {},
): SettingsSpec {
  return {
    fields: new Map(
      Object.keys(schema.shape).map((name): [string, SettingsField] => [
        name,
        {
          secret: marks[name]?.secret ?? false,
          url: marks[name]?.url ?? false,
          multiline: marks[name]?.multiline ?? false,
          feeds: marks[name]?.feeds ?? false,
        },
      ]),
    ),
    jsonSchema: {},
    parse(values) {
      const parsed = schema.safeParse(values);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, issues: parsed.error.issues.map((i) => i.path.join('.')).join('; ') };
    },
  };
}

const info = (id: string, overrides: Partial<PluginInfo>): PluginInfo => ({
  id,
  version: '1.0.0',
  source: `@newses/plugin-${id}@1.0.0`,
  scopes: ['instance'],
  hosts: [],
  settings: { instance: null, user: null },
  messages: {},
  events: new Map(),
  testable: false,
  digests: false,
  ...overrides,
});

// A user-configured webhook, and an instance-configured summary users opt in to.
const webhook = info('webhook', {
  scopes: ['user'],
  settings: {
    instance: null,
    user: spec(
      z.object({
        target: z.url(),
        token: z.string().min(1).optional(),
        method: z.enum(['POST', 'PUT']).default('POST'),
      }),
      { target: { url: true, secret: true }, token: { secret: true } },
    ),
  },
});
const summary = info('summary', {
  scopes: ['instance', 'user'],
  hosts: ['api.anthropic.com'],
  settings: {
    instance: spec(z.object({ apiKey: z.string().min(1), model: z.string().default('m') }), {
      apiKey: { secret: true },
    }),
    user: null,
  },
});

let database: TestDatabase;
let db: Db;
let installed: PluginInfo[];
let service: PluginSettingsService;
let alice: number;

const catalog: PluginCatalog = {
  get: (id) => installed.find((p) => p.id === id),
  list: () => installed,
};

/** The error a call failed with. */
async function failure(call: Promise<unknown>): Promise<DomainError> {
  const err: unknown = await call.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof DomainError)) throw new Error(`expected a DomainError, got ${String(err)}`);
  return err;
}

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
});

beforeEach(async () => {
  for (const table of [pluginStorage, pluginUserSettings, pluginSettings, users])
    await db.delete(table);
  installed = [webhook, summary];
  service = new PluginSettingsService({ db, key, catalog });
  const [user] = await db.insert(users).values({ login: 'alice', passwordHash: 'x' }).returning();
  alice = user?.id ?? 0;
});

afterAll(async () => {
  await database.drop();
});

describe('PluginSettingsService instance settings', () => {
  it('saves them checked by the schema, sealing secrets and never showing them', async () => {
    expect((await failure(service.updateInstance('nope', { enabled: true }))).code).toBe(
      'not_found',
    );
    const missing = await failure(service.updateInstance('summary', { enabled: true }));
    expect(missing.message).toBe('Settings of summary: apiKey');

    const view = await service.updateInstance('summary', {
      enabled: true,
      settings: { apiKey: 'sk-ant-1' },
      approvedHosts: ['API.anthropic.com', 'api.anthropic.com '],
    });
    expect(view).toEqual({
      pluginId: 'summary',
      enabled: true,
      settings: { model: 'm' },
      secretsSet: ['apiKey'],
      approvedHosts: ['api.anthropic.com'],
      failures: 0,
      lastFailure: null,
      lastFailureDetail: null,
      lastFailureAt: null,
      disabledReason: null,
    });
    expect(await service.instance('summary')).toEqual(view);
    const [row] = await db.select().from(pluginSettings);
    expect(JSON.stringify(row)).not.toContain('sk-ant-1');
    expect(open(key, row?.secrets.apiKey ?? '', 'plugin:summary:instance:apiKey')).toBe('sk-ant-1');
  });

  it('keeps a secret left out, replaces one given, and clears one given null', async () => {
    await service.updateInstance('summary', { settings: { apiKey: 'one', model: 'a' } });
    await service.updateInstance('summary', { settings: { model: 'b' } });
    expect(await service.runtime(summary, null)).toEqual({ active: false, reason: 'disabled' });
    await service.updateInstance('summary', { enabled: true });
    expect(await service.runtime(summary, null)).toMatchObject({
      active: true,
      settings: { apiKey: 'one', model: 'b' },
    });
    await service.updateInstance('summary', { settings: { apiKey: 'two' } });
    expect(await service.runtime(summary, null)).toMatchObject({
      settings: { apiKey: 'two', model: 'm' },
    });
    const cleared = await failure(
      service.updateInstance('summary', { settings: { apiKey: null } }),
    );
    expect(cleared.message).toBe('Settings of summary: apiKey');
  });

  it('refuses settings the plugin does not have, hosts that are not host names, and too many', async () => {
    expect(
      (await failure(service.updateInstance('summary', { settings: { apiKey: 'k', extra: 1 } })))
        .message,
    ).toBe('The plugin summary has no setting extra');
    expect(
      (await failure(service.updateInstance('webhook', { settings: { target: 'x' } }))).message,
    ).toBe('The plugin webhook has no setting target');
    expect(
      (await failure(service.updateInstance('webhook', { approvedHosts: ['https://a.example/'] })))
        .message,
    ).toBe('https://a.example/ is not a host name');
    const many = Array.from({ length: 51 }, (_, i) => `h${String(i)}.example`);
    expect((await failure(service.updateInstance('webhook', { approvedHosts: many }))).code).toBe(
      'invalid_input',
    );
    expect(
      (
        await failure(
          service.updateInstance('summary', {
            settings: { apiKey: 'k', model: 'm'.repeat(70_000) },
          }),
        )
      ).message,
    ).toBe('Settings of summary are too large');
  });

  it('lists the settings of plugins no longer installed, until removed', async () => {
    await service.updateInstance('summary', { enabled: true, settings: { apiKey: 'k' } });
    await new PluginStorageService(db).store('summary', null).set('cache', 1);
    installed = [webhook];
    expect((await service.list()).map((s) => s.pluginId)).toEqual(['summary']);
    expect(await service.remove('summary')).toBe(true);
    expect(await service.list()).toEqual([]);
    expect(await db.select().from(pluginStorage)).toEqual([]);
    expect(await service.remove('summary')).toBe(false);
  });
});

describe('PluginSettingsService user settings', () => {
  it('saves URLs only on hosts approved for the plugin', async () => {
    const refused = await failure(
      service.updateUser('webhook', alice, {
        enabled: true,
        settings: { target: 'https://Hooks.example/build' },
      }),
    );
    expect(refused.message).toBe('hooks.example is not approved for the plugin webhook');
    await service.updateInstance('webhook', { enabled: true, approvedHosts: ['hooks.example'] });
    const view = await service.updateUser('webhook', alice, {
      enabled: true,
      settings: { target: 'https://Hooks.example/build', token: 't' },
    });
    expect(view).toMatchObject({ enabled: true, settings: { method: 'POST' } });
    expect(view.secretsSet).toEqual(['target', 'token']);
    expect(await service.runtime(webhook, alice)).toEqual({
      active: true,
      approvedHosts: new Set(['hooks.example']),
      settings: {},
      userSettings: { target: 'https://Hooks.example/build', token: 't', method: 'POST' },
    });
    await service.updateUser('webhook', alice, { settings: { method: 'PUT', token: null } });
    const { userSettings } = (await service.runtime(webhook, alice)) as { userSettings: object };
    expect(userSettings).toEqual({ target: 'https://Hooks.example/build', method: 'PUT' });
  });

  it('are for plugins with user scope, and go with the user', async () => {
    installed.push(info('nightly', { scopes: ['instance'] }));
    expect((await failure(service.updateUser('nightly', alice, { enabled: true }))).message).toBe(
      'The plugin nightly has no user settings',
    );
    await service.updateInstance('webhook', { approvedHosts: ['hooks.example'] });
    await service.updateUser('webhook', alice, {
      enabled: true,
      settings: { target: 'https://hooks.example/' },
    });
    await new PluginStorageService(db).store('webhook', alice).set('last', 'x');
    expect(await service.user('webhook', alice)).not.toBeNull();
    await db.delete(users).where(eq(users.id, alice));
    expect(await db.select().from(pluginUserSettings)).toEqual([]);
    expect(await db.select().from(pluginStorage)).toEqual([]);
  });

  it('are removed with the user’s storage of the plugin', async () => {
    await service.updateUser('webhook', alice, { enabled: false });
    const storage = new PluginStorageService(db);
    await storage.store('webhook', alice).set('k', 1);
    await storage.store('webhook', null).set('k', 1);
    expect(await service.removeUser('webhook', alice)).toBe(true);
    expect(await service.user('webhook', alice)).toBeNull();
    expect(await storage.store('webhook', null).get('k')).toBe(1);
    expect(await service.removeUser('webhook', alice)).toBe(false);
  });
});

describe('PluginSettingsService.runtime', () => {
  it("runs a user's hook only when the plugin is on for the instance and, with user scope, the user", async () => {
    expect(await service.runtime(webhook, alice)).toEqual({ active: false, reason: 'disabled' });
    await service.updateInstance('webhook', { enabled: true, approvedHosts: ['hooks.example'] });
    expect(await service.runtime(webhook, alice)).toEqual({ active: false, reason: 'disabled' });
    expect(await service.runtime(webhook, null)).toMatchObject({
      active: true,
      userSettings: null,
    });
    await service.updateUser('webhook', alice, {
      enabled: true,
      settings: { target: 'https://hooks.example/' },
    });
    expect(await service.runtime(webhook, alice)).toMatchObject({ active: true });
  });

  it('skips a plugin whose saved settings its new version no longer takes', async () => {
    await service.updateInstance('summary', { enabled: true, settings: { apiKey: 'k' } });
    const next = info('summary', {
      ...summary,
      settings: {
        instance: spec(z.object({ apiKey: z.string(), budget: z.number() }), {
          apiKey: { secret: true },
        }),
        user: null,
      },
    });
    expect(await service.runtime(next, alice)).toEqual({
      active: false,
      reason: 'invalid_settings',
    });
  });

  it('throws when a secret was sealed under another APP_SECRET', async () => {
    await service.updateInstance('summary', { enabled: true, settings: { apiKey: 'k' } });
    const other = new PluginSettingsService({
      db,
      key: deriveKey('another app secret of thirty-two characters', 'plugin-secrets'),
      catalog,
    });
    await expect(other.runtime(summary, null)).rejects.toThrow(CryptoError);
  });
});

describe('PluginSettingsService.recordRun', () => {
  const fail = { ok: false, failure: 'timeout' } as const;

  beforeEach(async () => {
    await service.updateInstance('summary', { enabled: true, settings: { apiKey: 'k' } });
    await service.updateInstance('webhook', { enabled: true, approvedHosts: ['hooks.example'] });
    await service.updateUser('webhook', alice, {
      enabled: true,
      settings: { target: 'https://hooks.example/' },
    });
  });

  it('turns a plugin off for everyone after failing repeatedly, until an admin enables it', async () => {
    for (let run = 1; run < PLUGIN_FAILURE_LIMIT; run++)
      expect(await service.recordRun(summary, alice, fail)).toBeNull();
    expect(await service.instance('summary')).toMatchObject({
      enabled: true,
      failures: PLUGIN_FAILURE_LIMIT - 1,
      lastFailure: 'timeout',
    });
    expect(await service.recordRun(summary, alice, fail)).toBe('instance');
    expect(await service.instance('summary')).toMatchObject({
      enabled: false,
      failures: PLUGIN_FAILURE_LIMIT,
      disabledReason: 'failures',
    });
    // Runs no longer count while it is off.
    expect(await service.recordRun(summary, null, fail)).toBeNull();
    expect(await service.updateInstance('summary', { enabled: true })).toMatchObject({
      enabled: true,
      failures: 0,
      disabledReason: null,
      lastFailure: 'timeout',
    });
  });

  it('starts counting again after a run that works', async () => {
    await service.recordRun(summary, null, fail);
    await service.recordRun(summary, null, fail);
    await service.recordRun(summary, null, { ok: true });
    expect(await service.instance('summary')).toMatchObject({ failures: 0 });
  });

  it("counts a user's runs of a plugin with user settings toward that user only", async () => {
    for (let run = 1; run < PLUGIN_FAILURE_LIMIT; run++)
      await service.recordRun(webhook, alice, fail);
    expect(await service.recordRun(webhook, alice, fail)).toBe('user');
    await service.recordRun(webhook, alice, {
      ok: false,
      failure: 'error',
      detail: 'HTTP 401 Unauthorized',
    });
    expect(await service.user('webhook', alice)).toMatchObject({
      enabled: false,
      disabledReason: 'failures',
      // Runs while it is off are not counted.
      lastFailure: 'timeout',
      lastFailureDetail: null,
    });
    await service.updateUser('webhook', alice, { enabled: true });
    await service.recordRun(webhook, alice, {
      ok: false,
      failure: 'error',
      detail: 'HTTP 401 Unauthorized',
    });
    expect(await service.user('webhook', alice)).toMatchObject({
      lastFailure: 'error',
      lastFailureDetail: 'HTTP 401 Unauthorized',
    });
    await service.recordRun(webhook, alice, { ok: true });
    await service.updateUser('webhook', alice, { enabled: false });
    expect(await service.instance('webhook')).toMatchObject({ enabled: true, failures: 0 });
    expect(await service.runtime(webhook, alice)).toEqual({ active: false, reason: 'disabled' });
    await service.updateUser('webhook', alice, { enabled: true });
    expect(await service.user('webhook', alice)).toMatchObject({
      enabled: true,
      failures: 0,
      disabledReason: null,
    });
  });
});

describe('PluginSettingsService.reseal', () => {
  it('re-seals secrets sealed under another secret, all or none, and can be repeated', async () => {
    const previousSecret = 'the previous app secret, also 32+ characters';
    const previous = new PluginSettingsService({
      db,
      key: deriveKey(previousSecret, 'plugin-secrets'),
      catalog,
    });
    await previous.updateInstance('summary', { enabled: true, settings: { apiKey: 'k' } });
    await previous.updateInstance('webhook', { enabled: true, approvedHosts: ['hooks.example'] });
    await previous.updateUser('webhook', alice, {
      enabled: true,
      settings: { target: 'https://hooks.example/', token: 't' },
    });

    const previousKey = deriveKey(previousSecret, 'plugin-secrets');
    expect(await service.reseal(previousKey)).toBe(3);
    expect(await service.runtime(summary, null)).toMatchObject({ settings: { apiKey: 'k' } });
    expect(await service.runtime(webhook, alice)).toMatchObject({
      userSettings: { target: 'https://hooks.example/', token: 't' },
    });
    expect(await service.reseal(previousKey)).toBe(0);
    expect(await service.reseal(key)).toBe(0);

    await previous.updateInstance('summary', { settings: { apiKey: 'k2' } });
    const wrong = deriveKey('a wrong app secret of thirty-two characters', 'plugin-secrets');
    const before = await db.select().from(pluginUserSettings);
    expect((await failure(service.reseal(wrong))).message).toBe(
      "The plugin summary's secret apiKey does not open with the previous secret",
    );
    expect(await db.select().from(pluginUserSettings)).toEqual(before);
  });
});
