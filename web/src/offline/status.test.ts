import { ApiError } from '@newses/shared/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../plugins/i18n.ts';
import type { OfflineDb } from './db.ts';
import { describeFailure, loadStatus, saveStatus, syncFailure, syncStatus } from './status.ts';

const describes = (error: unknown) => describeFailure(i18n.global, syncFailure(error));

describe('describeFailure', () => {
  it('says why the server refused, in the reader’s language', () => {
    const error = new ApiError(404, 'not_found', 'Label not found', null);
    expect(describes(error)).toBe('404 That no longer exists.');
  });

  it('says the server could not be reached, for a failed request or a timeout', () => {
    const unreachable = i18n.global.t('offline.unreachable');
    expect(describes(new TypeError('Failed to fetch'))).toBe(unreachable);
    expect(describes(new DOMException('Too slow', 'TimeoutError'))).toBe(unreachable);
  });

  it('shows anything else in the reader’s language, never the raw error', () => {
    const fault = i18n.global.t('offline.syncFault');
    expect(describes(new RangeError('Out of range'))).toBe(fault);
    expect(describes('text')).toBe(fault);
  });

  it('keeps a fault’s own words, to diagnose', () => {
    expect(syncFailure(new RangeError('Out of range'))).toEqual({
      kind: 'fault',
      detail: 'RangeError: Out of range',
    });
    expect(syncFailure('text')).toEqual({ kind: 'fault', detail: 'text' });
  });
});

describe('the stored status', () => {
  const store = (value?: unknown) => {
    const get = vi.fn(() => Promise.resolve(value === undefined ? undefined : { value }));
    const put = vi.fn(() => Promise.resolve());
    return { db: { meta: { get, put } } as unknown as OfflineDb, put };
  };

  beforeEach(() => {
    syncStatus.lastError = null;
  });

  it('keeps a failure as data that a structured clone accepts', async () => {
    syncStatus.lastError = syncFailure(new ApiError(404, 'not_found', 'Gone', null));
    const { db, put } = store();
    await saveStatus(db);
    const [[{ value }]] = put.mock.calls as unknown as [[{ value: unknown }]];
    expect(() => structuredClone(value)).not.toThrow();
  });

  it('reads a failure back, and drops the text older versions stored', async () => {
    await loadStatus(store({ lastSyncedAt: 5, lastError: { kind: 'unreachable' } }).db);
    expect(syncStatus.lastError).toEqual({ kind: 'unreachable' });
    await loadStatus(store({ lastSyncedAt: 5, lastError: 'Fallo' }).db);
    expect(syncStatus.lastError).toBeNull();
  });
});
