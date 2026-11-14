import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Profile, ProfileList } from '@newses/shared';
import type { MenuItemConstructorOptions } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLaunchAtLogin, setTray } from './background.ts';
import { HIDDEN_ARG } from './options.ts';
import { app, resetElectron, Tray } from './test/electron.ts';

vi.mock('electron', () => import('./test/electron.ts'));

const PLATFORM = process.platform;
const actions = { open: vi.fn(), checkNow: vi.fn(), selectProfile: vi.fn() };
const profile = (id: string, label: string): Profile => ({
  id,
  serverUrl: `https://${id}.example`,
  userId: 1,
  login: 'ann',
  serverName: null,
  label,
  signedIn: true,
});
const PROFILES: ProfileList = {
  profiles: [profile('p1', 'Home'), profile('p2', 'Work')],
  active: 'p1',
};

const menu = (tray: Tray | undefined) => tray?.menu as MenuItemConstructorOptions[];

beforeEach(() => {
  resetElectron();
});

afterEach(() => {
  setTray(false, actions, { profiles: [], active: null });
  Object.defineProperty(process, 'platform', { value: PLATFORM, configurable: true });
});

describe('setTray', () => {
  it('shows one icon, opening the app on click, with a menu of the profiles', () => {
    setTray(true, actions, PROFILES);
    setTray(true, actions);
    expect(Tray.created).toHaveLength(1);
    const [tray] = Tray.created;
    expect(tray?.tooltip).toBe('Newses');
    tray?.emit('click');
    expect(actions.open).toHaveBeenCalledOnce();
    // The second call kept the profiles it was given before; picking another moves there.
    const profiles = menu(tray).find((item) => Array.isArray(item.submenu))?.submenu as
      MenuItemConstructorOptions[] | undefined;
    expect(profiles?.map((item) => [item.label, item.checked])).toEqual([
      ['Home', true],
      ['Work', false],
    ]);
    (profiles?.[1]?.click as (() => void) | undefined)?.();
    expect(actions.selectProfile).toHaveBeenCalledWith('p2');

    const quit = menu(tray).at(-1);
    (quit?.click as (() => void) | undefined)?.();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it('removes the icon when turned off, and makes a new one when on again', () => {
    setTray(true, actions);
    setTray(false, actions);
    expect(Tray.created[0]?.destroyed).toBe(true);
    setTray(true, actions);
    expect(Tray.created).toHaveLength(2);
  });
});

describe('setLaunchAtLogin', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'newses-home-'));
    app.getPath.mockImplementation((name: string) => join(home, name));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it('writes and removes an XDG autostart entry on Linux, for the AppImage when there is one', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.stubEnv('APPIMAGE', '/home/reader/Newses.AppImage');
    const entry = join(home, 'appData', 'autostart', 'newses.desktop');
    await setLaunchAtLogin(true);
    expect(await readFile(entry, 'utf8')).toContain(
      `Exec="/home/reader/Newses.AppImage" ${HIDDEN_ARG}`,
    );
    await setLaunchAtLogin(false);
    await expect(stat(entry)).rejects.toThrow();
    await setLaunchAtLogin(false);
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it('registers a login item elsewhere, started hidden', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    await setLaunchAtLogin(true);
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      args: [HIDDEN_ARG],
    });
  });
});
