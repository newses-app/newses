import type { ApiClient, Entry, EntryState, MarkReadRequest } from '@newses/shared';
import { ApiError, normaliseTags } from '@newses/shared/client';
import { ref } from 'vue';
import { statePatch } from '../lib/entry-cache.ts';
import type { OfflineDb, OutboxRow } from './db.ts';

/** A change made on this device that the server does not have yet. */
export type OutboxOp =
  | { kind: 'state'; id: number; state: EntryState }
  | { kind: 'note'; id: number; note: string | null }
  | { kind: 'labels'; id: number; labelIds: number[] }
  | { kind: 'tags'; id: number; tags: string[] }
  | { kind: 'markRead'; request: MarkReadRequest };

type QueuedOp = OutboxOp & { seq: number; queuedAt: number };

/** Bulk `PATCH /entries` takes this many ids at most. */
const BULK_IDS = 1000;
/** Answers a proxy or load balancer gives while the server is down; the change waits. */
const GATEWAY_STATUSES = new Set([502, 503, 504]);

/** How many changes wait to be sent, for settings and sign-out. */
export const outboxPending = ref(0);

/** Bumped when changes are kept, so the running sync sends them as soon as it can. */
export const flushRequests = ref(0);

const toRow = ({ kind, ...payload }: OutboxOp, queuedAt: number): OutboxRow => ({
  kind,
  payload,
  queuedAt,
});

const fromRow = (row: OutboxRow): QueuedOp =>
  ({
    ...(row.payload as object),
    kind: row.kind,
    seq: row.seq ?? 0,
    queuedAt: row.queuedAt,
  }) as QueuedOp;

async function countPending(db: OfflineDb): Promise<number> {
  outboxPending.value = await db.outbox.count();
  return outboxPending.value;
}

export const loadPending = (db: OfflineDb) => countPending(db);

/**
 * Adds changes to the outbox, merged with the ones already waiting: one state change per entry
 * and flag between catch-ups (a catch-up keeps its place, so an entry marked unread after it stays
 * unread), and the latest note, labels, and tags of each entry.
 */
export async function queueChanges(
  db: OfflineDb,
  ops: readonly OutboxOp[],
  now = Date.now(),
): Promise<void> {
  await db.transaction('rw', db.outbox, async () => {
    const queued = (await db.outbox.orderBy('seq').toArray()).map(fromRow);
    const add = async (op: OutboxOp) => {
      queued.push({ ...op, seq: Number(await db.outbox.add(toRow(op, now))), queuedAt: now });
    };
    for (const op of ops) {
      if (op.kind === 'markRead') {
        await add(op);
        continue;
      }
      const lastCatchUp = queued.findLastIndex((q) => q.kind === 'markRead');
      const same = queued.findLastIndex(
        (q, i) =>
          q.kind === op.kind &&
          'id' in q &&
          q.id === op.id &&
          (op.kind !== 'state' || i > lastCatchUp),
      );
      const existing = queued[same];
      if (!existing) {
        await add(op);
        continue;
      }
      const merged: OutboxOp =
        op.kind === 'state' && existing.kind === 'state'
          ? { ...op, state: { ...existing.state, ...op.state } }
          : op;
      queued[same] = { ...merged, seq: existing.seq, queuedAt: existing.queuedAt };
      await db.outbox.put({ ...toRow(merged, existing.queuedAt), seq: existing.seq });
    }
  });
  await countPending(db);
}

/**
 * An entry with a waiting change applied, as the server will have it: read entries get a reading
 * time, unread ones lose it.
 */
export function withChange<T extends Pick<Entry, 'readAt'>>(
  entry: T,
  patch: Partial<Entry>,
  at: number,
): T {
  const readAt =
    patch.unread === true
      ? null
      : patch.unread === false
        ? (entry.readAt ?? new Date(at).toISOString())
        : entry.readAt;
  return { ...entry, ...patch, readAt };
}

/** The entry fields a change sets. */
export function changePatch(op: OutboxOp): Partial<Entry> {
  switch (op.kind) {
    case 'state':
      return statePatch(op.state);
    case 'note':
      return { note: op.note?.trim() || null };
    case 'labels':
      return { labels: [...new Set(op.labelIds)].sort((a, b) => a - b) };
    case 'tags':
      return { tags: normaliseTags(op.tags).sort() };
    case 'markRead':
      return {};
  }
}

/**
 * Entries with the changes still waiting for them applied, so a sync or a list loaded before the
 * outbox is sent does not show their old state.
 */
export async function withPending<T extends Entry>(
  db: OfflineDb,
  entries: readonly T[],
): Promise<T[]> {
  const queued = await db.outbox.toArray();
  if (queued.length === 0 || entries.length === 0) return [...entries];
  const byEntry = new Map<number, QueuedOp[]>();
  for (const op of queued.map(fromRow))
    if ('id' in op) byEntry.set(op.id, [...(byEntry.get(op.id) ?? []), op]);
  return entries.map((entry) =>
    (byEntry.get(entry.id) ?? []).reduce(
      (e, op) => withChange(e, changePatch(op), op.queuedAt),
      entry,
    ),
  );
}

/** The next request to send: a run of equal state changes in one bulk request, or one change. */
function nextBatch(queued: readonly QueuedOp[]): QueuedOp[] {
  const [first] = queued;
  if (first?.kind !== 'state') return first ? [first] : [];
  const key = JSON.stringify(first.state);
  const batch: QueuedOp[] = [];
  for (const op of queued) {
    if (op.kind === 'markRead' || batch.length === BULK_IDS) break;
    if (op.kind === 'state' && JSON.stringify(op.state) === key) batch.push(op);
  }
  return batch;
}

async function send(api: ApiClient, batch: readonly QueuedOp[]): Promise<void> {
  const [op] = batch;
  if (!op) return;
  switch (op.kind) {
    case 'state':
      if (batch.length === 1) await api.entries.update(op.id, op.state);
      else
        await api.entries.updateMany({
          ids: batch.map((b) => (b.kind === 'state' ? b.id : 0)),
          ...op.state,
        });
      return;
    case 'note':
      await api.entries.setNote(op.id, op.note);
      return;
    case 'labels':
      await api.entries.setLabels(op.id, op.labelIds);
      return;
    case 'tags':
      await api.entries.setTags(op.id, op.tags);
      return;
    case 'markRead':
      await api.entries.markRead(op.request);
      return;
  }
}

/** Whether a request failed for want of the server, rather than being refused by it. */
export const failedToReach = (error: unknown) =>
  !(error instanceof ApiError) || GATEWAY_STATUSES.has(error.status);

export interface FlushResult {
  sent: number;
  /** Changes the server refused, with its reason; they are not sent again. */
  refused: { op: OutboxOp; message: string }[];
  /**
   * Why sending stopped with changes left: the server could not be reached, the session ended, or
   * the server asked to wait this many seconds.
   */
  stopped: null | 'unreachable' | 'unauthenticated' | { retryAfterSeconds: number };
}

/**
 * Sends waiting changes, oldest first. A change the server cannot be reached for waits; one for an
 * entry that no longer exists goes; labels that no longer exist are left out and the rest sent
 * again; one the server refuses otherwise goes and is reported.
 */
export async function flushOutbox(api: ApiClient, db: OfflineDb): Promise<FlushResult> {
  const result: FlushResult = { sent: 0, refused: [], stopped: null };
  const relabelled = new Set<number>();
  for (;;) {
    const batch = nextBatch((await db.outbox.orderBy('seq').toArray()).map(fromRow));
    const [op] = batch;
    if (!op) break;
    try {
      await send(api, batch);
      result.sent += batch.length;
    } catch (error) {
      if (failedToReach(error) || !(error instanceof ApiError)) {
        result.stopped = 'unreachable';
        break;
      }
      if (error.status === 401) {
        result.stopped = 'unauthenticated';
        break;
      }
      if (error.status === 429) {
        result.stopped = { retryAfterSeconds: error.retryAfterSeconds ?? 60 };
        break;
      }
      if (error.status === 404 && op.kind === 'labels' && !relabelled.has(op.seq)) {
        // Either the entry or some of the labels are gone; try once with the labels that remain.
        relabelled.add(op.seq);
        const known = new Set((await api.labels.list()).map((l) => l.id));
        const labelIds = op.labelIds.filter((id) => known.has(id));
        if (labelIds.length < op.labelIds.length) {
          await db.outbox.update(op.seq, { payload: { id: op.id, labelIds } });
          continue;
        }
      } else if (error.status !== 404) {
        const { seq: _seq, queuedAt: _at, ...change } = op;
        result.refused.push({ op: change, message: error.message });
      }
    }
    await db.outbox.bulkDelete(batch.map((b) => b.seq));
  }
  await countPending(db);
  return result;
}
