import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it } from 'vitest';
import { appMenu } from './app-menu.ts';

const items = (menu: MenuItemConstructorOptions[]) =>
  menu.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? item.submenu : [])]);

describe('appMenu', () => {
  const menu = items(appMenu({ developer: false, windows: false }));

  it('labels every item, as Electron leaves role labels in English', () => {
    expect(menu.filter((item) => item.type !== 'separator' && !item.label)).toEqual([]);
  });

  it('keeps developer tools to development builds', () => {
    const roles = (developer: boolean) =>
      items(appMenu({ developer, windows: false })).map((item) => item.role);
    expect(roles(false)).not.toContain('toggleDevTools');
    expect(roles(true)).toContain('toggleDevTools');
  });

  it('says Exit on Windows', () => {
    const quit = (windows: boolean) =>
      items(appMenu({ developer: false, windows })).find((item) => item.role === 'quit')?.label;
    expect(quit(true)).toBe('Exit');
    expect(quit(false)).toBe('Quit');
  });
});
