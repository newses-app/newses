import type {
  ApiClient,
  CreateThemeRequest,
  Entry,
  EntryState,
  MarkReadRequest,
} from '@newses/shared';
import { ApiError, normaliseTags } from '@newses/shared/client';
import { statePatch } from '../lib/entry-cache.ts';
import {
  applyResourceOps,
  isCreate,
  isResourceOp,
  isTemporary,
  refersTo,
  remapIds,
  type Resource,
  type ResourceOp,
  resourceOf,
} from '../lib/offline-resources.ts';
import { uniqueName } from '../lib/theme-files.ts';
import type { OfflineDb, OutboxRow } from './db.ts';

/**
 * A change made on this device that the server does not have yet, with what the entry had before
 * (`expect`, `expected`, `base`), so a server that detects conflicts keeps changes made elsewhere
 * since.
 */
export type EntryOp =
  | { kind: 'state'; id: number; state: EntryState; expect?: EntryState }
  | { kind: 'note'; id: number; note: string | null; expected?: string | null }
  | { kind: 'labels'; id: number; labelIds: number[]; base?: number[] }
  | { kind: 'tags'; id: number; tags: string[]; base?: string[] }
  | { kind: 'markRead'; request: MarkReadRequest };

/** Article changes, and changes to preferences, feeds, categories, labels, and themes. */
export type OutboxOp = EntryOp | ResourceOp;

const ENTRY_KINDS: ReadonlySet<string> = new Set(['state', 'note', 'labels', 'tags']);

/** A note changed both here and elsewhere: the reader picks one. */
export interface NoteConflict {
  id: number;
  mine: string | null;
  theirs: string | null;
}

type QueuedOp = OutboxOp & { seq: number; queuedAt: number };

/** Bulk `PATCH /entries` takes this many ids at most. */
const BULK_IDS = 1000;
/** Answers a proxy or load balancer gives while the server is down; the change waits. */
const GATEWAY_STATUSES = new Set([502, 503, 504]);

/** Hears how many changes wait after each change to the outbox; the page keeps it reactive. */
let reportCount: (pending: number) => void = () => undefined;
export function onPendingCount(listener: (pending: number) => void): void {
  reportCount = listener;
}

/** A change as stored; a queued change's own place and time stay out of its payload. */
const toRow = (op: OutboxOp, queuedAt: number): OutboxRow => {
  const { kind, seq: _seq, queuedAt: _at, ...payload } = op as OutboxOp & Partial<QueuedOp>;
  return { kind, payload, queuedAt };
};

const fromRow = (row: OutboxRow): QueuedOp =>
  ({
    ...(row.payload as object),
    kind: row.kind,
    seq: row.seq ?? 0,
    queuedAt: row.queuedAt,
  }) as QueuedOp;

async function countPending(db: OfflineDb): Promise<number> {
  const pending = await db.outbox.count();
  reportCount(pending);
  return pending;
}

export const loadPending = (db: OfflineDb) => countPending(db);

/** Whether two changes are to the same thing: the same entry or object, or both preferences. */
const sameSubject = (a: OutboxOp, b: OutboxOp) =>
  a.kind === b.kind && ('id' in a && 'id' in b ? a.id === b.id : !('id' in a) && !('id' in b));

/**
 * Adds changes to the outbox, merged with the ones already waiting: one state change per entry
 * and flag between catch-ups (a catch-up keeps its place, so an entry marked unread after it stays
 * unread), the latest note, labels, and tags of each entry, and one update per object and
 * preference. Nothing merges into a change queued before something was created, so changes that
 * name a new object are sent after it. Deleting an object created offline forgets it instead.
 */
export async function queueChanges(
  db: OfflineDb,
  ops: readonly OutboxOp[],
  now = Date.now(),
): Promise<void> {
  await db.transaction('rw', db.outbox, async () => {
    let queued = (await db.outbox.orderBy('seq').toArray()).map(fromRow);
    const add = async (op: OutboxOp) => {
      queued.push({ ...op, seq: Number(await db.outbox.add(toRow(op, now))), queuedAt: now });
    };
    for (const op of ops) {
      if (op.kind === 'markRead' || isCreate(op)) {
        await add(op);
        continue;
      }
      if (isResourceOp(op) && op.kind.endsWith('.delete') && 'id' in op && isTemporary(op.id)) {
        queued = await forgetCreated(db, queued, op);
        continue;
      }
      const lastCatchUp = queued.findLastIndex((q) => q.kind === 'markRead');
      const lastCreate = queued.findLastIndex((q) => isCreate(q));
      const same = queued.findLastIndex(
        (q, i) => sameSubject(q, op) && (op.kind === 'state' ? i > lastCatchUp : i > lastCreate),
      );
      const existing = queued[same];
      if (!existing) {
        await add(op);
        continue;
      }
      const merged = mergeChange(existing, op);
      queued[same] = { ...merged, seq: existing.seq, queuedAt: existing.queuedAt };
      await db.outbox.put({ ...toRow(merged, existing.queuedAt), seq: existing.seq });
    }
  });
  await countPending(db);
}

/**
 * A waiting change once an object created offline is gone (deleted before it was sent, or refused
 * by the server): feeds and subcategories in a category go to its parent, entries lose a label, and
 * a theme in use falls back to Original. Null for changes to the object itself or that need it.
 */
function withoutObject(
  q: QueuedOp,
  resource: Resource,
  id: number,
  parentId: number | null,
): QueuedOp | null {
  if (isResourceOp(q) && resourceOf(q) === resource && 'id' in q && q.id === id) return null;
  let next: QueuedOp = q;
  if (resource === 'category') next = remapIds(q, 'category', id, parentId);
  else if (resource === 'label' && q.kind === 'labels')
    next = {
      ...q,
      labelIds: q.labelIds.filter((l) => l !== id),
      ...(q.base && { base: q.base.filter((l) => l !== id) }),
    };
  else if (resource === 'theme' && q.kind === 'prefs' && q.changes.appearanceTheme === id)
    next = { ...q, changes: { ...q.changes, appearanceTheme: 'original' } };
  return refersTo(next, resource, id) ? null : next;
}

/** Applies `withoutObject` to the waiting changes in the store; returns those left. */
async function dropObject(
  db: OfflineDb,
  queued: readonly QueuedOp[],
  resource: Resource,
  id: number,
  parentId: number | null,
): Promise<QueuedOp[]> {
  const kept: QueuedOp[] = [];
  for (const q of queued) {
    const next = withoutObject(q, resource, id, parentId);
    if (!next) await db.outbox.delete(q.seq);
    else {
      if (next !== q) await db.outbox.put({ ...toRow(next, q.queuedAt), seq: q.seq });
      kept.push(next);
    }
  }
  return kept;
}

/** Forgets an object created offline and deleted before it was sent, with the changes to it. */
function forgetCreated(
  db: OfflineDb,
  queued: QueuedOp[],
  deletion: ResourceOp & { id: number },
): Promise<QueuedOp[]> {
  const resource = resourceOf(deletion);
  if (!resource) return Promise.resolve(queued);
  const parentId = deletion.kind === 'category.delete' ? deletion.parentId : null;
  return dropObject(db, queued, resource, deletion.id, parentId);
}

/** A later change to the same entry merged into a waiting one, keeping what the entry had first. */
function mergeChange(existing: OutboxOp, op: OutboxOp): OutboxOp {
  if (op.kind === 'prefs' && existing.kind === 'prefs')
    return { ...op, changes: { ...existing.changes, ...op.changes } };
  if (isResourceOp(op) && isResourceOp(existing) && 'changes' in op && 'changes' in existing)
    return { ...op, changes: { ...existing.changes, ...op.changes } } as OutboxOp;
  if (op.kind === 'state' && existing.kind === 'state') {
    const expect = existing.expect || op.expect ? { ...op.expect, ...existing.expect } : undefined;
    return { ...op, state: { ...existing.state, ...op.state }, ...(expect && { expect }) };
  }
  if (op.kind === 'note' && existing.kind === 'note' && existing.expected !== undefined)
    return { ...op, expected: existing.expected };
  if (
    (op.kind === 'labels' && existing.kind === 'labels') ||
    (op.kind === 'tags' && existing.kind === 'tags')
  )
    return existing.base ? ({ ...op, base: existing.base } as OutboxOp) : op;
  return op;
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
    default:
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
    if (ENTRY_KINDS.has(op.kind) && 'id' in op)
      byEntry.set(op.id, [...(byEntry.get(op.id) ?? []), op]);
  return entries.map((entry) =>
    (byEntry.get(entry.id) ?? []).reduce(
      (e, op) => withChange(e, changePatch(op), op.queuedAt),
      entry,
    ),
  );
}

/** A snapshot query's data with the waiting changes to preferences, feeds, labels, or themes. */
export async function withPendingResources<T>(db: OfflineDb, name: string, data: T): Promise<T> {
  const queued = (await db.outbox.orderBy('seq').toArray()).map(fromRow);
  return applyResourceOps(
    name,
    data,
    queued.filter((q): q is QueuedOp & ResourceOp => isResourceOp(q)),
  );
}

/** The next request to send: a run of equal state changes in one bulk request, or one change. */
function nextBatch(queued: readonly QueuedOp[], conflicts: boolean): QueuedOp[] {
  const [first] = queued;
  if (first?.kind !== 'state') return first ? [first] : [];
  const keyOf = (op: QueuedOp & { kind: 'state' }) =>
    JSON.stringify([op.state, conflicts ? op.expect : null]);
  const key = keyOf(first);
  const batch: QueuedOp[] = [];
  for (const op of queued) {
    if (op.kind === 'markRead' || batch.length === BULK_IDS) break;
    if (op.kind === 'state' && keyOf(op) === key) batch.push(op);
  }
  return batch;
}

const without = <T>(list: readonly T[], gone: readonly T[]) =>
  list.filter((item) => !gone.includes(item));

/** Sends a batch; with `conflicts`, as changes against what the entry had before. */
/** Sends one change to preferences, feeds, labels, or themes; resolves to what a create made. */
async function sendResource(api: ApiClient, op: ResourceOp): Promise<{ id: number } | undefined> {
  switch (op.kind) {
    case 'prefs':
      await api.prefs.update(op.changes);
      return;
    case 'category.create':
      return api.categories.create(op.body);
    case 'category.update':
      await api.categories.update(op.id, op.changes);
      return;
    case 'category.delete':
      await api.categories.delete(op.id);
      return;
    case 'categories.collapse':
      await api.categories.updateAll({ collapsed: op.collapsed });
      return;
    case 'subscription.create': {
      const answer = await api.subscriptions.subscribe(op.body);
      // The page offers several feeds: only the reader can pick one.
      if (answer.status === 'choose')
        throw new ApiError(422, 'choose', 'The page offers several feeds', null);
      return answer.subscription;
    }
    case 'subscription.update':
      await api.subscriptions.update(op.id, op.changes);
      return;
    case 'subscription.delete':
      await api.subscriptions.unsubscribe(op.id);
      return;
    case 'label.create':
      return api.labels.create(op.body);
    case 'label.update':
      await api.labels.update(op.id, op.changes);
      return;
    case 'label.delete':
      await api.labels.delete(op.id);
      return;
    case 'theme.create':
      return api.themes.create(op.body);
    case 'theme.update':
      await api.themes.update(op.id, op.changes);
      return;
    case 'theme.delete':
      await api.themes.delete(op.id);
      return;
  }
}

async function send(
  api: ApiClient,
  batch: readonly QueuedOp[],
  conflicts: boolean,
  result: FlushResult,
): Promise<{ id: number } | undefined> {
  const [op] = batch;
  if (!op) return;
  if (isResourceOp(op)) return sendResource(api, op);
  switch (op.kind) {
    case 'state': {
      const ids = batch.map((b) => (b.kind === 'state' ? b.id : 0));
      if (conflicts && op.expect) {
        const answer = await api.entries.updateMany({ ids, ...op.state, expect: op.expect });
        result.overridden += answer.conflicts?.length ?? 0;
      } else if (batch.length === 1) await api.entries.update(op.id, op.state);
      else await api.entries.updateMany({ ids, ...op.state });
      return;
    }
    case 'note':
      if (!conflicts || op.expected === undefined) {
        await api.entries.setNote(op.id, op.note);
        return;
      }
      try {
        await api.entries.setNote(op.id, op.note, op.expected);
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 409)) throw error;
        const { note } = await api.entries.get(op.id);
        result.noteConflicts.push({ id: op.id, mine: op.note?.trim() || null, theirs: note });
      }
      return;
    case 'labels':
      if (conflicts && op.base)
        await api.entries.changeLabels(op.id, {
          add: without(op.labelIds, op.base),
          remove: without(op.base, op.labelIds),
        });
      else await api.entries.setLabels(op.id, op.labelIds);
      return;
    case 'tags':
      if (conflicts && op.base) {
        const tags = normaliseTags(op.tags);
        const base = normaliseTags(op.base);
        await api.entries.changeTags(op.id, {
          add: without(tags, base),
          remove: without(base, tags),
        });
      } else await api.entries.setTags(op.id, op.tags);
      return;
    case 'markRead':
      await api.entries.markRead(op.request);
      return;
  }
}

/**
 * Whether a request failed for want of the server, rather than being refused by it. A feed the
 * server could not fetch is the server's answer, though it comes as 502 too.
 */
export const failedToReach = (error: unknown) =>
  !(error instanceof ApiError) ||
  (GATEWAY_STATUSES.has(error.status) && error.code !== 'fetch_failed');

/** Something created offline: its temporary id, and what the server made of it. */
export interface Created {
  resource: Resource;
  tempId: number;
  value: { id: number };
}

export interface FlushResult {
  sent: number;
  /** Changes not applied because the entry changed elsewhere since; the newer values stay. */
  overridden: number;
  /** Notes changed both here and elsewhere, for the reader to settle. */
  noteConflicts: NoteConflict[];
  /** Changes the server refused, with its reason; they are not sent again. */
  refused: { op: OutboxOp; code: string; message: string }[];
  /** Objects created offline that the server now has, under its ids. */
  created: Created[];
  /** Objects created offline that the server refused; changes to them were dropped too. */
  dropped: { resource: Resource; tempId: number }[];
  /** Themes created offline that the server refused, kept for the reader to fix or export. */
  themeDrafts: CreateThemeRequest[];
  /**
   * Why sending stopped with changes left: the server could not be reached, the session ended, or
   * the server asked to wait this many seconds.
   */
  stopped: null | 'unreachable' | 'unauthenticated' | { retryAfterSeconds: number };
}

/**
 * Sends waiting changes, oldest first. A change the server cannot be reached for waits; one for an
 * entry that no longer exists goes; labels that no longer exist are left out and the rest sent
 * again; one the server refuses otherwise goes and is reported. With `conflicts` (API 1.2), each
 * change applies only where the entry still has what this device saw, labels and tags as added and
 * removed, and a note changed elsewhere too is reported.
 */
export async function flushOutbox(
  api: ApiClient,
  db: OfflineDb,
  { conflicts = false } = {},
): Promise<FlushResult> {
  const result: FlushResult = {
    sent: 0,
    overridden: 0,
    noteConflicts: [],
    refused: [],
    created: [],
    dropped: [],
    themeDrafts: [],
    stopped: null,
  };
  const relabelled = new Set<number>();
  const renamed = new Set<number>();
  for (;;) {
    const batch = nextBatch((await db.outbox.orderBy('seq').toArray()).map(fromRow), conflicts);
    const [op] = batch;
    if (!op) break;
    try {
      const made = await send(api, batch, conflicts, result);
      result.sent += batch.length;
      if (made && isResourceOp(op) && isCreate(op) && 'id' in op) {
        await db.outbox.bulkDelete(batch.map((b) => b.seq));
        await adopt(db, result, op, made);
        continue;
      }
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
      if (isResourceOp(op)) {
        const outcome = await refusedResource(api, db, result, op, error, renamed);
        if (outcome === 'retry') continue;
      } else if (error.status === 404 && op.kind === 'labels' && !relabelled.has(op.seq)) {
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
        result.refused.push({ op: change, code: error.code, message: error.message });
      }
    }
    await db.outbox.bulkDelete(batch.map((b) => b.seq));
  }
  await countPending(db);
  return result;
}

/** Points waiting changes, and stored entries' labels, at the id the server gave a new object. */
async function adopt(
  db: OfflineDb,
  result: FlushResult,
  op: ResourceOp & { id: number },
  made: { id: number },
): Promise<void> {
  const resource = resourceOf(op);
  if (!resource) return;
  for (const row of (await db.outbox.toArray()).map(fromRow)) {
    const next = remapIds(row, resource, op.id, made.id);
    if (JSON.stringify(next) !== JSON.stringify(row))
      await db.outbox.put({ ...toRow(next, row.queuedAt), seq: row.seq });
  }
  if (resource === 'label')
    await db.entries
      .where('labels')
      .equals(op.id)
      .modify((entry) => {
        entry.labels = entry.labels.map((id) => (id === op.id ? made.id : id));
      });
  result.created.push({ resource, tempId: op.id, value: made });
}

/**
 * Settles a change to preferences, feeds, labels, or themes that the server refused: a theme name
 * taken meanwhile gets a number and is sent again; a label created offline that exists already is
 * that label; a change to something gone is dropped. A refused create drops the changes to what it
 * would have made, and a theme is kept as a draft.
 */
async function refusedResource(
  api: ApiClient,
  db: OfflineDb,
  result: FlushResult,
  op: QueuedOp & ResourceOp,
  error: ApiError,
  renamed: Set<number>,
): Promise<'retry' | 'settled'> {
  const change: ResourceOp = op;
  const name =
    change.kind === 'theme.create'
      ? change.body.name
      : change.kind === 'theme.update'
        ? change.changes.name
        : undefined;
  if (error.status === 409 && name !== undefined && !renamed.has(op.seq)) {
    renamed.add(op.seq);
    const taken = (await api.themes.list()).filter((t) => t.mine).map((t) => t.name);
    const fresh = uniqueName(name, taken);
    const next: OutboxOp =
      change.kind === 'theme.create'
        ? { ...change, body: { ...change.body, name: fresh } }
        : change.kind === 'theme.update'
          ? { ...change, changes: { ...change.changes, name: fresh } }
          : change;
    await db.outbox.put({ ...toRow(next, op.queuedAt), seq: op.seq });
    return 'retry';
  }
  if (error.status === 409 && op.kind === 'label.create') {
    const caption = op.body.caption.trim().toLowerCase();
    const existing = (await api.labels.list()).find((l) => l.caption.toLowerCase() === caption);
    if (existing) {
      await db.outbox.delete(op.seq);
      await adopt(db, result, op, existing);
      return 'retry';
    }
  }
  const { seq: _seq, queuedAt: _at, ...refused } = op;
  if (isCreate(op) && 'id' in op) {
    const resource = resourceOf(op);
    if (resource) {
      const parentId = change.kind === 'category.create' ? (change.body.parentId ?? null) : null;
      const others = (await db.outbox.orderBy('seq').toArray())
        .map(fromRow)
        .filter((row) => row.seq !== op.seq);
      await dropObject(db, others, resource, op.id, parentId);
      result.dropped.push({ resource, tempId: op.id });
    }
    if (change.kind === 'theme.create') result.themeDrafts.push(change.body);
  } else if (error.status === 404) return 'settled';
  result.refused.push({ op: refused, code: error.code, message: error.message });
  return 'settled';
}
