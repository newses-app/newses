import type { CreateThemeRequest, PushServiceStatus } from '@newses/shared';
import { ApiError, type ApiFailure } from '@newses/shared/client';
import { reactive, ref, toRaw } from 'vue';
import { requestOutcome } from '../lib/connectivity.ts';
import { failureText, type Translator } from '../lib/error-text.ts';
import type { OfflineDb } from './db.ts';
import { indexBytes, storedBytes } from './downloads.ts';
import { type NoteConflict, onPendingCount } from './outbox.ts';
import type { BackgroundState } from './registration.ts';

const STATUS_KEY = 'syncStatus';

/** Why a sync failed: stored as data, so it shows in whichever language the reader has then. */
export type SyncFailure =
  | { kind: 'refused'; status: number; failure: ApiFailure }
  | { kind: 'unreachable' }
  | { kind: 'fault'; detail: string };

/** How the offline store's syncing goes, for settings; kept in the store across launches. */
export const syncStatus = reactive({
  running: false,
  lastSyncedAt: null as number | null,
  lastError: null as SyncFailure | null,
  /** The server's API is older than the store needs. */
  unsupported: false,
});

/** Whether this browser syncs with no tab open, for settings; set at each sync. */
export const backgroundState = ref<BackgroundState | null>(null);

/** How the server's pushes reach the Android job, for settings; set at each sync. */
export const pushStatus = ref<PushServiceStatus | null>(null);

/** How many changes wait to be sent, for the status, settings, and sign-out. */
export const outboxPending = ref(0);
onPendingCount((pending) => {
  outboxPending.value = pending;
});

/** Bumped when changes are kept, so the running sync sends them as soon as it can. */
export const flushRequests = ref(0);

/** Bumped to ask the running sync for one now (settings' Sync now, turning offline on). */
export const syncRequests = ref(0);

/** Themes created offline that the server refused, kept for the reader to fix or export. */
export const themeDrafts = ref<CreateThemeRequest[]>([]);
const DRAFTS_KEY = 'themeDrafts';

export async function loadThemeDrafts(db: OfflineDb): Promise<void> {
  themeDrafts.value = ((await db.meta.get(DRAFTS_KEY))?.value ?? []) as CreateThemeRequest[];
}

export async function saveThemeDrafts(db: OfflineDb, drafts: CreateThemeRequest[]): Promise<void> {
  themeDrafts.value = drafts;
  await db.meta.put({ key: DRAFTS_KEY, value: JSON.parse(JSON.stringify(drafts)) as unknown });
}

export const keepThemeDrafts = (db: OfflineDb, drafts: CreateThemeRequest[]) =>
  saveThemeDrafts(db, [...themeDrafts.value, ...drafts]);

/** Notes changed both on this device and elsewhere, waiting for the reader to settle. */
export const noteConflicts = ref<NoteConflict[]>([]);

export function syncFailure(error: unknown): SyncFailure {
  if (error instanceof ApiError) {
    const { status, code, message, reason, params } = error;
    return { kind: 'refused', status, failure: { code, message, reason, params } };
  }
  if (requestOutcome({ error }) === 'unreachable') return { kind: 'unreachable' };
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return { kind: 'fault', detail };
}

export function describeFailure(i18n: Translator, failure: SyncFailure): string {
  if (failure.kind === 'unreachable') return i18n.t('offline.unreachable', {});
  if (failure.kind === 'fault') return i18n.t('offline.syncFault', {});
  const error = failureText(i18n, failure.failure);
  return i18n.t('offline.refusedStatus', { status: failure.status, error });
}

export async function loadStatus(db: OfflineDb): Promise<void> {
  const saved = (await db.meta.get(STATUS_KEY))?.value as
    { lastSyncedAt: number | null; lastError: SyncFailure | string | null } | undefined;
  // Older versions stored the text; the next sync replaces it.
  if (saved) {
    const lastError = typeof saved.lastError === 'string' ? null : saved.lastError;
    Object.assign(syncStatus, { ...saved, lastError });
  }
}

export async function saveStatus(db: OfflineDb): Promise<void> {
  const { lastSyncedAt, lastError } = syncStatus;
  await db.meta.put({ key: STATUS_KEY, value: { lastSyncedAt, lastError: toRaw(lastError) } });
}

/** What the store holds, for settings. */
export async function storeSummary(db: OfflineDb) {
  const [entries, contents, images, bytes, index] = await Promise.all([
    db.entries.count(),
    db.contents.count(),
    db.images.count(),
    storedBytes(db),
    indexBytes(db),
  ]);
  return { entries, contents, images, bytes, index };
}
