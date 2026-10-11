import { describe, expect, it } from 'vitest';
import { autostartEntry, notificationTarget, parseOptions } from './options.ts';

describe('parseOptions', () => {
  it('accepts known options with boolean values', () => {
    expect(parseOptions({ closeToTray: true })).toEqual({ closeToTray: true });
    expect(parseOptions({ notifications: false, launchAtLogin: true })).toEqual({
      notifications: false,
      launchAtLogin: true,
    });
  });

  it('refuses anything else', () => {
    expect(parseOptions({ closeToTray: 'yes' })).toBeNull();
    expect(parseOptions({ serverUrl: 'https://x' })).toBeNull();
    expect(parseOptions(null)).toBeNull();
  });
});

describe('notificationTarget', () => {
  it('accepts app paths', () => {
    expect(notificationTarget('/f12')).toBe('/f12');
    expect(notificationTarget('/c3')).toBe('/c3');
    expect(notificationTarget('/all')).toBe('/all');
  });

  it('refuses anything that could leave the app', () => {
    expect(notificationTarget('https://evil.example')).toBeNull();
    expect(notificationTarget('//evil.example')).toBeNull();
    expect(notificationTarget('/\\evil.example')).toBeNull();
    expect(notificationTarget('/a b')).toBeNull();
    expect(notificationTarget(undefined)).toBeNull();
  });
});

describe('autostartEntry', () => {
  it('starts the executable hidden, quoted for the desktop entry spec', () => {
    const entry = autostartEntry('/home/me/Apps/rss reader $1.AppImage');
    expect(entry).toContain('Exec="/home/me/Apps/rss reader \\$1.AppImage" --hidden\n');
    expect(entry).toMatch(/^\[Desktop Entry\]\nType=Application\n/);
  });
});
