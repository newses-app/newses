import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';

const logger = pino({ level: 'silent' });

describe('GET /healthz', () => {
  it('returns 200 when every check passes', async () => {
    const app = buildApp({
      logger,
      healthChecks: { db: () => Promise.resolve(), queue: () => Promise.resolve() },
    });
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', checks: { db: 'ok', queue: 'ok' } });
  });

  it('returns 503 and names the failing check', async () => {
    const app = buildApp({
      logger,
      healthChecks: {
        db: () => Promise.reject(new Error('down')),
        queue: () => Promise.resolve(),
      },
    });
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'error', checks: { db: 'error', queue: 'ok' } });
  });
});

describe('trustProxy', () => {
  it('takes the client address from the given number of proxy hops', async () => {
    const app = buildApp({ logger, healthChecks: {}, trustProxy: 2 });
    app.get('/ip', (request) => ({ ip: request.ip }));
    const response = await app.inject({
      url: '/ip',
      remoteAddress: '10.0.0.2',
      headers: { 'x-forwarded-for': '198.51.100.7, 203.0.113.9, 10.0.0.1' },
    });
    expect(response.json()).toEqual({ ip: '203.0.113.9' });
  });
});
