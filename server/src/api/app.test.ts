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
