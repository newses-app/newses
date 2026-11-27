import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  acceptsApiVersion,
  DIGEST_LIMITS,
  definePlugin,
  digestAdditionsSchema,
  FIELD_MARKS,
  feeds,
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

describe('digestAdditionsSchema', () => {
  const section = (text: string, entries: number[] = [1]) => ({
    heading: 'Technology',
    items: [{ text, entries }],
  });

  it('takes sections citing entries by id, as paragraphs or a list', () => {
    const additions = {
      overview: 'Mostly chips.',
      sections: [section('Chips got faster.', [1, 2]), { ...section('More'), list: true }],
    };
    expect(digestAdditionsSchema.parse(additions)).toEqual(additions);
    expect(digestAdditionsSchema.parse({ sections: null })).toEqual({ sections: null });
  });

  it('refuses sections past the limits', () => {
    const refused = (sections: unknown) => !digestAdditionsSchema.safeParse({ sections }).success;
    expect(refused(Array.from({ length: DIGEST_LIMITS.sections + 1 }, () => section('x')))).toBe(
      true,
    );
    expect(refused([section('x'.repeat(DIGEST_LIMITS.itemText + 1))])).toBe(true);
    expect(refused([section('x', [1, 2, 3, 4, 5, 6])])).toBe(true);
    expect(refused([{ ...section('x'), heading: 'x'.repeat(81) }])).toBe(true);
    expect(
      refused([
        {
          heading: 'All',
          items: Array.from({ length: DIGEST_LIMITS.sectionItems + 1 }, () => ({ text: 'x' })),
        },
      ]),
    ).toBe(true);
    // Each within its limits, but more text than sections hold together.
    const long = section('x'.repeat(DIGEST_LIMITS.itemText));
    expect(
      refused(
        Array.from({ length: 12 }, () => ({ ...long, items: [...long.items, ...long.items] })),
      ),
    ).toBe(true);
    expect(refused([section('x', [1.5])])).toBe(true);
  });
});

describe('secret and url', () => {
  it('mark settings, through optional and described copies', () => {
    expect(secret().optional().unwrap().meta()?.[FIELD_MARKS]).toEqual({ secret: true });
    expect(secret().describe('API key').meta()?.[FIELD_MARKS]).toEqual({ secret: true });
    expect(url().meta()?.[FIELD_MARKS]).toEqual({ url: true });
    expect(url({ secret: true }).meta()?.[FIELD_MARKS]).toEqual({ url: true, secret: true });
    expect(multiline().meta()?.[FIELD_MARKS]).toEqual({ multiline: true });
    expect(feeds().unwrap().meta()?.[FIELD_MARKS]).toEqual({ feeds: true });
  });

  it('take feed ids, none by default', () => {
    expect(feeds().parse(undefined)).toEqual([]);
    expect(feeds().parse([3, 7])).toEqual([3, 7]);
    expect(feeds().safeParse([0]).success).toBe(false);
    expect(feeds().safeParse([1.5]).success).toBe(false);
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
    expect(plugin.settings?.user?.parse({ target: 'https://a.example/' })).toEqual({
      target: 'https://a.example/',
    });
  });

  it("give hooks a context typed by the plugin's settings", () => {
    definePlugin({
      id: 'typed',
      version: '1.0.0',
      apiVersion: '^0.1',
      scopes: ['instance', 'user'],
      settings: {
        instance: z.object({ region: z.string().default('eu') }),
        user: z.object({ target: url(), retries: z.number().optional() }),
      },
      hooks: {
        'published.changed': {
          run: (_event, context) => {
            expectTypeOf(context.settings.region).toEqualTypeOf<string>();
            expectTypeOf(context.userSettings?.target).toEqualTypeOf<string | undefined>();
            expectTypeOf(context.userSettings?.retries).toEqualTypeOf<number | undefined>();
          },
        },
      },
    });
    definePlugin({
      id: 'plain',
      version: '1.0.0',
      apiVersion: '^0.1',
      scopes: ['instance'],
      hooks: {
        'digest.compose': {
          run: (_input, context) => {
            expectTypeOf(context.settings).toEqualTypeOf<Readonly<Record<string, never>>>();
            return null;
          },
        },
      },
    });
  });
});
