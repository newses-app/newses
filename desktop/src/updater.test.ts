import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpdateStatus } from '@newses/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, resetElectron, shell } from './test/electron.ts';
import { CHECK_INTERVAL_MS } from './updates.ts';
import { startUpdater } from './updater.ts';

const autoUpdater = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events');
  return Object.assign(new EventEmitter(), {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    checkForUpdates: vi.fn(() => Promise.resolve()),
    quitAndInstall: vi.fn(),
  });
});
vi.mock('electron', () => import('./test/electron.ts'));
vi.mock('electron-updater', () => ({ autoUpdater }));

const PLATFORM = process.platform;
const FEED = 'provider: generic\nurl: https://downloads.example/downloads\n';
let resources: string;
let statuses: UpdateStatus[];

beforeEach(async () => {
  resetElectron();
  vi.useFakeTimers();
  autoUpdater.removeAllListeners();
  resources = await mkdtemp(join(tmpdir(), 'newses-resources-'));
  await writeFile(join(resources, 'app-update.yml'), FEED);
  // An AppImage on Linux, which replaces itself.
  Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true });
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  vi.stubEnv('APPIMAGE', '/home/reader/Newses.AppImage');
  statuses = [];
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  Object.defineProperty(process, 'platform', { value: PLATFORM, configurable: true });
  await rm(resources, { recursive: true, force: true });
});

const start = () => startUpdater((status) => void statuses.push(status), false);

describe('startUpdater', () => {
  it('does nothing in development, or without a usable feed', async () => {
    app.isPackaged = false;
    expect(start()).toBeNull();
    app.isPackaged = true;
    await writeFile(join(resources, 'app-update.yml'), 'provider: github\n');
    expect(start()).toBeNull();
    await rm(join(resources, 'app-update.yml'));
    expect(start()).toBeNull();
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('downloads an update itself, then installs it on restart', async () => {
    const updater = start();
    expect(autoUpdater.autoDownload).toBe(true);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledOnce();

    autoUpdater.emit('checking-for-update');
    autoUpdater.emit('update-available', { version: '1.3.0' });
    autoUpdater.emit('download-progress', { percent: 41.6 });
    expect(updater?.status()).toEqual({ state: 'downloading', version: '1.3.0', percent: 42 });
    // Downloading: no new check until it is installed.
    await updater?.check();
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledOnce();

    autoUpdater.emit('update-downloaded', { version: '1.3.0' });
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledOnce();
    await updater?.install();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
    expect(statuses.map((s) => s.state)).toEqual([
      'checking',
      'downloading',
      'downloading',
      'ready',
    ]);
  });

  it('links to the downloads page where the install cannot replace itself', async () => {
    // A deb, which the package manager updates.
    vi.stubEnv('APPIMAGE', undefined);
    const updater = start();
    expect(autoUpdater.autoDownload).toBe(false);
    autoUpdater.emit('update-available', { version: '1.3.0' });
    autoUpdater.emit('download-progress', { percent: 10 });
    expect(updater?.status()).toEqual({ state: 'available', version: '1.3.0' });
    await updater?.install();
    expect(shell.openExternal).toHaveBeenCalledWith('https://downloads.example/downloads/');
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('checks again every 6 hours, and reports when current or failing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const updater = start();
    autoUpdater.emit('update-not-available');
    expect(updater?.status()).toEqual({ state: 'current' });
    autoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('offline'));
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
    autoUpdater.emit('error', new Error('offline'));
    expect(updater?.status()).toEqual({ state: 'failed' });
    expect(warn).toHaveBeenCalledWith('Update check failed:', 'offline');
    // Nothing to install yet.
    await updater?.install();
    expect(shell.openExternal).not.toHaveBeenCalled();
  });
});
