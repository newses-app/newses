import { z } from 'zod';

/**
 * The version of this contract. A plugin's `apiVersion` must accept it: while the major is 0,
 * additions raise the patch and breaking changes the minor.
 */
export const PLUGIN_API_VERSION = '0.1.0';

/**
 * Where a plugin is turned on. Admins enable every plugin for the instance; with `user`, each
 * user also turns it on for themselves. Plugins declare at least one.
 */
export type PluginScope = 'instance' | 'user';

/** How the settings form shows a field, set by `secret()` and `url()`. */
export interface FieldMarks {
  /** Sealed at rest and never sent back to the browser. */
  secret?: boolean;
  /** An http(s) URL, saved only when its host is approved for the plugin. */
  url?: boolean;
  /** Text of several lines, such as a template. */
  multiline?: boolean;
}

/** The metadata key `secret()` and `url()` set on a schema. */
export const FIELD_MARKS = 'newses';

/**
 * A secret setting, such as an API key or a token: sealed with the server's secret, never shown
 * again. Only top-level settings may be secret.
 */
export function secret(): z.ZodString {
  return z
    .string()
    .min(1)
    .max(4096)
    .meta({ [FIELD_MARKS]: { secret: true } satisfies FieldMarks });
}

/**
 * An http(s) URL setting, saved only when an admin approved its host for the plugin. With
 * `secret`, it is sealed as `secret()` is, for URLs holding a token. Top-level settings only.
 */
export function url(options: { secret?: boolean } = {}): z.ZodURL {
  const marks: FieldMarks = { url: true, ...(options.secret && { secret: true }) };
  return z
    .url({ protocol: /^https?$/ })
    .max(2048)
    .meta({ [FIELD_MARKS]: marks });
}

/** Text of several lines, such as a body template, edited in a larger box. */
export function multiline(): z.ZodString {
  return z
    .string()
    .max(10_000)
    .meta({ [FIELD_MARKS]: { multiline: true } satisfies FieldMarks });
}

/** A scope's settings: an object schema of `zod`, the copy the server uses. */
export type SettingsSchema = z.ZodObject;

/**
 * Key-value storage for the plugin's own data, kept by the server: per plugin for the instance,
 * or per plugin and user. Values are JSON. See `STORAGE_LIMITS`.
 */
export interface PluginStore {
  /** The value, or undefined when the key is unset or expired. */
  get(key: string): Promise<unknown>;
  /** Stores a value; with `ttlSeconds` it expires then. Rejects past `STORAGE_LIMITS`. */
  set(key: string, value: unknown, options?: { ttlSeconds?: number }): Promise<void>;
  /** Whether the key was there. */
  delete(key: string): Promise<boolean>;
  /** Up to `limit` (default 100, at most 1000) entries whose keys start with `prefix`, by key, after `after`. */
  list(
    prefix?: string,
    options?: { after?: string; limit?: number },
  ): Promise<{ key: string; value: unknown }[]>;
}

/** What a store holds at most: per key, per value (as JSON, in bytes), and in all. */
export const STORAGE_LIMITS = {
  keyLength: 200,
  valueBytes: 64 * 1024,
  keys: 10_000,
  bytes: 16 * 1024 * 1024,
} as const;

/** Log lines go to the server's log, tagged with the plugin's id; they must not hold article text. */
export interface PluginLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * What the server gives a plugin while one of its hooks runs. Plugins get no database access.
 * `Settings` and `UserSettings` are what the plugin's settings schemas give.
 */
export interface PluginContext<
  Settings extends Record<string, unknown> = Record<string, unknown>,
  UserSettings extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly pluginId: string;
  /** Aborted when the hook's time is up; pass it on to long work. */
  readonly signal: AbortSignal;
  readonly logger: PluginLogger;
  /**
   * The standard `fetch`, for the plugin's own requests and for SDKs that take one. It reaches
   * only hosts an admin approved for the plugin, within the server's per-host limits, never while
   * the host asked to wait, and never private addresses unless the operator allows them.
   * Redirects are returned, not followed. A refused request rejects with a `TypeError`.
   */
  readonly fetch: typeof globalThis.fetch;
  /** The instance settings, secrets opened; empty without an instance schema. */
  readonly settings: Readonly<Settings>;
  /** The user's settings when the hook runs for a user and the plugin has a user schema. */
  readonly userSettings: Readonly<UserSettings> | null;
  /** The plugin's storage for the instance, shared by every user's runs. */
  readonly storage: PluginStore;
  /** The plugin's storage for the user the hook runs for, if it runs for one. */
  readonly userStorage: PluginStore | null;
}

/** The hooks a plugin implements. Each hook arrives in the patch release that names it. */
export type PluginHooks = Record<string, never>;

export interface PluginDefinition {
  /** Stable id, 1 to 40 lower-case letters, digits, and hyphens, starting with a letter. */
  id: string;
  /** The plugin's own version (semver). */
  version: string;
  /** The contract versions the plugin works with, as a caret range: `^0.1` or `^0.1.2`. */
  apiVersion: string;
  scopes: readonly PluginScope[];
  /** Hosts the plugin may reach, in lower case, which an admin approves before it can. */
  hosts?: readonly string[];
  /**
   * The settings admins set for the instance, and each user for themselves (with scope `user`).
   * Mark secrets with `secret()` and URLs with `url()`. When a hook that runs for a user keeps
   * failing, the plugin is turned off for that user if it has user settings, else for everyone.
   */
  settings?: { instance?: SettingsSchema; user?: SettingsSchema };
  /**
   * The plugin's text in Settings → Plugins, per language (`en`, `de`, `pt-BR`), as plain text;
   * a message missing in the user's language is shown in English, else as its key. Keys:
   * `name`, `description` (what the plugin sends, and to whom), `settings.<field>` (a label),
   * `settings.<field>.hint`, `settings.<field>.option.<value>` (a choice), and
   * `settings.<field>.item.<property>` (a property of a list's items).
   */
  messages?: PluginMessages;
  hooks: PluginHooks;
}

/** Messages per language, each a map of key to plain text. */
export type PluginMessages = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** Declares a plugin; the module's default export. Checks types only. */
export function definePlugin<const T extends PluginDefinition>(plugin: T): T {
  return plugin;
}

const CARET_RANGE = /^\^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+].*)?$/;

/** Whether `range` is a caret range this contract understands. */
export const isApiRange = (range: string) => CARET_RANGE.test(range);

/**
 * Whether a plugin declaring `range` works with contract `version`: the same major (from 1 on)
 * or the same minor (on 0), at least the version the range names. Anything but a caret range
 * accepts nothing.
 */
export function acceptsApiVersion(range: string, version: string = PLUGIN_API_VERSION): boolean {
  const wanted = CARET_RANGE.exec(range);
  const actual = VERSION.exec(version);
  if (!wanted || !actual) return false;
  const [major, minor, patch] = [wanted[1], wanted[2], wanted[3] ?? '0'].map(Number) as [
    number,
    number,
    number,
  ];
  const [vMajor, vMinor, vPatch] = [actual[1], actual[2], actual[3]].map(Number) as [
    number,
    number,
    number,
  ];
  if (vMajor !== major) return false;
  if (major === 0) return vMinor === minor && vPatch >= patch;
  return vMinor > minor || (vMinor === minor && vPatch >= patch);
}
