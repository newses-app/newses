import type { Plugin, PluginsResponse } from '@newses/shared';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HttpFetcher } from '../core/feeds/http.ts';
import { createDb, type Db } from '../db/client.ts';
import { auditEvents, pluginSettings, pluginStorage, pluginUserSettings } from '../db/schema.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { testPluginCatalog } from '../test/plugins.ts';
import { createTestServices } from '../test/services.ts';
import { type ApiServices, buildApp } from './app.ts';

let database: TestDatabase;
let db: Db;
let app: ReturnType<typeof buildApp>;
let services: ApiServices;
let pat: Auth;
let admin: Auth;

interface Auth {
  cookie: string;
  csrf: string;
}

async function sessionFor(userId: number): Promise<Auth> {
  const { token, session } = await services.sessions.create(userId, 'cookie', null);
  return { cookie: `rss_session=${token}`, csrf: session.csrfToken ?? '' };
}

const call = (method: 'GET' | 'PATCH' | 'DELETE', url: string, auth: Auth, payload?: object) =>
  app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrf },
    ...(payload && { payload }),
  });

const list = async (auth: Auth) => (await call('GET', '/plugins', auth)).json<PluginsResponse>();

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
  services = createTestServices(db, new HttpFetcher(), {}, testPluginCatalog());
  pat = await sessionFor((await services.users.create('pat', 'pat password')).id);
  admin = await sessionFor((await services.users.create('root', 'root password', 'admin')).id);
  app = buildApp({ logger: pino({ level: 'silent' }), healthChecks: {}, services });
  await app.ready();
});

beforeEach(async () => {
  for (const table of [pluginStorage, pluginUserSettings, pluginSettings]) await db.delete(table);
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe('plugins API', () => {
  it('tells apps that plugins are installed', async () => {
    const info = await app.inject({ method: 'GET', url: '/api/v1/server' });
    expect(info.json()).toMatchObject({ plugins: true, apiVersion: { major: 1, minor: 15 } });
  });

  it('lists every installed plugin to admins, with its form and instance settings', async () => {
    const { plugins, uninstalled } = await list(admin);
    expect(uninstalled).toEqual([]);
    expect(plugins.map((p) => p.id)).toEqual(['webhook', 'summary']);
    const summary = plugins[1];
    expect(summary).toMatchObject({
      id: 'summary',
      version: '2.0.0',
      scopes: ['instance', 'user'],
      enabled: false,
      hosts: ['api.anthropic.com'],
      approvedHosts: [],
      messages: {},
      admin: { enabled: false, secretsSet: [], source: '@newses/plugin-summary@2.0.0' },
      user: { enabled: false },
    });
    expect(summary?.settingsSchemas.instance).toMatchObject({
      type: 'object',
      properties: { apiKey: { type: 'string', newses: { secret: true } } },
      required: ['apiKey'],
    });
    expect(summary?.settingsSchemas.user).toBeNull();
    expect(plugins[0]?.settingsSchemas.user).toMatchObject({
      properties: {
        target: { format: 'uri', newses: { secret: true, url: true } },
        method: { enum: ['POST', 'PUT'], default: 'POST' },
        body: { newses: { multiline: true } },
        headers: { type: 'array', items: { type: 'object' } },
      },
    });
  });

  it('lets admins enable a plugin, set its settings, and approve its hosts, never returning secrets', async () => {
    const refused = await call('PATCH', '/admin/plugins/summary', admin, { enabled: true });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({
      reason: 'plugin_settings_invalid',
      params: { detail: expect.stringContaining('apiKey') as string },
    });
    const saved = await call('PATCH', '/admin/plugins/summary', admin, {
      enabled: true,
      settings: { apiKey: 'sk-ant-secret' },
      approvedHosts: ['api.anthropic.com'],
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain('sk-ant-secret');
    expect(saved.json<Plugin>()).toMatchObject({
      enabled: true,
      approvedHosts: ['api.anthropic.com'],
      admin: { enabled: true, settings: { model: 'm' }, secretsSet: ['apiKey'] },
    });
    const [audit] = await db.select().from(auditEvents);
    expect(audit).toMatchObject({
      event: 'plugin_updated',
      details: { pluginId: 'summary', enabled: true, settings: ['apiKey'] },
    });
    expect(JSON.stringify(audit)).not.toContain('sk-ant-secret');

    const host = await call('PATCH', '/admin/plugins/summary', admin, { approvedHosts: ['a b'] });
    expect(host.json()).toMatchObject({ reason: 'invalid_host', params: { host: 'a b' } });
    expect((await call('PATCH', '/admin/plugins/nope', admin, { enabled: true })).statusCode).toBe(
      404,
    );
    expect(
      (await call('PATCH', '/admin/plugins/summary', pat, { enabled: false })).statusCode,
    ).toBe(403);
  });

  it('shows users only the plugins an admin turned on, without instance settings', async () => {
    expect((await list(pat)).plugins).toEqual([]);
    expect(
      (await call('PATCH', '/account/plugins/webhook', pat, { enabled: true })).statusCode,
    ).toBe(404);
    await call('PATCH', '/admin/plugins/webhook', admin, {
      enabled: true,
      approvedHosts: ['hooks.example'],
    });
    const { plugins, uninstalled } = await list(pat);
    expect(uninstalled).toEqual([]);
    expect(plugins).toEqual([
      expect.objectContaining({
        id: 'webhook',
        enabled: true,
        approvedHosts: ['hooks.example'],
        admin: null,
        settingsSchemas: { instance: null, user: expect.any(Object) as object },
        messages: {
          en: { name: 'Webhook', 'settings.target': 'URL' },
          de: { name: 'Webhook (de)' },
        },
      }),
    ]);
  });

  it("keeps each user's own settings, with URLs only on approved hosts", async () => {
    await call('PATCH', '/admin/plugins/webhook', admin, {
      enabled: true,
      approvedHosts: ['hooks.example'],
    });
    const elsewhere = await call('PATCH', '/account/plugins/webhook', pat, {
      enabled: true,
      settings: { target: 'https://elsewhere.example/build' },
    });
    expect(elsewhere.json()).toMatchObject({
      reason: 'plugin_host_not_approved',
      params: { host: 'elsewhere.example' },
    });
    const unknown = await call('PATCH', '/account/plugins/webhook', pat, {
      settings: { target: 'https://hooks.example/', colour: 'red' },
    });
    expect(unknown.json()).toMatchObject({
      reason: 'plugin_setting_unknown',
      params: { name: 'colour' },
    });

    const saved = await call('PATCH', '/account/plugins/webhook', pat, {
      enabled: true,
      settings: {
        target: 'https://hooks.example/build?token=abc',
        headers: [{ name: 'X-Site', value: 'blog' }],
      },
    });
    expect(saved.body).not.toContain('token=abc');
    expect(saved.json<Plugin>().user).toMatchObject({
      enabled: true,
      settings: { method: 'POST', headers: [{ name: 'X-Site', value: 'blog' }] },
      secretsSet: ['target'],
    });
    // Admins' own view of the plugin has their settings, not pat's.
    expect((await list(admin)).plugins[0]?.user).toMatchObject({ enabled: false, secretsSet: [] });

    expect((await call('DELETE', '/account/plugins/webhook', pat)).statusCode).toBe(204);
    expect((await list(pat)).plugins[0]?.user).toMatchObject({ enabled: false, secretsSet: [] });
  });

  it('lets admins remove the settings of plugins no longer installed', async () => {
    await services.plugins.storage.store('gone', null).set('k', 1);
    expect((await list(admin)).uninstalled).toEqual(['gone']);
    expect((await list(pat)).uninstalled).toEqual([]);
    expect((await call('DELETE', '/admin/plugins/gone', admin)).statusCode).toBe(204);
    expect((await list(admin)).uninstalled).toEqual([]);
    expect((await call('DELETE', '/admin/plugins/gone', admin)).statusCode).toBe(404);
    expect((await call('DELETE', '/admin/plugins/gone', pat)).statusCode).toBe(403);
  });
});
