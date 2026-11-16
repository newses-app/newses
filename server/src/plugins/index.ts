import type { Keys } from '../core/crypto.ts';
import { createPluginServices, type PluginServices } from '../core/plugins/index.ts';
import type { Logger } from '../core/ports.ts';
import type { Db } from '../db/client.ts';
import { INSTALLED_PLUGINS } from './installed.ts';
import { type InstalledPlugin, PluginRegistry } from './registry.ts';

/**
 * The installed plugins, checked once at startup, and their settings and storage. A plugin the
 * registry refuses is logged and left out.
 */
export function createPluginHost(deps: {
  db: Db;
  keys: Pick<Keys, 'plugin-secrets'>;
  logger: Logger;
  installed?: readonly InstalledPlugin[];
}): PluginServices & { registry: PluginRegistry } {
  const registry = PluginRegistry.load(deps.installed ?? INSTALLED_PLUGINS, {
    logger: deps.logger,
  });
  return { ...createPluginServices({ db: deps.db, keys: deps.keys, catalog: registry }), registry };
}
