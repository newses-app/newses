import type { ProfileList } from '@newses/shared';
import { profileLabel } from '@newses/shared/profiles';
import type { MenuItemConstructorOptions } from 'electron';
import { t } from './i18n.ts';

export interface TrayActions {
  open: () => void;
  checkNow: () => void;
  /** Asks the app to move to a profile. */
  selectProfile: (id: string) => void;
  quit: () => void;
}

/** The tray's menu; with several profiles, a Profiles submenu marks the active one. */
export function trayMenu(
  { profiles, active }: ProfileList,
  actions: TrayActions,
): MenuItemConstructorOptions[] {
  const menu: MenuItemConstructorOptions[] = [
    { label: t('open'), click: actions.open },
    { label: t('checkNow'), click: actions.checkNow },
  ];
  if (profiles.length > 1)
    menu.push({
      label: t('profiles'),
      submenu: profiles.map((profile) => ({
        label: profile.signedIn
          ? profileLabel(profile)
          : t('signedOut', { name: profileLabel(profile) }),
        type: 'radio',
        checked: profile.id === active,
        click: () => {
          if (profile.id !== active) actions.selectProfile(profile.id);
        },
      })),
    });
  menu.push({ type: 'separator' }, { label: t('quit'), click: actions.quit });
  return menu;
}
