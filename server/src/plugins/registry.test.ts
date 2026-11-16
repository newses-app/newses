import { describe, expect, it, vi } from 'vitest';
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
      source: '@newses/plugin-webhook@1.2.0',
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
    ];
    for (const [definition, id, detail] of cases) {
      const registry = load([{ source: 'x@1.0.0', plugin: definition }]);
      expect(registry.list()).toEqual([]);
      expect(registry.refused).toHaveLength(1);
      expect(registry.refused[0]).toMatchObject({ source: 'x@1.0.0', id, reason: 'invalid' });
      expect(registry.refused[0]?.detail).toContain(detail);
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
