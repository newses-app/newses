import type { Subscription } from '@newses/shared';
import { ERROR_REASONS } from '@newses/shared/client';
import { describe, expect, it } from 'vitest';
import { i18n } from '../plugins/i18n.ts';
import en from '../locales/en.json';
import { failureText, feedErrorText } from './error-text.ts';

const { t } = i18n.global;
const text = (failure: Parameters<typeof failureText>[1]) => failureText(i18n.global, failure);

const leaves = (node: object, path = ''): [string, string][] =>
  Object.entries(node).flatMap(([key, value]: [string, string | object]) =>
    typeof value === 'string' ? [[`${path}${key}`, value]] : leaves(value, `${path}${key}.`),
  );

const placeholders = (message: string) =>
  [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();

describe('feedErrorText', () => {
  const error = (changes: Partial<Subscription>) =>
    feedErrorText(i18n.global, { lastError: null, ...changes } as Subscription);

  it("says a feed's error from its reason, in the reader's language", () => {
    const lastError = 'https://feed.example/ returned HTTP 500';
    const params = { url: 'https://feed.example/', status: '500' };
    expect(
      error({ lastError, lastErrorReason: 'fetch_http_status', lastErrorParams: params }),
    ).toBe('https://feed.example/ returned HTTP 500.');
  });

  it('falls back to the text for servers and errors with no reason', () => {
    expect(error({ lastError: 'Stored in English' })).toBe('Stored in English');
    expect(error({ lastError: 'Newer', lastErrorReason: 'from_the_future' })).toBe('Newer');
  });

  it('is empty for a feed without an error', () => {
    expect(error({})).toBe('');
  });
});

describe('failureText', () => {
  it('prefers the reason, with its params', () => {
    expect(
      text({
        code: 'conflict',
        message: 'In English',
        reason: 'label_name_taken',
        params: { name: 'News' },
      }),
    ).toBe('A label named "News" already exists.');
  });

  it('uses the code where it says all there is to say', () => {
    expect(text({ code: 'not_found', message: 'Label not found' })).toBe('That no longer exists.');
  });

  it("falls back to the code for a reason this app doesn't know", () => {
    expect(text({ code: 'not_found', message: 'New', reason: 'from_a_newer_server' })).toBe(
      'That no longer exists.',
    );
  });

  it.each(['invalid_input', 'conflict', 'fetch_failed', 'feed_not_found'])(
    "keeps an older server's message for %s, which says nothing by itself",
    (code) => {
      expect(text({ code, message: 'From the server' })).toBe('From the server');
    },
  );

  it('falls back to the message for a code this app does not know', () => {
    expect(text({ code: 'FST_ERR_SOMETHING', message: 'From Fastify' })).toBe('From Fastify');
  });

  it('says something when there is no message either', () => {
    expect(text({ code: 'unknown', message: '' })).toBe(en.errors.generic);
  });

  it('handles null reasons from a report stored as JSON', () => {
    expect(text({ code: 'conflict', message: 'Stored', reason: null })).toBe('Stored');
  });
});

describe('error messages', () => {
  const reasons: Record<string, string> = en.errors.reason;

  it('say every reason, with the params it declares', () => {
    for (const [reason, params] of Object.entries(ERROR_REASONS)) {
      expect(reasons[reason], reason).toBeDefined();
      expect(placeholders(reasons[reason] ?? ''), reason).toEqual([...params].sort());
    }
  });

  it('say no reason the API does not have', () => {
    expect(Object.keys(reasons).sort()).toEqual(Object.keys(ERROR_REASONS).sort());
  });
});

describe('en.json', () => {
  // A stray `@` throws where the message is shown, in production too, and most error messages are
  // shown from a catch block. A stray `|` cuts a message short, and an unclosed `{` empties it.
  it.each(leaves(en))('%s compiles', (key, message) => {
    const params = Object.fromEntries(placeholders(message).map((name) => [name, name]));
    const rendered = t(key, params);
    if (message.includes('|')) expect(rendered).not.toBe('');
    else expect(rendered).toBe(message.replace(/\{'(.)'\}/g, '$1').replace(/\{(\w+)\}/g, '$1'));
  });
});
