import { DIGEST_LIMITS, type DigestAdditions } from '@newses/plugin-api';
import { z } from 'zod';
import type { Keys } from '../core/crypto.ts';
import type { PoliteFetcher } from '../core/feeds/polite-fetcher.ts';
import { stripControlChars } from '../core/feeds/sanitize.ts';
import type { OpsRecorder } from '../core/ops/recorder.ts';
import type {
  DigestAddition,
  DigestComposeInput,
  DigestComposer,
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
import { type InstalledPlugin, type LoadedPlugin, PluginRegistry } from './registry.ts';
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

/** What `digest.compose` may return. */
const digestAdditionsSchema: z.ZodType<DigestAdditions | null | undefined> = z
  .object({
    overview: z.string().max(DIGEST_LIMITS.overview).nullish(),
    entries: z
      .array(z.object({ id: z.number().int(), text: z.string().max(DIGEST_LIMITS.entryText) }))
      .max(1000)
      .nullish(),
  })
  .nullish();

/** A plugin's plain text for mail: line breaks as `\n`, no other control characters, trimmed. */
function mailText(text: string | null | undefined): string | null {
  const clean = stripControlChars((text ?? '').replace(/\r\n?/g, '\n'))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return clean === '' ? null : clean;
}

/** The plugin's name in `locale`, else its language, else English, else its id. */
export function pluginName(plugin: Pick<LoadedPlugin, 'id' | 'messages'>, locale: string): string {
  const language = locale.split('-')[0] ?? locale;
  for (const tag of [locale, language, 'en']) {
    const name = plugin.messages[tag]?.['name'];
    if (name) return name;
  }
  return plugin.id;
}

/**
 * Runs the plugins' `digest.compose` for a user's digest, all at once, each under
 * `DIGEST_LIMITS.timeoutSeconds`. A plugin that is off for the user, fails, or returns more
 * than the limits adds nothing.
 */
export class DigestHookComposer implements DigestComposer {
  readonly #plugins: LoadedPlugin[];
  readonly #runner: Pick<PluginRunner, 'run'>;
  readonly #timeoutMs: number;

  constructor(
    registry: PluginRegistry,
    runner: Pick<PluginRunner, 'run'>,
    timeoutMs = DIGEST_LIMITS.timeoutSeconds * 1000,
  ) {
    this.#plugins = registry.list().filter((plugin) => plugin.definition.hooks['digest.compose']);
    this.#runner = runner;
    this.#timeoutMs = timeoutMs;
  }

  get composes(): boolean {
    return this.#plugins.length > 0;
  }

  async compose(input: DigestComposeInput): Promise<DigestAddition[]> {
    const listed = new Set(input.entries.map((entry) => entry.id));
    const outcomes = await Promise.all(
      this.#plugins.map(async (plugin) => {
        const hook = plugin.definition.hooks['digest.compose'];
        if (!hook) return null;
        const outcome = await this.#runner.run({
          plugin,
          hook: 'digest.compose',
          userId: input.userId,
          timeoutMs: this.#timeoutMs,
          output: digestAdditionsSchema,
          call: (context) => hook.run(structuredClone(input), context),
        });
        if (!outcome.ok || !outcome.value) return null;
        const entries = new Map<number, string>();
        for (const { id, text } of outcome.value.entries ?? []) {
          const clean = mailText(text);
          if (clean && listed.has(id) && !entries.has(id)) entries.set(id, clean);
        }
        const overview = mailText(outcome.value.overview);
        if (!overview && entries.size === 0) return null;
        return { pluginId: plugin.id, name: pluginName(plugin, input.language), overview, entries };
      }),
    );
    return outcomes.filter((addition) => addition !== null);
  }
}

/**
 * What a process needs of the plugins: their settings and storage, their event deliveries, and
 * their digest additions, whose requests share the feeds' per-host limits through `polite`.
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
  digest: DigestHookComposer;
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
  const digest = new DigestHookComposer(registry, runner);
  return { ...services, registry, events, digest, close: () => network.close() };
}
