// Updates from the stage's downloads (updates.ts): electron-updater checks the feed at launch and
// every 6 hours; installs that update themselves download in the background and install on
// restart or quit, and the rest are pointed at the downloads page.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { UpdateStatus } from '@newses/shared';
import { app, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import { CHECK_INTERVAL_MS, parseUpdateConfig, updateMode } from './updates.ts';

export interface Updater {
  status(): UpdateStatus;
  check(): Promise<void>;
  install(): Promise<void>;
}

/** Null when this build has no update feed (development and local builds). */
export function startUpdater(
  onStatus: (status: UpdateStatus) => void,
  portable: boolean,
): Updater | null {
  const feed = join(process.resourcesPath, 'app-update.yml');
  if (!app.isPackaged || !existsSync(feed)) return null;
  const config = parseUpdateConfig(readFileSync(feed, 'utf8'));
  if (!config) return null;
  const mode = updateMode({
    platform: process.platform,
    appImage: process.env.APPIMAGE,
    hasUninstaller: existsSync(join(dirname(process.execPath), `Uninstall ${app.getName()}.exe`)),
    portable,
    config,
  });

  let status: UpdateStatus = { state: 'idle' };
  const set = (next: UpdateStatus) => {
    status = next;
    onStatus(next);
  };

  autoUpdater.autoDownload = mode === 'auto';
  autoUpdater.autoInstallOnAppQuit = mode === 'auto';
  autoUpdater.on('checking-for-update', () => {
    set({ state: 'checking' });
  });
  autoUpdater.on('update-not-available', () => {
    set({ state: 'current' });
  });
  autoUpdater.on('update-available', ({ version }) => {
    set(
      mode === 'auto'
        ? { state: 'downloading', version, percent: 0 }
        : { state: 'available', version },
    );
  });
  autoUpdater.on('download-progress', ({ percent }) => {
    if (status.state === 'downloading') {
      set({ ...status, percent: Math.round(percent) });
    }
  });
  autoUpdater.on('update-downloaded', ({ version }) => {
    set({ state: 'ready', version });
  });
  autoUpdater.on('error', (error) => {
    console.warn('Update check failed:', error.message);
    set({ state: 'failed' });
  });

  const check = async () => {
    // A downloaded update waits for the restart.
    if (status.state === 'ready' || status.state === 'downloading') return;
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      // Reported by the error event.
    }
  };
  void check();
  setInterval(() => void check(), CHECK_INTERVAL_MS).unref();

  return {
    status: () => status,
    check,
    install: async () => {
      if (status.state === 'ready') {
        // Silent, then relaunch: the one-click installer needs no input.
        autoUpdater.quitAndInstall(true, true);
      } else if (status.state === 'available') {
        await shell.openExternal(`${config.url}/`);
      }
    },
  };
}
