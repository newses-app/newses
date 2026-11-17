import type { Keys } from '../core/crypto.ts';
import type { PoliteFetcher } from '../core/feeds/polite-fetcher.ts';
import type { OpsRecorder } from '../core/ops/recorder.ts';
import type {
  EventHookName,
  EventRunOutcome,
  PluginEventRunner,
  PluginInfo,
} from '../core/plugins/catalog.ts';
import { PluginEventService } from '../core/plugins/events.ts';
import { createPluginServices, type PluginServices } from '../core/plugins/index.ts';
import type { Logger } from '../core/ports.ts';
import type { Db } from '../db/client.ts';
import { INSTALLED_PLUGINS } from './installed.ts';
import { PluginNetwork } from './network.ts';
import { type InstalledPlugin, PluginRegistry } from './registry.ts';
import { PluginRunner } from './runner.ts';

/** How long an event hook may run. */
export const EVENT_HOOK_TIMEOUT_MS = 60_000;

/**
 * The installed plugins, checked once per process; a plugin the registry refuses is logged and
 * left out. Tells the database which event hooks they implement, so its triggers record events
 * for them.
 */
export async function loadPlugins(deps: {
  db: Db;
  logger: Logger;
  installed?: readonly InstalledPlugin[];
}): Promise<PluginRegistry> {
  const registry = PluginRegistry.load(deps.installed ?? INSTALLED_PLUGINS, {
    logger: deps.logger,
  });
  await new PluginEventService({
    db: deps.db,
    catalog: registry,
    runner: null,
    logger: deps.logger,
    publicUrl: null,
  }).syncInstalled();
  return registry;
}

/** Runs the event hooks of loaded plugins through the hook runner. */
export class EventHookRunner implements PluginEventRunner {
  readonly #registry: PluginRegistry;
  readonly #runner: PluginRunner;

  constructor(registry: PluginRegistry, runner: PluginRunner) {
    this.#registry = registry;
    this.#runner = runner;
  }

  async run(
    plugin: PluginInfo,
    hook: EventHookName,
    userId: number,
    event: unknown,
  ): Promise<EventRunOutcome> {
    const loaded = this.#registry.get(plugin.id);
    const declared = loaded?.definition.hooks[hook];
    if (!loaded || !declared) return 'disabled';
    const outcome = await this.#runner.run({
      plugin: loaded,
      hook,
      userId,
      timeoutMs: EVENT_HOOK_TIMEOUT_MS,
      call: (context) => declared.run(event as never, context),
    });
    if (outcome.ok) return 'ok';
    return outcome.failure === 'disabled' ? 'disabled' : 'failed';
  }
}

/**
 * What a process needs of the plugins: their settings and storage, and their event deliveries,
 * whose requests share the feeds' per-host limits through `polite`.
 */
export function createPluginHost(deps: {
  registry: PluginRegistry;
  db: Db;
  keys: Pick<Keys, 'plugin-secrets'>;
  logger: Logger;
  ops: Pick<OpsRecorder, 'recordFetch' | 'recordJob'> | null;
  polite: Pick<PoliteFetcher, 'request'>;
  allowPrivateNetworks: boolean | string[];
  userAgent: string;
  /** Origin of published feed URLs in events; null leaves them out. */
  publicUrl: string | null;
}): PluginServices & {
  registry: PluginRegistry;
  events: PluginEventService;
  close: () => Promise<void>;
} {
  const { registry, db, logger } = deps;
  const services = createPluginServices({ db, keys: deps.keys, catalog: registry });
  const network = new PluginNetwork({
    polite: deps.polite,
    ops: deps.ops,
    allowPrivateNetworks: deps.allowPrivateNetworks,
    userAgent: deps.userAgent,
  });
  const runner = new PluginRunner({
    network,
    logger,
    ops: deps.ops,
    settings: services.settings,
    storage: services.storage,
  });
  const events = new PluginEventService({
    db,
    catalog: registry,
    runner: new EventHookRunner(registry, runner),
    logger,
    publicUrl: deps.publicUrl,
  });
  return { ...services, registry, events, close: () => network.close() };
}
