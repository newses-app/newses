import type { Entry } from '@newses/shared';
import { QueryClient } from '@tanstack/vue-query';
import { enableAutoUnmount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { noteConflicts } from '../../offline/status.ts';
import { i18n } from '../../plugins/i18n.ts';
import { useUiStore } from '../../stores/ui.ts';
import { mountInApp } from '../../test/mount.ts';
import NoteConflictDialog from './NoteConflictDialog.vue';

const setNote = vi.hoisted(() => vi.fn<(entry: object, note: string | null) => Promise<void>>());
const getEntry = vi.hoisted(() => vi.fn<(id: number) => Promise<object>>());
vi.mock('../../composables/useEntries.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useEntryActions: () => ({ setNote }),
}));
vi.mock('../../api.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api: { entries: { get: getEntry } },
}));

enableAutoUnmount(afterEach);
const { t } = i18n.global;

const entry = (id: number) => ({ id, title: `E${String(id)}`, note: 'stale' }) as Entry;

async function open(cached = true) {
  const queryClient = new QueryClient();
  if (cached) queryClient.setQueryData(['entry', 1], entry(1));
  const { pinia } = mountInApp(NoteConflictDialog, { queryClient });
  await flushPromises();
  return useUiStore(pinia);
}

const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('.v-dialog button')].find(
    (b) => b.textContent.trim() === label,
  );
const dialogText = () => document.querySelector('.v-dialog')?.textContent ?? '';

beforeEach(() => {
  noteConflicts.value = [
    { id: 1, mine: 'Mine', theirs: null },
    { id: 2, mine: 'Second', theirs: 'Theirs' },
  ];
  setNote.mockReset().mockResolvedValue();
  getEntry.mockReset().mockImplementation((id) => Promise.resolve(entry(id)));
});

describe('NoteConflictDialog', () => {
  it('shows one conflict at a time, both notes, oldest first', async () => {
    await open();
    expect(dialogText()).toContain('Mine');
    expect(dialogText()).toContain(t('offline.noteNone'));
    button(t('offline.keepTheirs'))?.click();
    await flushPromises();
    expect(noteConflicts.value.map((c) => c.id)).toEqual([2]);
    expect(dialogText()).toContain('Second');
    expect(setNote).not.toHaveBeenCalled();
  });

  it("keeps this device's note over the other's", async () => {
    await open();
    button(t('offline.keepMine'))?.click();
    await flushPromises();
    expect(setNote).toHaveBeenCalledWith({ ...entry(1), note: null }, 'Mine');
    expect(getEntry).not.toHaveBeenCalled();
    expect(noteConflicts.value).toHaveLength(1);
  });

  it('loads an entry that is not cached, and says when saving fails', async () => {
    setNote.mockRejectedValue(new TypeError('Failed to fetch'));
    const ui = await open(false);
    button(t('offline.keepMine'))?.click();
    await flushPromises();
    expect(getEntry).toHaveBeenCalledWith(1);
    expect(ui.notice).toEqual({ text: t('errors.generic'), error: true });
  });

  it('copies this note and keeps the other, unless copying fails', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() =>
      Promise.reject(new Error('denied')),
    );
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const ui = await open();
    button(t('offline.copyMine'))?.click();
    await flushPromises();
    expect(ui.notice?.error).toBe(true);
    expect(noteConflicts.value).toHaveLength(2);

    writeText.mockResolvedValue();
    button(t('offline.copyMine'))?.click();
    await flushPromises();
    expect(writeText).toHaveBeenLastCalledWith('Mine');
    expect(ui.notice).toEqual({ text: t('offline.noteCopied'), error: false });
    expect(noteConflicts.value).toHaveLength(1);
    Reflect.deleteProperty(navigator, 'clipboard');
  });
});
