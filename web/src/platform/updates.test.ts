import type { UpdateStatus } from '@rss-reader/shared';
import { describe, expect, it, vi } from 'vitest';
import { webBridge } from './bridge.ts';
import { createUpdates, promptVersion, updateSummary } from './updates.ts';

describe('createUpdates', () => {
  it("follows the shell's status and forwards actions", async () => {
    let push: (status: UpdateStatus) => void = () => undefined;
    const checkForUpdates = vi.fn(() => Promise.resolve());
    const updates = createUpdates({
      ...webBridge,
      onUpdateStatus: (listener) => {
        push = listener;
        listener({ state: 'idle' });
      },
      checkForUpdates,
    });
    expect(updates.status.value).toEqual({ state: 'idle' });
    push({ state: 'ready', version: '1.2.0' });
    expect(updates.status.value).toEqual({ state: 'ready', version: '1.2.0' });
    await updates.check();
    expect(checkForUpdates).toHaveBeenCalled();
  });

  it('is unsupported in the browser', () => {
    expect(createUpdates(webBridge).status.value).toEqual({ state: 'unsupported' });
  });
});

describe('promptVersion', () => {
  it('prompts once per version for a ready or available update', () => {
    expect(promptVersion({ state: 'ready', version: '1.2.0' }, null)).toBe('1.2.0');
    expect(promptVersion({ state: 'available', version: '1.2.0' }, null)).toBe('1.2.0');
    expect(promptVersion({ state: 'available', version: '1.2.0' }, '1.2.0')).toBeNull();
    expect(promptVersion({ state: 'available', version: '1.3.0' }, '1.2.0')).toBe('1.3.0');
    expect(promptVersion({ state: 'downloading', version: '1.2.0', percent: 5 }, null)).toBeNull();
    expect(promptVersion({ state: 'current' }, null)).toBeNull();
  });
});

describe('updateSummary', () => {
  it('offers a check until an update is found, then restart or download', () => {
    expect(updateSummary({ state: 'unsupported' }).action).toBeNull();
    expect(updateSummary({ state: 'idle' })).toEqual({
      message: null,
      params: {},
      action: 'check',
    });
    expect(updateSummary({ state: 'failed' })).toEqual({
      message: 'failed',
      params: {},
      action: 'check',
    });
    expect(updateSummary({ state: 'downloading', version: '1.2.0', percent: 40 })).toEqual({
      message: 'downloading',
      params: { version: '1.2.0', percent: 40 },
      action: null,
    });
    expect(updateSummary({ state: 'ready', version: '1.2.0' }).action).toBe('restart');
    expect(updateSummary({ state: 'available', version: '1.2.0' }).action).toBe('download');
  });
});
