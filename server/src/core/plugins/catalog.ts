/** How a settings form treats one top-level field. */
export interface SettingsField {
  /** Sealed at rest and never returned. */
  secret: boolean;
  /** An http(s) URL whose host must be approved for the plugin. */
  url: boolean;
  /** Text of several lines. */
  multiline: boolean;
  /** Some of the user's feeds, by subscription id. */
  feeds: boolean;
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
  /** Whether it has a `test` hook, for "Send test". */
  readonly testable: boolean;
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

/** An entry as hooks see it (the contract's `EventEntry`). */
export interface PluginEntry {
  id: number;
  title: string;
  link: string | null;
  author: string | null;
  publishedAt: string;
  published: boolean;
  unread: boolean;
  feed: { id: number; title: string; url: string | null; withLogin: boolean } | null;
}

/** One user's digest as `digest.compose` gets it (the contract's `DigestComposeInput`). */
export interface DigestComposeInput {
  userId: number;
  language: string;
  frequency: 'daily' | 'weekly';
  entries: DigestPluginEntry[];
  more: number;
  /** Of `more`, at most `DIGEST_MAX_UNLISTED`, newest first. */
  unlisted: DigestPluginEntry[];
}

/** An entry a digest counts, as `digest.compose` gets it (the contract's `DigestEntry`). */
export type DigestPluginEntry = PluginEntry & { excerpt: string | null; contentHash: string };

/**
 * What one plugin adds to a digest, checked: plain text without control characters, trimmed,
 * and per-entry text only for entries the digest lists.
 */
export interface DigestAddition {
  pluginId: string;
  /** The plugin's name in the digest's language. */
  name: string;
  overview: string | null;
  entries: ReadonlyMap<number, string>;
}

/** Runs the installed plugins' `digest.compose`; `server/src/plugins` implements it. */
export interface DigestComposer {
  /** Whether any installed plugin composes digests. */
  readonly composes: boolean;
  /** The additions of the plugins on for the user, in install order; never throws. */
  compose(input: DigestComposeInput): Promise<DigestAddition[]>;
}

/**
 * How a test went: passed or not with the plugin's message, or failed by throwing (`error`, the
 * message what it threw), running out of time, or returning something else; `off` when the
 * plugin is off there, or its saved settings no longer fit it.
 */
export type PluginTestOutcome =
  { ok: boolean; message: string; failure: 'error' | 'timeout' | 'invalid' | null } | 'off';

/** Runs a plugin's `test` hook for a user, or the instance; `server/src/plugins` implements it. */
export interface PluginTester {
  test(plugin: PluginInfo, userId: number | null): Promise<PluginTestOutcome>;
}

/** The installed plugins; `server/src/plugins` implements it. */
export interface PluginCatalog {
  get(id: string): PluginInfo | undefined;
  list(): PluginInfo[];
}

/** A catalog of no plugins, for hosts that load none. */
export const NO_PLUGINS: PluginCatalog = { get: () => undefined, list: () => [] };
