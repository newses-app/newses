import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  acceptsApiVersion,
  definePlugin,
  FIELD_MARKS,
  isApiRange,
  multiline,
  PLUGIN_API_VERSION,
  secret,
  url,
} from './index.ts';

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

describe('secret and url', () => {
  it('mark settings, through optional and described copies', () => {
    expect(secret().optional().unwrap().meta()?.[FIELD_MARKS]).toEqual({ secret: true });
    expect(secret().describe('API key').meta()?.[FIELD_MARKS]).toEqual({ secret: true });
    expect(url().meta()?.[FIELD_MARKS]).toEqual({ url: true });
    expect(url({ secret: true }).meta()?.[FIELD_MARKS]).toEqual({ url: true, secret: true });
    expect(multiline().meta()?.[FIELD_MARKS]).toEqual({ multiline: true });
  });

  it('take non-empty secrets and http(s) URLs only', () => {
    expect(secret().safeParse('').success).toBe(false);
    expect(secret().safeParse('sk-1').success).toBe(true);
    expect(url().safeParse('https://hooks.example/build').success).toBe(true);
    expect(url().safeParse('ftp://hooks.example/').success).toBe(false);
    expect(url().safeParse('javascript:alert(1)').success).toBe(false);
  });

  it('build object schemas plugins declare as settings', () => {
    const plugin = definePlugin({
      id: 'webhook',
      version: '1.0.0',
      apiVersion: '^0.1',
      scopes: ['user'],
      settings: { user: z.object({ target: url({ secret: true }), token: secret().optional() }) },
      hooks: {},
    });
    expect(plugin.settings.user.parse({ target: 'https://a.example/' })).toEqual({
      target: 'https://a.example/',
    });
  });
});
