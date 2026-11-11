import { createECDH } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { silentLogger } from '../test/fakes.ts';
import { WebPushSender } from './web-push-sender.ts';

let server: Server;
let base: string;
const seen: { path: string; headers: IncomingHttpHeaders; bytes: number }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let bytes = 0;
    req.on('data', (chunk: Buffer) => (bytes += chunk.byteLength));
    req.on('end', () => {
      seen.push({ path: req.url ?? '/', headers: req.headers, bytes });
      const status = Number(/^\/(\d{3})$/.exec(req.url ?? '')?.[1] ?? 201);
      res.writeHead(status).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(() => {
  server.close();
});

const device = createECDH('prime256v1');
device.generateKeys();
const target = (path: string) => ({
  endpoint: `${base}${path}`,
  p256dh: device.getPublicKey().toString('base64url'),
  auth: Buffer.alloc(16, 1).toString('base64url'),
});
const sender = (allowPrivateNetworks: boolean | string[] = ['127.0.0.0/8']) =>
  new WebPushSender({
    seed: Buffer.alloc(32, 3),
    subject: 'https://reader.example',
    allowPrivateNetworks,
    logger: silentLogger,
  });
const options = { ttlSeconds: 600, topic: 'new-entries' };

describe('WebPushSender', () => {
  it('posts an encrypted message signed with the VAPID key', async () => {
    const push = sender();
    expect(await push.send(target('/send/a'), '{"n":1}', options)).toBe('sent');
    await push.close();

    const request = seen.at(-1);
    expect(request?.path).toBe('/send/a');
    expect(request?.headers).toMatchObject({
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: '600',
      topic: 'new-entries',
      urgency: 'normal',
    });
    expect(request?.headers.authorization).toMatch(
      new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${push.publicKey}$`),
    );
    // Header (21 bytes and the sender's 65-byte key), payload, delimiter, and tag.
    expect(request?.bytes).toBe(86 + 7 + 1 + 16);
  });

  it('tells subscriptions that are gone from other refusals', async () => {
    const push = sender();
    expect(await push.send(target('/404'), '{}', options)).toBe('gone');
    expect(await push.send(target('/410'), '{}', options)).toBe('gone');
    expect(await push.send(target('/429'), '{}', options)).toBe('failed');
    expect(await push.send(target('/500'), '{}', options)).toBe('failed');
    await push.close();
  });

  it('never reaches private addresses unless they are allowed', async () => {
    const push = sender(false);
    const before = seen.length;
    expect(await push.send(target('/send/b'), '{}', options)).toBe('failed');
    expect(
      await push.send(
        { ...target('/'), endpoint: `http://localhost:${new URL(base).port}/send/c` },
        '{}',
        options,
      ),
    ).toBe('failed');
    expect(seen).toHaveLength(before);
    await push.close();
  });
});
