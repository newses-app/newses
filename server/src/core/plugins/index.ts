import type { Db } from '../../db/client.ts';
import type { Keys } from '../crypto.ts';
import type { PluginCatalog } from './catalog.ts';
import { PluginSettingsService } from './settings.ts';
import { PluginStorageService } from './storage.ts';

export type { PluginCatalog, PluginInfo, SettingsField, SettingsSpec } from './catalog.ts';
export { NO_PLUGINS } from './catalog.ts';

/** Plugins' settings and storage, for the installed plugins `catalog` lists. */
export function createPluginServices(deps: {
  db: Db;
  keys: Pick<Keys, 'plugin-secrets'>;
  catalog: PluginCatalog;
}) {
  return {
    catalog: deps.catalog,
    settings: new PluginSettingsService({
      db: deps.db,
      key: deps.keys['plugin-secrets'],
      catalog: deps.catalog,
    }),
    storage: new PluginStorageService(deps.db),
  };
}

export type PluginServices = ReturnType<typeof createPluginServices>;
