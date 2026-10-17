import { useQueryClient } from '@tanstack/vue-query';
import { applyResourceOps, type ResourceOp } from '../lib/offline-resources.ts';
import { type Saved, sendOrQueue } from './sendOrQueue.ts';

/** The cached lists a change to preferences, feeds, labels, or themes shows in. */
const LISTS = ['prefs', 'subscriptions', 'categories', 'labels', 'themes'] as const;

/**
 * Changes to preferences, feeds, categories, labels, and themes: sent at once while the server can
 * be reached, otherwise kept in the outbox and shown in the cached lists (and so the store) until
 * sent. Callers apply what the server answers when it was sent.
 */
export function useResourceEdits() {
  const queryClient = useQueryClient();

  function showKept(op: ResourceOp): void {
    for (const name of LISTS)
      queryClient.setQueryData([name], (data: unknown) =>
        data === undefined ? data : applyResourceOps(name, data, [op]),
      );
  }

  async function edit<T>(op: ResourceOp, request: () => Promise<T>): Promise<Saved<T>> {
    const saved = await sendOrQueue([op], request);
    if (!saved.sent) showKept(op);
    return saved;
  }

  return { edit };
}
