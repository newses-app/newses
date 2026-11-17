import { multiline, secret, STORAGE_LIMITS, url } from '@newses/plugin-api';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { STORE_LIMITS } from '../core/plugins/storage.ts';
import { PluginRegistry } from './registry.ts';

const plugin = (overrides: Record<string, unknown> = {}) => ({
  id: 'webhook',
  version: '1.2.0',
  apiVersion: '^0.1',
  scopes: ['user'],
  hosts: ['hooks.example'],
  hooks: {},
  ...overrides,
});

const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const load = (installed: { source: string; plugin: unknown }[], apiVersion = '0.1.0') =>
  PluginRegistry.load(installed, { logger: logger(), apiVersion });

describe('PluginRegistry', () => {
  it('loads plugins written for this contract, keeping their hooks as given', () => {
    const definition = plugin();
    const registry = load([{ source: '@newses/plugin-webhook@1.2.0', plugin: definition }]);
    expect(registry.refused).toEqual([]);
    expect(registry.list().map((p) => p.definition.id)).toEqual(['webhook']);
    expect(registry.get('webhook')).toEqual({
      id: 'webhook',
      version: '1.2.0',
      source: '@newses/plugin-webhook@1.2.0',
      scopes: ['user'],
      hosts: ['hooks.example'],
      settings: { instance: null, user: null },
      messages: {},
      events: new Map(),
      testable: false,
      definition,
    });
    expect(registry.get('webhook')?.definition).toBe(definition);
    expect(registry.get('other')).toBeUndefined();
  });

  it('refuses definitions it cannot use, naming the problem', () => {
    const cases: [unknown, string | null, string][] = [
      [null, null, 'expected object'],
      [plugin({ id: 'Web Hook' }), null, 'lower-case letters'],
      [plugin({ version: 'one' }), 'webhook', 'semver'],
      [plugin({ apiVersion: '>=0.1' }), 'webhook', 'caret range'],
      [plugin({ scopes: [] }), 'webhook', 'scopes'],
      [plugin({ scopes: ['user', 'user'] }), 'webhook', 'scopes repeat'],
      [plugin({ scopes: ['everyone'] }), 'webhook', 'scopes'],
      [plugin({ hosts: ['Hooks.Example'] }), 'webhook', 'host names'],
      [plugin({ hosts: ['https://hooks.example/'] }), 'webhook', 'host names'],
      [plugin({ hooks: { 'entry.read': () => undefined } }), 'webhook', 'entry.read'],
      [
        plugin({ hooks: { 'published.changed': { debounceSeconds: 7200, run: () => undefined } } }),
        'webhook',
        'published.changed',
      ],
      [plugin({ hooks: { 'entries.added': { run: 'x' } } }), 'webhook', 'a function'],
      [plugin({ settings: { user: { target: 'text' } } }), 'webhook', 'zod object schema'],
      [plugin({ settings: { everyone: z.object({}) } }), 'webhook', 'everyone'],
      [
        plugin({ scopes: ['instance'], settings: { user: z.object({}) } }),
        'webhook',
        'user settings need the user scope',
      ],
      [
        plugin({
          settings: { user: z.object({ count: z.number().meta({ newses: { secret: true } }) }) },
        }),
        'webhook',
        'count is marked secret or url but is not a string',
      ],
      [
        plugin({
          settings: { user: z.object({ headers: z.array(z.object({ value: secret() })) }) },
        }),
        'webhook',
        'top-level settings only, not inside headers',
      ],
    ];
    for (const [definition, id, detail] of cases) {
      const registry = load([{ source: 'x@1.0.0', plugin: definition }]);
      expect(registry.list()).toEqual([]);
      expect(registry.refused).toHaveLength(1);
      expect(registry.refused[0]).toMatchObject({ source: 'x@1.0.0', id, reason: 'invalid' });
      expect(registry.refused[0]?.detail).toContain(detail);
    }
  });

  it("reads each scope's settings: secret and URL fields, and the plugin's own check", () => {
    const registry = load([
      {
        source: 'w@1.0.0',
        plugin: plugin({
          scopes: ['instance', 'user'],
          settings: {
            instance: z.object({ region: z.enum(['eu', 'us']).default('eu') }),
            user: z.object({
              target: url({ secret: true }),
              token: secret().optional().describe('Bearer token'),
              callback: url().nullable(),
              note: z.string().max(5).optional(),
            }),
          },
        }),
      },
    ]);
    const settings = registry.get('webhook')?.settings;
    expect(settings?.instance?.fields).toEqual(
      new Map([['region', { secret: false, url: false, multiline: false }]]),
    );
    expect(settings?.instance?.parse({})).toEqual({ ok: true, value: { region: 'eu' } });
    expect(settings?.user?.fields).toEqual(
      new Map([
        ['target', { secret: true, url: true, multiline: false }],
        ['token', { secret: true, url: false, multiline: false }],
        ['callback', { secret: false, url: true, multiline: false }],
        ['note', { secret: false, url: false, multiline: false }],
      ]),
    );
    expect(
      settings?.user?.parse({ target: 'ftp://x.example/', callback: null, note: 'too long' }),
    ).toEqual({
      ok: false,
      issues: expect.stringMatching(/^target: .+; note: .+$/) as string,
    });
  });

  it('describes settings as JSON Schema for forms, marks included and secret defaults left out', () => {
    const registry = load([
      {
        source: 'w@1.0.0',
        plugin: plugin({
          settings: {
            user: z.object({
              token: secret().default('do-not-show'),
              target: url().optional(),
              body: multiline().optional(),
              method: z.enum(['POST', 'PUT']).default('POST'),
            }),
          },
          messages: { en: { name: 'Webhook' }, 'pt-BR': { name: 'Gancho' } },
        }),
      },
    ]);
    const loaded = registry.get('webhook');
    expect(loaded?.messages).toEqual({ en: { name: 'Webhook' }, 'pt-BR': { name: 'Gancho' } });
    expect(loaded?.settings.user?.jsonSchema).toEqual({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        token: { type: 'string', minLength: 1, maxLength: 4096, newses: { secret: true } },
        target: expect.objectContaining({
          type: 'string',
          format: 'uri',
          newses: { url: true },
        }) as object,
        body: { type: 'string', maxLength: 10_000, newses: { multiline: true } },
        method: { type: 'string', enum: ['POST', 'PUT'], default: 'POST' },
      },
    });
  });

  it('refuses messages it cannot show', () => {
    for (const messages of [{ English: { name: 'x' } }, { en: { name: 7 } }, { en: { '': 'x' } }]) {
      const registry = load([{ source: 'w@1.0.0', plugin: plugin({ messages }) }]);
      expect(registry.refused).toEqual([expect.objectContaining({ reason: 'invalid' })]);
    }
  });

  it('refuses plugins written for another contract version', () => {
    const registry = load(
      [
        { source: 'a@1.0.0', plugin: plugin({ id: 'a', apiVersion: '^0.2' }) },
        { source: 'b@1.0.0', plugin: plugin({ id: 'b', apiVersion: '^0.1.3' }) },
        { source: 'c@1.0.0', plugin: plugin({ id: 'c', apiVersion: '^0.1.1' }) },
      ],
      '0.1.2',
    );
    expect(registry.list().map((p) => p.definition.id)).toEqual(['c']);
    expect(registry.refused).toEqual([
      {
        source: 'a@1.0.0',
        id: 'a',
        reason: 'incompatible',
        detail: 'needs plugin API ^0.2; this server has 0.1.2',
      },
      {
        source: 'b@1.0.0',
        id: 'b',
        reason: 'incompatible',
        detail: 'needs plugin API ^0.1.3; this server has 0.1.2',
      },
    ]);
  });

  it('keeps the first of plugins sharing an id', () => {
    const registry = load([
      { source: 'first@1.0.0', plugin: plugin() },
      { source: 'second@2.0.0', plugin: plugin({ version: '2.0.0' }) },
    ]);
    expect(registry.get('webhook')?.source).toBe('first@1.0.0');
    expect(registry.refused).toEqual([
      {
        source: 'second@2.0.0',
        id: 'webhook',
        reason: 'duplicate',
        detail: 'first@1.0.0 has the same id',
      },
    ]);
  });

  it('logs what it loads and refuses', () => {
    const log = logger();
    PluginRegistry.load(
      [
        { source: 'ok@1.0.0', plugin: plugin() },
        { source: 'bad@1.0.0', plugin: plugin({ id: 'bad', apiVersion: '^9.0' }) },
      ],
      { logger: log },
    );
    expect(log.info).toHaveBeenCalledWith(
      { plugin: 'webhook', source: 'ok@1.0.0', version: '1.2.0' },
      'Plugin loaded',
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ plugin: 'bad', source: 'bad@1.0.0', reason: 'incompatible' }),
      'Plugin refused',
    );
  });
});

describe('STORAGE_LIMITS', () => {
  it('are the limits the server keeps', () => {
    expect(STORAGE_LIMITS).toEqual(STORE_LIMITS);
  });
});
