// Running in the background: the tray icon (while closing to the tray is on) and launch at login.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, Menu, nativeImage, Tray } from 'electron';
import { autostartEntry, HIDDEN_ARG } from './options.ts';

export interface TrayActions {
  open: () => void;
  checkNow: () => void;
}

let tray: Tray | null = null;

/** Shows or removes the tray icon. */
export function setTray(enabled: boolean, actions: TrayActions) {
  if (!enabled) {
    tray?.destroy();
    tray = null;
    return;
  }
  if (tray) return;
  const icon = nativeImage.createFromPath(join(__dirname, 'icon.png')).resize({ width: 32 });
  tray = new Tray(icon);
  tray.setToolTip('Newses');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open', click: actions.open },
      { label: 'Check now', click: actions.checkNow },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          app.quit();
        },
      },
    ]),
  );
  // Windows opens the menu on right click only; a left click opens the app.
  tray.on('click', actions.open);
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
