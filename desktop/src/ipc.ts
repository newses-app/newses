// The main process's side of the platform bridge (preload.ts is the renderer's): each call checked
// to come from the app's own pages, with what it sends checked before use.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProfileList, UpdateStatus } from '@newses/shared';
import { createProfiles, httpsOrigin, profileChanges, profileId } from '@newses/shared/profiles';
import {
  app,
  type BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  nativeTheme,
  safeStorage,
  shell,
} from 'electron';
import { setLaunchAtLogin } from './background.ts';
import { setLanguage } from './i18n.ts';
import { showNotification } from './notifications.ts';
import { currentOptions, notificationTarget, parseOptions, shownOptions } from './options.ts';
import { settingsProfileStorage } from './profiles.ts';
import type { Settings, SettingsStore } from './settings.ts';
import { themeBackground, themeSource, themeText } from './theme.ts';
import { createTokenStore } from './token.ts';
import type { Updater } from './updater.ts';
import { externalUrl, isAppUrl } from './urls.ts';

/** What the bridge needs of the running app. */
export interface BridgeHost {
  settings: SettingsStore;
  /** The Windows portable exe, which does not offer launch at login. */
  portable: boolean;
  /** Whether the window controls overlay the app bar, drawn in the theme's text colour. */
  controlsOverlay: boolean;
  window: () => BrowserWindow | null;
  updater: () => Updater | null;
  showWindow: () => void;
  /** Builds the application menu again, in the app's language. */
  buildMenu: () => void;
  /** Shows the tray as the options have it, listing `profiles` when given. */
  applyTray: (profiles?: ProfileList) => void;
}

/** A string no longer than `max`, or null. */
const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.length <= max ? value : null;

function checked<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`Invalid ${what}`);
  return value;
}

/** Bridge calls are answered only for the app's own pages. */
function handle(channel: string, listener: (...args: unknown[]) => unknown) {
  ipcMain.handle(`bridge:${channel}`, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!isAppUrl(event.senderFrame?.url ?? '')) throw new Error('Not allowed');
    return listener(...args);
  });
}

/** Answers the app's bridge calls; returns a function that shows the profiles in the tray. */
export function registerBridge(host: BridgeHost): () => Promise<void> {
  const { settings, portable } = host;
  const tokens = createTokenStore(settings, safeStorage, process.platform);
  const profiles = createProfiles(settingsProfileStorage(settings, tokens));
  const showProfiles = async () => {
    host.applyTray(await profiles.list());
  };
  /** A change to the profiles, or whether one is signed in, shows in the tray. */
  const changing = async <T>(change: Promise<T>): Promise<T> => {
    try {
      return await change;
    } finally {
      void showProfiles();
    }
  };
  const profile = (id: unknown) => checked(profileId(id), 'profile');

  handle('getProfiles', () => profiles.list());
  handle('addProfile', (url) => changing(profiles.add(checked(httpsOrigin(url), 'server'))));
  handle('updateProfile', (id, changes) =>
    changing(profiles.update(profile(id), checked(profileChanges(changes), 'changes'))),
  );
  handle('setActiveProfile', (id) => changing(profiles.setActive(profile(id))));
  handle('removeProfile', (id) => changing(profiles.remove(profile(id))));
  handle('getToken', () => profiles.getToken());
  handle('setToken', (token) => changing(profiles.setToken(checked(text(token, 1024), 'token'))));
  handle('clearToken', () => changing(profiles.clearToken()));

  handle('openExternal', async (url) => {
    const target = externalUrl(text(url, 8192) ?? '');
    if (target) await shell.openExternal(target);
  });
  handle('saveFile', async (file) => {
    const { name, data } = (file ?? {}) as { name?: unknown; data?: unknown };
    const fileName = text(name, 255);
    const contents = text(data, 50 * 1024 * 1024);
    const window = host.window();
    if (!fileName || contents === null || !window) return false;
    const result = await dialog.showSaveDialog(window, {
      defaultPath: join(app.getPath('downloads'), fileName),
    });
    if (result.canceled || !result.filePath) return false;
    await writeFile(result.filePath, contents);
    return true;
  });
  handle('notify', (value) => {
    const { title, body, target } = (value ?? {}) as Record<string, unknown>;
    const path = notificationTarget(target);
    // The target is a path in this profile's data; after a move to another it only opens the app.
    const active = settings.get().activeProfile;
    // Each is the running total so far: it replaces the last rather than stacking up.
    showNotification(text(title, 256) ?? '', text(body, 1024) ?? '', () => {
      host.showWindow();
      if (path && settings.get().activeProfile === active)
        host.window()?.webContents.send('bridge:navigate', path);
    });
  });

  handle('getDesktopOptions', () => shownOptions(currentOptions(settings), portable));
  handle('setDesktopOptions', async (value) => {
    const changes = parseOptions(value, portable);
    if (!changes) throw new Error('Invalid options');
    await settings.update({ options: { ...settings.get().options, ...changes } });
    host.applyTray();
    if (changes.launchAtLogin !== undefined) await setLaunchAtLogin(changes.launchAtLogin);
  });
  handle('setLanguage', async (code) => {
    if (typeof code !== 'string') return;
    const language = setLanguage([code]);
    if (language === settings.get().language) return;
    host.buildMenu();
    void showProfiles();
    await settings.update({ language });
  });
  // `system` lets Electron follow the OS again; pinning light or dark would stop that for good.
  handle('setTheme', async (theme) => {
    nativeTheme.themeSource = themeSource(theme);
    const saved = settings.get();
    const changes: Settings = {};
    const window = host.window();
    const background = themeBackground(theme);
    if (background) {
      window?.setBackgroundColor(background);
      if (background !== saved.background) changes.background = background;
    }
    const color = themeText(theme);
    if (color) {
      if (host.controlsOverlay) window?.setTitleBarOverlay({ symbolColor: color });
      if (color !== saved.text) changes.text = color;
    }
    if (Object.keys(changes).length > 0) await settings.update(changes);
  });
  handle(
    'getUpdateStatus',
    (): UpdateStatus => host.updater()?.status() ?? { state: 'unsupported' },
  );
  handle('checkForUpdates', () => host.updater()?.check());
  handle('installUpdate', () => host.updater()?.install());
  return showProfiles;
}
