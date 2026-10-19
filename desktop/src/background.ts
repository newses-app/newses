// Running in the background: the tray icon (while closing to the tray is on) and launch at login.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProfileList } from '@newses/shared';
import { app, Menu, nativeImage, Tray } from 'electron';
import { autostartEntry, HIDDEN_ARG } from './options.ts';
import { type TrayActions, trayMenu } from './tray-menu.ts';

let tray: Tray | null = null;
let profiles: ProfileList = { profiles: [], active: null };

function setMenu(actions: Omit<TrayActions, 'quit'>) {
  tray?.setContextMenu(
    Menu.buildFromTemplate(
      trayMenu(profiles, {
        ...actions,
        quit: () => {
          app.quit();
        },
      }),
    ),
  );
}

/** Shows or removes the tray icon; its menu lists the profiles to move between. */
export function setTray(enabled: boolean, actions: Omit<TrayActions, 'quit'>, list = profiles) {
  profiles = list;
  if (!enabled) {
    tray?.destroy();
    tray = null;
    return;
  }
  if (!tray) {
    const icon = nativeImage.createFromPath(join(__dirname, 'icon.png')).resize({ width: 32 });
    tray = new Tray(icon);
    tray.setToolTip('Newses');
    // Windows opens the menu on right click only; a left click opens the app.
    tray.on('click', actions.open);
  }
  setMenu(actions);
}

/** Registers or removes the login item; Linux uses an XDG autostart entry. */
export async function setLaunchAtLogin(enabled: boolean) {
  if (process.platform === 'linux') {
    const file = join(app.getPath('appData'), 'autostart', 'newses.desktop');
    if (!enabled) {
      await rm(file, { force: true });
      return;
    }
    // An AppImage runs from a temporary mount; the image itself is what starts again.
    await mkdir(join(app.getPath('appData'), 'autostart'), { recursive: true });
    await writeFile(file, autostartEntry(process.env.APPIMAGE ?? process.execPath));
    return;
  }
  app.setLoginItemSettings({ openAtLogin: enabled, args: [HIDDEN_ARG] });
}
