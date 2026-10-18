import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DesktopOptions } from '@newses/shared';

export interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

/** What the app keeps in `settings.json` in its user data folder. */
export interface Settings {
  serverUrl?: string | undefined;
  /** The session token, encrypted with the OS key store (base64). */
  token?: string | undefined;
  window?: WindowState | undefined;
  /** The app theme's last background, so a new window starts in it rather than flashing. */
  background?: string | undefined;
  /** The app theme's last text colour, the window controls' symbols in a new window. */
  text?: string | undefined;
  /** Changed from the defaults in settings (options.ts). */
  options?: Partial<DesktopOptions> | undefined;
}

/** Settings in a JSON file, read once and written whole on each change. */
export async function openSettings(file: string) {
  let settings: Settings = {};
  try {
    settings = JSON.parse(await readFile(file, 'utf8')) as Settings;
  } catch {
    // First run, or an unreadable file: start over.
  }
  let writing = Promise.resolve();
  return {
    get: (): Readonly<Settings> => settings,
    /** Applies changes and saves them; writes are serialised, and atomic through a rename. */
    update(changes: Settings): Promise<void> {
      settings = { ...settings, ...changes };
      const data = JSON.stringify(settings);
      writing = writing.then(async () => {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(`${file}.tmp`, data, { mode: 0o600 });
        await rename(`${file}.tmp`, file);
      });
      return writing;
    },
  };
}

export type SettingsStore = Awaited<ReturnType<typeof openSettings>>;
