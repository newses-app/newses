import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      done();
    },
  });
  return { lines, logger: pino({ level: 'warn' }, stream) };
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let app: ReturnType<typeof buildApp> | undefined;

afterEach(async () => {
  await app?.close();
});

describe('request diagnostics', () => {
  it('logs slow requests with a state snapshot', async () => {
    const { lines, logger } = capture();
    app = buildApp({
      logger,
      healthChecks: { slow: () => wait(30) },
      diagnostics: { slowMs: 20, snapshot: () => ({ pool: { waiting: 3 } }) },
    });
    await app.inject({ method: 'GET', url: '/healthz' });
    expect(lines).toMatchObject([{ msg: 'Slow request', pool: { waiting: 3 } }]);
  });

  it('logs requests the client abandons before the response', async () => {
    const { lines, logger } = capture();
    app = buildApp({ logger, healthChecks: { slow: () => wait(300) } });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    await fetch(`http://127.0.0.1:${String(port)}/healthz`, {
      signal: AbortSignal.timeout(50),
    }).catch(() => undefined);
    await wait(400);
    expect(lines.map((l) => l.msg)).toContain(
      'Client closed the connection before the response was sent',
    );
  });
});
