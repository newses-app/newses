import { describe, expect, it } from 'vitest';
import { deriveKey } from '../core/crypto.ts';
import type { Blob } from '../core/ports.ts';
import { MemoryBlobStore, silentLogger, TEST_APP_SECRET } from '../test/fakes.ts';
import { MarkerRealtime } from './marker-realtime.ts';

const key = deriveKey(TEST_APP_SECRET, 'changes');
const text = (blob: Blob | undefined) => new TextDecoder().decode(blob?.data);

/** A store whose writes wait until released, to see what arrives meanwhile. */
class SlowStore extends MemoryBlobStore {
  writes = 0;
  release: () => void = () => undefined;

  override async put(key: string, blob: Blob): Promise<void> {
    this.writes++;
    await new Promise<void>((resolve) => (this.release = resolve));
    return super.put(key, blob);
  }
}

describe('MarkerRealtime', () => {
  it('writes a new marker each time, at a path signed for the user', async () => {
    const blobs = new MemoryBlobStore();
    const realtime = new MarkerRealtime(blobs, key, silentLogger);
    const path = realtime.changesPath(7);
    // An HMAC: no one can find another user's marker from their id.
    expect(path).toMatch(/^\/changes\/[\w-]{43}$/);
    expect(realtime.changesPath(8)).not.toBe(path);
    expect(
      new MarkerRealtime(
        blobs,
        deriveKey(`${TEST_APP_SECRET}!`, 'changes'),
        silentLogger,
      ).changesPath(7),
    ).not.toBe(path);

    await realtime.publish(7);
    const first = text(blobs.blobs.get(path.slice(1)));
    await realtime.publish(7);
    expect(text(blobs.blobs.get(path.slice(1)))).not.toBe(first);
    expect(blobs.blobs.get(path.slice(1))?.contentType).toBe('text/plain');
  });

  it('writes once more for events while a write is in flight', async () => {
    const blobs = new SlowStore();
    const realtime = new MarkerRealtime(blobs, key, silentLogger);
    const done = realtime.publish(1);
    void realtime.publish(1);
    void realtime.publish(1);
    await Promise.resolve();
    blobs.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    blobs.release();
    await done;
    expect(blobs.writes).toBe(2);
  });

  it('never fails the event', async () => {
    const blobs = new MemoryBlobStore();
    blobs.put = () => Promise.reject(new Error('S3 is down'));
    await expect(new MarkerRealtime(blobs, key, silentLogger).publish(1)).resolves.toBeUndefined();
  });
});
