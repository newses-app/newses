/** How a settings form treats one top-level field. */
export interface SettingsField {
  /** Sealed at rest and never returned. */
  secret: boolean;
  /** An http(s) URL whose host must be approved for the plugin. */
  url: boolean;
  /** Text of several lines. */
  multiline: boolean;
}

/** A plugin's settings for one scope, as the core needs them: its fields, and a check. */
export interface SettingsSpec {
  readonly fields: ReadonlyMap<string, SettingsField>;
  /**
   * The settings as JSON Schema (draft 2020-12, as input), for forms: each top-level property
   * carries its marks as `newses` (`secret`, `url`, `multiline`); secrets have no default.
   */
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  /** The settings the plugin's schema makes of `values`, or what is wrong with them. */
  parse(
    values: Record<string, unknown>,
  ): { ok: true; value: Record<string, unknown> } | { ok: false; issues: string };
}

/** An installed plugin, as the core sees it. */
export interface PluginInfo {
  readonly id: string;
  readonly version: string;
  /** The package it came from. */
  readonly source: string;
  /** With `user`, each user turns the plugin on for themselves. */
  readonly scopes: readonly ('instance' | 'user')[];
  /** The hosts the plugin asks for; admins approve them and may add others. */
  readonly hosts: readonly string[];
  readonly settings: { instance: SettingsSpec | null; user: SettingsSpec | null };
  /** Plain-text messages per language, for Settings → Plugins. */
  readonly messages: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** The event hooks it implements, with their debounce windows. */
  readonly events: ReadonlyMap<EventHookName, { debounceSeconds: number }>;
}

/** Hooks told of changes after they are saved, through the deliveries. */
export const EVENT_HOOKS = ['entries.added', 'published.changed'] as const;
export type EventHookName = (typeof EVENT_HOOKS)[number];

/** Why a delivery's hook gave nothing: it failed (and is retried), or the plugin is off there. */
export type EventRunOutcome = 'ok' | 'failed' | 'disabled';

/** Runs a plugin's event hook for one user; `server/src/plugins` implements it. */
export interface PluginEventRunner {
  run(
    plugin: PluginInfo,
    hook: EventHookName,
    userId: number,
    event: unknown,
  ): Promise<EventRunOutcome>;
}

/** The installed plugins; `server/src/plugins` implements it. */
export interface PluginCatalog {
  get(id: string): PluginInfo | undefined;
  list(): PluginInfo[];
}

/** A catalog of no plugins, for hosts that load none. */
export const NO_PLUGINS: PluginCatalog = { get: () => undefined, list: () => [] };
