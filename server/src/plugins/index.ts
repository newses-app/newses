import {
  digestAdditionsSchema,
  digestEstimateSchema,
  DIGEST_LIMITS,
  EVENT_LIMITS,
  TEST_LIMITS,
  testResultSchema,
} from '@newses/plugin-api';
import type { Keys } from '../core/crypto.ts';
import type { PoliteFetcher } from '../core/feeds/polite-fetcher.ts';
import { stripControlChars } from '../core/feeds/sanitize.ts';
import { recordRefusedPlugins } from '../core/ops/check.ts';
import type { OpsRecorder } from '../core/ops/recorder.ts';
import type {
  DigestAddition,
  DigestComposeInput,
  DigestComposer,
  DigestPluginEstimate,
  DigestTest,
  EventHookName,
  EventRunOutcome,
  PluginEventRunner,
  PluginInfo,
  PluginTester,
  PluginTestOutcome,
} from '../core/plugins/catalog.ts';
import { PluginEventService } from '../core/plugins/events.ts';
import { createPluginServices, type PluginServices } from '../core/plugins/index.ts';
import type { Logger } from '../core/ports.ts';
import type { Db } from '../db/client.ts';
import { INSTALLED_PLUGINS } from '#installed-plugins';
import { PluginNetwork } from './network.ts';
import { type InstalledPlugin, type LoadedPlugin, PluginRegistry } from './registry.ts';
import { PluginRunner } from './runner.ts';

/** How long an event hook may run. */
export const EVENT_HOOK_TIMEOUT_MS = EVENT_LIMITS.timeoutSeconds * 1000;

/**
 * The installed plugins, checked once per process; a plugin the registry refuses is logged, left
 * out, and recorded for the `plugin.refused` alert. Tells the database which event hooks they
 * implement, so its triggers record events for them.
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
  await recordRefusedPlugins(deps.db, registry.refused);
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
  readonly #estimateTimeoutMs: number;

  constructor(
    registry: PluginRegistry,
    runner: Pick<PluginRunner, 'run'>,
    timeoutMs = DIGEST_LIMITS.timeoutSeconds * 1000,
    estimateTimeoutMs = DIGEST_LIMITS.estimateTimeoutSeconds * 1000,
  ) {
    this.#plugins = registry.list().filter((plugin) => plugin.definition.hooks['digest.compose']);
    this.#runner = runner;
    this.#timeoutMs = timeoutMs;
    this.#estimateTimeoutMs = estimateTimeoutMs;
  }

  get composes(): boolean {
    return this.#plugins.length > 0;
  }

  async compose(input: DigestComposeInput): Promise<DigestAddition[]> {
    const outcomes = await Promise.all(
      this.#plugins.map((plugin) => this.#run(plugin, input, true)),
    );
    return outcomes.flatMap((outcome) => outcome?.addition ?? []);
  }

  async composeTest(input: DigestComposeInput): Promise<DigestTest[]> {
    const outcomes = await Promise.all(
      this.#plugins.map((plugin) => this.#run(plugin, input, false)),
    );
    return outcomes.filter((outcome) => outcome !== null);
  }

  async estimate(
    input: DigestComposeInput,
    pluginId: string,
  ): Promise<DigestPluginEstimate | null> {
    const plugin = this.#plugins.find((candidate) => candidate.id === pluginId);
    const hook = plugin?.definition.hooks['digest.estimate'];
    if (!plugin || !hook) return null;
    const outcome = await this.#runner.run({
      plugin,
      hook: 'digest.estimate',
      userId: input.userId,
      timeoutMs: this.#estimateTimeoutMs,
      output: digestEstimateSchema,
      counted: false,
      call: (context) => hook.run(structuredClone(input), context),
    });
    if (!outcome.ok)
      return outcome.failure === 'disabled' ? null : { estimate: null, failure: outcome.failure };
    return {
      estimate: {
        tokens: outcome.value?.tokens ?? null,
        costUsd: outcome.value?.costUsd ?? null,
        note: mailText(outcome.value?.note),
      },
      failure: null,
    };
  }

  /**
   * One plugin's additions, checked, or why it has none; null when it is off for the user.
   * `counted` is false for a test someone asked for.
   */
  async #run(
    plugin: LoadedPlugin,
    input: DigestComposeInput,
    counted: boolean,
  ): Promise<DigestTest | null> {
    const name = pluginName(plugin, input.language);
    const hook = plugin.definition.hooks['digest.compose'];
    if (!hook) return null;
    const outcome = await this.#runner.run({
      plugin,
      hook: 'digest.compose',
      userId: input.userId,
      timeoutMs: this.#timeoutMs,
      output: digestAdditionsSchema,
      counted,
      call: (context) => hook.run(structuredClone(input), context),
    });
    if (!outcome.ok)
      return outcome.failure === 'disabled'
        ? null
        : { name, addition: null, failure: outcome.failure, detail: outcome.detail ?? null };
    const listed = new Set(input.entries.map((entry) => entry.id));
    const entries = new Map<number, string>();
    for (const { id, text } of outcome.value?.entries ?? []) {
      const clean = mailText(text);
      if (clean && listed.has(id) && !entries.has(id)) entries.set(id, clean);
    }
    const overview = mailText(outcome.value?.overview);
    if (!overview && entries.size === 0)
      return { name, addition: null, failure: 'empty', detail: null };
    return {
      name,
      addition: { pluginId: plugin.id, name, overview, entries },
      failure: null,
      detail: null,
    };
  }
}

/**
 * Runs plugins' `test` hooks for "Send test", under `TEST_LIMITS`, with the saved settings of the
 * user or the instance. Tests are not counted as jobs or toward turning a plugin off.
 */
export class HookTester implements PluginTester {
  readonly #registry: PluginRegistry;
  readonly #runner: Pick<PluginRunner, 'run'>;
  readonly #timeoutMs: number;

  constructor(
    registry: PluginRegistry,
    runner: Pick<PluginRunner, 'run'>,
    timeoutMs = TEST_LIMITS.timeoutSeconds * 1000,
  ) {
    this.#registry = registry;
    this.#runner = runner;
    this.#timeoutMs = timeoutMs;
  }

  async test(plugin: PluginInfo, userId: number | null): Promise<PluginTestOutcome> {
    const loaded = this.#registry.get(plugin.id);
    const hook = loaded?.definition.hooks.test;
    if (!loaded || !hook) return 'off';
    const outcome = await this.#runner.run({
      plugin: loaded,
      hook: 'test',
      userId,
      timeoutMs: this.#timeoutMs,
      output: testResultSchema,
      counted: false,
      call: (context) => hook.run(context),
    });
    if (outcome.ok) {
      const message = stripControlChars(outcome.value.message.replace(/\r\n?/g, '\n')).trim();
      return { ok: outcome.value.ok, message, failure: null };
    }
    if (outcome.failure === 'disabled') return 'off';
    return { ok: false, message: outcome.detail ?? '', failure: outcome.failure };
  }
}

/**
 * What a process needs of the plugins: their settings and storage, their event deliveries,
 * their digest additions, and their tests, whose requests share the feeds' per-host limits through `polite`.
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
  tester: HookTester;
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
  const tester = new HookTester(registry, runner);
  return { ...services, registry, events, digest, tester, close: () => network.close() };
}
