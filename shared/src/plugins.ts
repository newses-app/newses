import { z } from 'zod';

/** Hosts an admin may approve for one plugin. */
export const MAX_PLUGIN_HOSTS = 50;

/** With `user`, each user turns the plugin on for themselves, with their own settings. */
export const pluginScopeSchema = z.enum(['instance', 'user']);
export type PluginScope = z.infer<typeof pluginScopeSchema>;

/** A scope's settings (the instance's or a user's), without secret values. */
export const pluginSettingsStateSchema = z.object({
  enabled: z.boolean(),
  /** The plain settings; secrets are listed by name in `secretsSet` only. */
  settings: z.record(z.string(), z.unknown()),
  secretsSet: z.array(z.string()),
  /** Failed runs in a row. */
  failures: z.number().int(),
  /** How the last failed run failed: `error`, `timeout`, or `invalid`. */
  lastFailure: z.string().nullable(),
  lastFailureAt: z.iso.datetime().nullable(),
  /** Set when the server turned the plugin off after failing repeatedly. */
  disabledReason: z.enum(['failures']).nullable(),
});
export type PluginSettingsState = z.infer<typeof pluginSettingsStateSchema>;

/** `GET /plugins` (API 1.15): an installed plugin, as the signed-in user may see it. */
export const pluginSchema = z.object({
  id: z.string(),
  version: z.string(),
  scopes: z.array(pluginScopeSchema),
  /** On for the instance. */
  enabled: z.boolean(),
  /** The hosts the plugin asks to reach. */
  hosts: z.array(z.string()),
  /** The hosts an admin approved: URL settings must be on one of them. */
  approvedHosts: z.array(z.string()),
  /**
   * Plain-text messages per language (`name`, `description`, `settings.<field>`,
   * `settings.<field>.hint`, `settings.<field>.option.<value>`, `settings.<field>.item.<key>`).
   */
  messages: z.record(z.string(), z.record(z.string(), z.string())),
  /**
   * The settings as JSON Schema, for forms; a top-level property's `newses` marks it `secret`,
   * `url`, or `multiline`. Null for a scope without settings.
   */
  settingsSchemas: z.object({
    instance: z.record(z.string(), z.unknown()).nullable(),
    user: z.record(z.string(), z.unknown()).nullable(),
  }),
  /** Admins only: the package, and the instance's settings. */
  admin: pluginSettingsStateSchema.extend({ source: z.string() }).nullable(),
  /** The user's own settings, for a plugin with user scope. */
  user: pluginSettingsStateSchema.nullable(),
});
export type Plugin = z.infer<typeof pluginSchema>;

export const pluginsResponseSchema = z.object({
  /** For admins, every installed plugin; for others, those on for the instance. */
  plugins: z.array(pluginSchema),
  /** Admins only: plugins no longer installed whose settings are kept until removed. */
  uninstalled: z.array(z.string()),
});
export type PluginsResponse = z.infer<typeof pluginsResponseSchema>;

/**
 * A change to a plugin's settings. `settings` replaces the plain settings; a secret given a string
 * is set, given null is cleared, and left out keeps its value. Enabling clears a shutdown after
 * failures.
 */
export const updateAccountPluginRequestSchema = z.object({
  enabled: z.boolean().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateAccountPluginRequest = z.infer<typeof updateAccountPluginRequestSchema>;

/** `PATCH /plugins/:id` (admins): also the hosts the plugin may reach. */
export const updatePluginRequestSchema = updateAccountPluginRequestSchema.extend({
  approvedHosts: z.array(z.string().max(253)).max(MAX_PLUGIN_HOSTS).optional(),
});
export type UpdatePluginRequest = z.infer<typeof updatePluginRequestSchema>;
