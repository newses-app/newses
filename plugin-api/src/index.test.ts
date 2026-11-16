import { describe, expect, it } from 'vitest';
import { acceptsApiVersion, definePlugin, isApiRange, PLUGIN_API_VERSION } from './index.ts';

describe('acceptsApiVersion', () => {
  it('takes later patches of the same minor while the major is 0', () => {
    expect(acceptsApiVersion('^0.1', '0.1.0')).toBe(true);
    expect(acceptsApiVersion('^0.1', '0.1.7')).toBe(true);
    expect(acceptsApiVersion('^0.1.2', '0.1.2')).toBe(true);
    expect(acceptsApiVersion('^0.1.2', '0.1.1')).toBe(false);
    expect(acceptsApiVersion('^0.1', '0.2.0')).toBe(false);
    expect(acceptsApiVersion('^0.2', '0.1.9')).toBe(false);
  });

  it('takes later minors and patches of the same major from 1 on', () => {
    expect(acceptsApiVersion('^1.2', '1.2.0')).toBe(true);
    expect(acceptsApiVersion('^1.2', '1.5.0')).toBe(true);
    expect(acceptsApiVersion('^1.2.3', '1.2.2')).toBe(false);
    expect(acceptsApiVersion('^1.2', '1.1.9')).toBe(false);
    expect(acceptsApiVersion('^1.2', '2.0.0')).toBe(false);
  });

  it('accepts nothing for ranges other than a caret', () => {
    for (const range of ['0.1.0', '>=0.1', '~0.1', '*', '^0', '^01.1', '^0.1.x', ''])
      expect([range, isApiRange(range), acceptsApiVersion(range, '0.1.0')]).toEqual([
        range,
        false,
        false,
      ]);
  });

  it('checks against this contract by default', () => {
    const [major, minor] = PLUGIN_API_VERSION.split('.');
    expect(acceptsApiVersion(`^${major ?? ''}.${minor ?? ''}`)).toBe(true);
  });
});

describe('definePlugin', () => {
  it('returns the plugin unchanged', () => {
    const plugin = {
      id: 'x',
      version: '1.0.0',
      apiVersion: '^0.1',
      scopes: ['user' as const],
      hooks: {},
    };
    expect(definePlugin(plugin)).toBe(plugin);
  });
});
