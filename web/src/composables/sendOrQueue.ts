import { connectivity } from '../offline/connectivity.ts';
import { failedToReach, type OutboxOp, queueChanges } from '../offline/outbox.ts';
import { flushRequests } from '../offline/status.ts';
import { requestOutboxSync } from '../offline/registration.ts';
import { currentStore } from '../offline/store.ts';
import { NATIVE } from '../platform/index.ts';
import { sessionVerified } from './useSession.ts';

export type Saved<T> = { sent: true; value: T } | { sent: false };

/**
 * Sends a change, or keeps it in the outbox: while the server cannot be reached, before the
 * session is confirmed, and behind changes already waiting, so they reach the server in order.
 * Throws when the server refuses it, or cannot be reached and there is no store to keep it in.
 */
export async function sendOrQueue<T>(
  ops: OutboxOp[],
  request: () => Promise<T>,
): Promise<Saved<T>> {
  const db = currentStore();
  if (!db) return { sent: true, value: await request() };
  if (connectivity.value === 'online' && sessionVerified.value && (await db.outbox.count()) === 0) {
    try {
      return { sent: true, value: await request() };
    } catch (error) {
      if (!failedToReach(error)) throw error;
    }
  }
  await queueChanges(db, ops);
  flushRequests.value++;
  // An installed browser app sends them when the connection returns, even with no tab open.
  if (!NATIVE) void requestOutboxSync();
  return { sent: false };
}
