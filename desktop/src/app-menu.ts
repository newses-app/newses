import type { MenuItemConstructorOptions } from 'electron';
import { t } from './i18n.ts';

/** The application menu. Electron's role labels stay English, so each role has its label here. */
export function appMenu({
  developer,
  windows,
}: {
  developer: boolean;
  windows: boolean;
}): MenuItemConstructorOptions[] {
  const view: MenuItemConstructorOptions[] = [
    { role: 'reload', label: t('reload') },
    { type: 'separator' },
    { role: 'resetZoom', label: t('resetZoom') },
    { role: 'zoomIn', label: t('zoomIn') },
    { role: 'zoomOut', label: t('zoomOut') },
    { type: 'separator' },
    { role: 'togglefullscreen', label: t('toggleFullscreen') },
  ];
  if (developer) view.push({ type: 'separator' }, { role: 'toggleDevTools' });
  return [
    { label: t('fileMenu'), submenu: [{ role: 'quit', label: t(windows ? 'exit' : 'quit') }] },
    {
      label: t('editMenu'),
      submenu: [
        { role: 'undo', label: t('undo') },
        { role: 'redo', label: t('redo') },
        { type: 'separator' },
        { role: 'cut', label: t('cut') },
        { role: 'copy', label: t('copy') },
        { role: 'paste', label: t('paste') },
        { role: 'delete', label: t('delete') },
        { type: 'separator' },
        { role: 'selectAll', label: t('selectAll') },
      ],
    },
    { label: t('viewMenu'), submenu: view },
  ];
}
