import type { Profile } from '@newses/shared';
import { describe, expect, it, vi } from 'vitest';
import { trayMenu } from './tray-menu.ts';

const profile = (id: string, signedIn = true, login: string | null = 'ada'): Profile => ({
  id,
  serverUrl: `https://${id}.example`,
  userId: 1,
  login,
  label: null,
  signedIn,
});

const actions = () => ({
  open: vi.fn(),
  checkNow: vi.fn(),
  selectProfile: vi.fn(),
  quit: vi.fn(),
});

describe('trayMenu', () => {
  it('lists no profiles while there is only one', () => {
    const menu = trayMenu({ profiles: [profile('one')], active: 'one' }, actions());
    expect(menu.map((item) => item.label ?? item.type)).toEqual([
      'Open',
      'Check now',
      'separator',
      'Quit',
    ]);
  });

  it('marks the active profile and asks the app to move to another', () => {
    const tray = actions();
    const menu = trayMenu(
      { profiles: [profile('one'), profile('two', false, null)], active: 'one' },
      tray,
    );
    const submenu = menu.find((item) => item.label === 'Profiles')?.submenu;
    if (!Array.isArray(submenu)) throw new Error('No Profiles submenu');
    expect(submenu.map(({ label, type, checked }) => ({ label, type, checked }))).toEqual([
      { label: 'ada @ one.example', type: 'radio', checked: true },
      { label: 'two.example (signed out)', type: 'radio', checked: false },
    ]);
    const click = (i: number) => {
      (submenu[i]?.click as () => void)();
    };
    click(0);
    expect(tray.selectProfile).not.toHaveBeenCalled();
    click(1);
    expect(tray.selectProfile).toHaveBeenCalledWith('two');
  });
});
