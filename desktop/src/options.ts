// Desktop options (notifications, tray, launch at login) and the checks on what the renderer sends.
import type { DesktopOptions } from '@newses/shared';

export const DEFAULT_OPTIONS: DesktopOptions = {
  notifications: true,
  closeToTray: false,
  launchAtLogin: false,
};

/** Launched at login: starts in the tray when `closeToTray` is on. */
export const HIDDEN_ARG = '--hidden';

/** The booleans the renderer may change; null when anything else is sent. */
export function parseOptions(value: unknown): Partial<DesktopOptions> | null {
  if (typeof value !== 'object' || value === null) return null;
  const options: Partial<DesktopOptions> = {};
  for (const [key, setting] of Object.entries(value)) {
    if (!(key in DEFAULT_OPTIONS) || typeof setting !== 'boolean') return null;
    options[key as keyof DesktopOptions] = setting;
  }
  return options;
}

/** A path inside the app for a notification to open; null for anything that could leave it. */
export function notificationTarget(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 300) return null;
  return /^\/(?![/\\])[^\s\\]*$/.test(value) ? value : null;
}

/** An Exec argument quoted per the desktop entry spec. */
const quoteExec = (arg: string) => `"${arg.replace(/["`$\\]/g, '\\$&')}"`;

/** `~/.config/autostart/newses.desktop` for Linux, where Electron cannot register login items. */
export const autostartEntry = (executable: string) => `[Desktop Entry]
Type=Application
Name=Newses
Exec=${quoteExec(executable)} ${HIDDEN_ARG}
X-GNOME-Autostart-enabled=true
`;
