/** How a settings form treats one top-level field. */
export interface SettingsField {
  /** Sealed at rest and never returned. */
  secret: boolean;
  /** An http(s) URL whose host must be approved for the plugin. */
  url: boolean;
}

/** A plugin's settings for one scope, as the core needs them: its fields, and a check. */
export interface SettingsSpec {
  readonly fields: ReadonlyMap<string, SettingsField>;
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
}

/** The installed plugins; `server/src/plugins` implements it. */
export interface PluginCatalog {
  get(id: string): PluginInfo | undefined;
  list(): PluginInfo[];
}

/** A catalog of no plugins, for hosts that load none. */
export const NO_PLUGINS: PluginCatalog = { get: () => undefined, list: () => [] };
