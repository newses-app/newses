import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import { binaryResponse, createApiHandler } from './api-handler.ts';

const event = (headers: Record<string, string> = {}) =>
  ({ headers, rawPath: '/api/v1/feeds' }) as unknown as APIGatewayProxyEventV2;
const context = {} as Context;

function setup(used: boolean) {
  const order: string[] = [];
  let usedDatabase = used;
  const deps = {
    proxy: vi.fn(() => {
      order.push('proxy');
      return Promise.resolve({ statusCode: 200, body: '[]' });
    }),
    originSecret: 'origin-secret',
    database: {
      used: () => usedDatabase,
      reset: () => {
        order.push('reset');
        usedDatabase = false;
      },
    },
    flush: vi.fn(() => {
      order.push('flush');
      return Promise.resolve();
    }),
  };
  return { deps, order, handler: createApiHandler(deps) };
}

describe('createApiHandler', () => {
  it.each([
    ['no origin secret', {}],
    ['a wrong one', { 'x-origin-verify': 'origin-secreT' }],
    ['one of another length', { 'x-origin-verify': 'origin' }],
  ])('refuses a request with %s, which bypassed CloudFront', async (_case, headers) => {
    const { deps, handler } = setup(true);
    expect(await handler(event(headers), context)).toEqual({ statusCode: 403, body: '' });
    expect(deps.proxy).not.toHaveBeenCalled();
  });

  it('answers through the app, then writes the statistics when the database was used', async () => {
    const { deps, order, handler } = setup(true);
    const request = event({ 'x-origin-verify': 'origin-secret' });
    expect(await handler(request, context)).toEqual({ statusCode: 200, body: '[]' });
    expect(deps.proxy).toHaveBeenCalledWith(request, context);
    expect(order).toEqual(['proxy', 'flush', 'reset']);
  });

  it('opens no connection for statistics after a request that used no database', async () => {
    const { deps, handler } = setup(false);
    await handler(event({ 'x-origin-verify': 'origin-secret' }), context);
    expect(deps.flush).not.toHaveBeenCalled();
  });
});

describe('binaryResponse', () => {
  it('encodes images and compressed bodies, and leaves JSON and text plain', () => {
    expect(binaryResponse({ headers: { 'content-type': 'image/png' } })).toBe(true);
    expect(
      binaryResponse({ headers: { 'content-type': 'text/css', 'content-encoding': 'br' } }),
    ).toBe(true);
    expect(binaryResponse({ headers: { 'content-type': 'application/json' } })).toBe(false);
    expect(binaryResponse({ headers: {} })).toBe(false);
  });
});
