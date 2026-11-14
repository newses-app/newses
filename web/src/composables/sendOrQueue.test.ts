import { ApiError } from '@newses/shared/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutboxOp } from '../offline/outbox.ts';
import { flushRequests } from '../offline/status.ts';
import { connectivity } from '../test/connectivity.ts';
import { sendOrQueue } from './sendOrQueue.ts';
import { sessionVerified } from './useSession.ts';

const store = vi.hoisted(() => ({
  db: null as { outbox: { count: () => Promise<number> } } | null,
}));
const queueChanges = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const requestOutboxSync = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('../offline/store.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  currentStore: () => store.db,
}));
vi.mock('../offline/outbox.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  queueChanges,
}));
vi.mock('../offline/registration.ts', () => ({ requestOutboxSync }));
vi.mock('../offline/connectivity.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../test/connectivity.ts')),
}));

const ops: OutboxOp[] = [{ kind: 'label.delete', id: 3 }];
let waiting: number;

beforeEach(() => {
  waiting = 0;
  store.db = { outbox: { count: () => Promise.resolve(waiting) } };
  connectivity.value = 'online';
  sessionVerified.value = true;
  flushRequests.value = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('sendOrQueue', () => {
  it('sends without a store, and lets a failure through', async () => {
    store.db = null;
    connectivity.value = 'offline';
    await expect(sendOrQueue(ops, () => Promise.resolve(1))).resolves.toEqual({
      sent: true,
      value: 1,
    });
    await expect(sendOrQueue(ops, () => Promise.reject(new TypeError('down')))).rejects.toThrow(
      'down',
    );
    expect(queueChanges).not.toHaveBeenCalled();
  });

  it('sends while online, verified, and with nothing waiting', async () => {
    const request = vi.fn(() => Promise.resolve('ok'));
    await expect(sendOrQueue(ops, request)).resolves.toEqual({ sent: true, value: 'ok' });
    expect(request).toHaveBeenCalledOnce();
    expect(queueChanges).not.toHaveBeenCalled();
  });

  it.each([
    ['offline', () => (connectivity.value = 'offline')],
    ['unverified', () => (sessionVerified.value = false)],
    ['behind waiting changes', () => (waiting = 2)],
  ])('keeps the change when %s, without sending it', async (_, given) => {
    given();
    const request = vi.fn(() => Promise.resolve('ok'));
    await expect(sendOrQueue(ops, request)).resolves.toEqual({ sent: false });
    expect(request).not.toHaveBeenCalled();
    expect(queueChanges).toHaveBeenCalledWith(store.db, ops);
    expect(flushRequests.value).toBe(1);
    expect(requestOutboxSync).toHaveBeenCalledOnce();
  });

  it('keeps the change when the server cannot be reached', async () => {
    const saved = await sendOrQueue(ops, () => Promise.reject(new TypeError('Failed to fetch')));
    expect(saved).toEqual({ sent: false });
    expect(queueChanges).toHaveBeenCalledWith(store.db, ops);
  });

  it('throws when the server refuses the change', async () => {
    const refused = new ApiError(422, 'invalid', 'No', null);
    await expect(sendOrQueue(ops, () => Promise.reject(refused))).rejects.toBe(refused);
    expect(queueChanges).not.toHaveBeenCalled();
  });
});
