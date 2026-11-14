import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerClients } from './push-worker.ts';
import { OUTBOX_TAG, SYNC_TAG } from './worker-config.ts';
import {
  isFeedIcon,
  isFont,
  NOT_APP_SHELL,
  onNotificationClick,
  onPeriodicSync,
  onPush,
  onSync,
} from './worker-events.ts';

const runInBackground = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve()),
);
const showPushMessage = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve()),
);
const openPushTarget = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve()),
);
vi.mock('./background.ts', () => ({ runInBackground }));
vi.mock('./push-worker.ts', () => ({ showPushMessage, openPushTarget }));

/** An event whose `waitUntil` work the test can await. */
function waiting<T extends object>(fields: T) {
  const work: Promise<unknown>[] = [];
  return {
    ...fields,
    work,
    waitUntil: (promise: Promise<unknown>) => void work.push(promise),
    done: () => Promise.allSettled(work),
  };
}

const clients = {} as WorkerClients;
const registration = {} as Parameters<typeof onPush>[1];

afterEach(() => {
  vi.clearAllMocks();
});

describe('routes', () => {
  it.each([
    ['/', true],
    ['/all', true],
    ['/settings/feeds', true],
    ['/apis', true],
    ['/api', false],
    ['/api/v1/entries', false],
    ['/public/share/abc', false],
    ['/public.php', false],
    ['/healthz', false],
    ['/accounts/ClientLogin', false],
    ['/reader/api/0/stream', false],
    ['/feed-icons/1.ico', false],
    ['/favicons/abc.png', false],
    ['/downloads/', false],
  ])('%s gets the app shell: %s', (path, shell) => {
    expect(NOT_APP_SHELL.some((pattern) => pattern.test(path))).toBe(!shell);
  });

  it('caches fonts and same-origin feed icons', () => {
    expect(isFont({ request: { destination: 'font' } })).toBe(true);
    expect(isFont({ request: { destination: 'image' } })).toBe(false);
    const icon = new URL('https://reader.example/favicons/abc.png');
    expect(isFeedIcon({ url: icon, sameOrigin: true })).toBe(true);
    expect(isFeedIcon({ url: icon, sameOrigin: false })).toBe(false);
    expect(isFeedIcon({ url: new URL('https://reader.example/all'), sameOrigin: true })).toBe(
      false,
    );
  });
});

describe('sync events', () => {
  it('syncs on its periodic tag, ignoring failures, and nothing on others', async () => {
    runInBackground.mockRejectedValueOnce(new Error('offline'));
    const event = waiting({ tag: SYNC_TAG });
    onPeriodicSync(event);
    await expect(Promise.all(event.work)).resolves.toBeDefined();
    expect(runInBackground).toHaveBeenCalledWith('sync');

    const other = waiting({ tag: 'other' });
    onPeriodicSync(other);
    expect(other.work).toEqual([]);
  });

  it('sends kept changes on its tag, failing so the browser tries again', async () => {
    runInBackground.mockRejectedValueOnce(new Error('offline'));
    const event = waiting({ tag: OUTBOX_TAG });
    onSync(event);
    await expect(Promise.all(event.work)).rejects.toThrow('offline');
    expect(runInBackground).toHaveBeenCalledWith('outbox');

    const other = waiting({ tag: SYNC_TAG });
    onSync(other);
    expect(other.work).toEqual([]);
  });
});

describe('push events', () => {
  it('shows the message, then syncs', async () => {
    const order: string[] = [];
    showPushMessage.mockImplementationOnce(() => {
      order.push('show');
      return Promise.resolve();
    });
    runInBackground.mockImplementationOnce(() => {
      order.push('sync');
      return Promise.reject(new Error('offline'));
    });
    const event = waiting({ data: { json: () => ({ type: 'new-entries' }) } });
    onPush(event, registration, clients);
    await expect(Promise.all(event.work)).resolves.toBeDefined();
    expect(showPushMessage).toHaveBeenCalledWith(registration, clients, { type: 'new-entries' });
    expect(order).toEqual(['show', 'sync']);
  });

  it('passes nothing to show for a push that is not JSON, or has no data', async () => {
    const event = waiting({
      data: {
        json: () => {
          throw new SyntaxError('Unexpected token');
        },
      },
    });
    onPush(event, registration, clients);
    onPush(waiting({ data: null }), registration, clients);
    await event.done();
    expect(showPushMessage.mock.calls.map(([, , data]) => data)).toEqual([null, undefined]);
    expect(runInBackground).toHaveBeenCalledTimes(2);
  });

  it("opens a clicked notification's stream", async () => {
    const notification = { data: null, close: () => undefined };
    const event = waiting({ notification });
    onNotificationClick(event, clients);
    await event.done();
    expect(openPushTarget).toHaveBeenCalledWith(notification, clients);
  });
});
