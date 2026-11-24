import { describe, expect, it } from 'vitest';
import { blankItem, formFields, initialValues, pluginText, settingsChange } from './plugin-form.ts';

// As the server describes a webhook's user settings (zod's JSON Schema, input side).
const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    target: { type: 'string', format: 'uri', newses: { url: true, secret: true } },
    token: { type: 'string', minLength: 1, newses: { secret: true } },
    method: { type: 'string', enum: ['POST', 'PUT'], default: 'POST' },
    body: { type: 'string', newses: { multiline: true } },
    callback: { type: 'string', format: 'uri', newses: { url: true } },
    name: { type: 'string' },
    signed: { type: 'boolean', default: false },
    window: { type: 'integer', default: 2 },
    retries: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    headers: {
      type: 'array',
      default: [],
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, on: { type: 'boolean', default: true } },
        required: ['name'],
      },
    },
    extra: { type: 'object', properties: {} },
  },
  required: ['target', 'retries'],
};

const fields = formFields(schema);

describe('formFields', () => {
  it('picks how each setting is edited, in order', () => {
    expect(fields.map((f) => [f.name, f.kind])).toEqual([
      ['target', 'secret'],
      ['token', 'secret'],
      ['method', 'select'],
      ['body', 'multiline'],
      ['callback', 'url'],
      ['name', 'text'],
      ['signed', 'boolean'],
      ['window', 'number'],
      ['retries', 'number'],
      ['headers', 'list'],
      ['extra', 'unsupported'],
    ]);
    expect(fields.find((f) => f.name === 'method')?.options).toEqual(['POST', 'PUT']);
    expect(fields.find((f) => f.name === 'retries')).toMatchObject({
      required: true,
      nullable: true,
    });
    expect(fields.find((f) => f.name === 'window')).toMatchObject({ integer: true, default: 2 });
    expect(fields.find((f) => f.name === 'headers')?.item.map((f) => [f.name, f.kind])).toEqual([
      ['name', 'text'],
      ['on', 'boolean'],
    ]);
  });

  it("picks some of the user's feeds with a feeds field", () => {
    const feeds = formFields({
      type: 'object',
      properties: {
        only: {
          type: 'array',
          items: { type: 'integer', exclusiveMinimum: 0 },
          default: [],
          newses: { feeds: true },
        },
      },
    });
    expect(feeds.map((f) => [f.name, f.kind])).toEqual([['only', 'feeds']]);
    expect(initialValues(feeds, {})).toEqual({ only: [] });
    expect(initialValues(feeds, { only: [3, 'x', 0, 7] })).toEqual({ only: [3, 7] });
    expect(settingsChange(feeds, { only: [7, 2] }, {}, new Set())).toEqual({ only: [7, 2] });
  });

  it('has nothing for a scope without settings', () => {
    expect(formFields(null)).toEqual([]);
    expect(formFields({ type: 'string' })).toEqual([]);
  });

  it('cannot edit lists of lists or of secrets', () => {
    const nested = formFields({
      type: 'object',
      properties: {
        deep: {
          type: 'array',
          items: { type: 'object', properties: { inner: { type: 'array', items: {} } } },
        },
        tags: { type: 'array', items: { type: 'string' } },
      },
    });
    expect(nested.map((f) => f.kind)).toEqual(['unsupported', 'unsupported']);
  });
});

describe('pluginText', () => {
  const messages = {
    en: { name: 'Webhook', description: 'Calls a URL' },
    pt: { name: 'Gancho' },
    'pt-BR': { name: 'Gancho (BR)' },
  };

  it('takes the locale, its language, then English, then the fallback', () => {
    expect(pluginText(messages, 'pt-BR', 'name', 'webhook')).toBe('Gancho (BR)');
    expect(pluginText(messages, 'pt-PT', 'name', 'webhook')).toBe('Gancho');
    expect(pluginText(messages, 'pt-PT', 'description', '')).toBe('Calls a URL');
    expect(pluginText(messages, 'de', 'settings.token', 'token')).toBe('token');
  });
});

describe('initialValues and settingsChange', () => {
  const saved = {
    method: 'PUT',
    name: 'blog',
    headers: [{ name: 'X-Site', on: false }],
    extra: { a: 1 },
  };

  it('start from the saved settings, else defaults, with secrets empty', () => {
    expect(initialValues(fields, saved)).toEqual({
      target: '',
      token: '',
      method: 'PUT',
      body: '',
      callback: '',
      name: 'blog',
      signed: false,
      window: 2,
      retries: '',
      headers: [{ name: 'X-Site', on: false }],
      extra: { a: 1 },
    });
    const headers = fields.find((f) => f.name === 'headers');
    if (!headers) throw new Error('no headers field');
    expect(blankItem(headers)).toEqual({
      name: '',
      on: true,
    });
  });

  it('send plain settings, typed or cleared secrets only, and unsupported ones as saved', () => {
    const values = {
      ...initialValues(fields, saved),
      target: 'https://hooks.example/build',
      window: '5',
      headers: [
        { name: 'X-Site', on: true },
        { name: '', on: false },
      ],
    };
    expect(settingsChange(fields, values, saved, new Set(['token']))).toEqual({
      target: 'https://hooks.example/build',
      token: null,
      method: 'PUT',
      name: 'blog',
      signed: false,
      window: 5,
      retries: null,
      headers: [
        { name: 'X-Site', on: true },
        { name: '', on: false },
      ],
      extra: { a: 1 },
    });
  });
});
