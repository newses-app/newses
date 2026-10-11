import type { UpdateStatus } from '@rss-reader/shared';
import { readonly, ref } from 'vue';
import type { PlatformBridge } from './bridge.ts';

/** The shell's update status, kept current. */
export function createUpdates(bridge: PlatformBridge) {
  const status = ref<UpdateStatus>({ state: 'unsupported' });
  bridge.onUpdateStatus((next) => {
    status.value = next;
  });
  return {
    status: readonly(status),
    check: () => bridge.checkForUpdates(),
    install: () => bridge.installUpdate(),
  };
}

/** The version to prompt about: ready or available, and not dismissed this session. */
export function promptVersion(status: UpdateStatus, dismissed: string | null): string | null {
  if (status.state !== 'ready' && status.state !== 'available') return null;
  return status.version === dismissed ? null : status.version;
}

/** What settings shows: a status line (an `updates.*` message) and the action it offers. */
export interface UpdateSummary {
  message: string | null;
  params: Record<string, string | number>;
  action: 'check' | 'restart' | 'download' | null;
}

export function updateSummary(status: UpdateStatus): UpdateSummary {
  switch (status.state) {
    case 'unsupported':
      return { message: null, params: {}, action: null };
    case 'idle':
      return { message: null, params: {}, action: 'check' };
    case 'checking':
    case 'current':
    case 'failed':
      return { message: status.state, params: {}, action: 'check' };
    case 'downloading':
      return {
        message: 'downloading',
        params: { version: status.version, percent: status.percent },
        action: null,
      };
    case 'ready':
      return { message: 'ready', params: { version: status.version }, action: 'restart' };
    case 'available':
      return { message: 'available', params: { version: status.version }, action: 'download' };
  }
}
