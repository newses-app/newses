import { z } from 'zod';

/**
 * The version of this contract. A plugin's `apiVersion` must accept it: while the major is 0,
 * additions raise the patch and breaking changes the minor.
 */
export const PLUGIN_API_VERSION = '0.1.1';

/**
 * Where a plugin is turned on. Admins enable every plugin for the instance; with `user`, each
 * user also turns it on for themselves. Plugins declare at least one.
 */
export type PluginScope = 'instance' | 'user';

/** How the settings form shows a field, set by `secret()`, `url()`, `multiline()`, and `feeds()`. */
export interface FieldMarks {
  /** Sealed at rest and never sent back to the browser. */
  secret?: boolean;
  /** An http(s) URL, saved only when its host is approved for the plugin. */
  url?: boolean;
  /** Text of several lines, such as a template. */
  multiline?: boolean;
  /** Some of the user's feeds, by `EventEntry.feed.id`. */
  feeds?: boolean;
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

/**
 * Some of the user's feeds, picked from their subscriptions: ids as `EventEntry.feed.id` gives
 * them, none by default. A feed the user unsubscribed from keeps its id until they save again.
 * Top-level user settings only.
 */
export function feeds(): z.ZodDefault<z.ZodArray<z.ZodInt>> {
  return z
    .array(z.int().positive())
    .max(1000)
    .meta({ [FIELD_MARKS]: { feeds: true } satisfies FieldMarks })
    .default([]);
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

/** An entry as the user sees it when the event is delivered. */
export interface EventEntry {
  /** The user's entry id, stable for the user. */
  id: number;
  title: string;
  link: string | null;
  author: string | null;
  /** ISO 8601; when the article says it was published, else when it was fetched. */
  publishedAt: string;
  /** In the user's published feed. */
  published: boolean;
  unread: boolean;
  /**
   * The feed, as the user named it; null for pages published from outside any feed. `url` is
   * null for a feed with a login, whose address is the user's own.
   */
  feed: { id: number; title: string; url: string | null; withLogin: boolean } | null;
}

/** An entry with its text, for hooks that read articles. */
export interface EventEntryWithText extends EventEntry {
  /** The article as plain text (full text when extracted), at most 20,000 characters. */
  text: string;
  /** Changes when the title, link, or content does. */
  contentHash: string;
}

/** `entries.added`: entries fetched into one user's feeds, or given to a new subscription. */
export interface EntriesAddedEvent {
  userId: number;
  /** Those the user still has, in the order they arrived. */
  entries: EventEntryWithText[];
}

/** `published.changed`: entries added to or removed from one user's published feed. */
export interface PublishedChangedEvent {
  userId: number;
  /** The published feed's public address, once the user has one and the server a `PUBLIC_URL`. */
  feedUrl: string | null;
  /** Entries now in the published feed. */
  published: EventEntry[];
  /** Ids of entries that left it, or no longer exist. */
  unpublished: number[];
}

/** What an event delivery carries at most, and how long its hook may run. */
export const EVENT_LIMITS = { entries: 500, timeoutSeconds: 60 } as const;

/**
 * A hook's failure detail: the message of what it threw (300 characters at most), kept with the
 * failure and shown in Settings → Plugins to whoever owns the settings it ran with. Never put
 * secrets in error messages.
 */
export const FAILURE_DETAIL_LENGTH = 300;

/**
 * A hook told of changes after they are saved, at least once: a delivery that fails (throws,
 * times out) is retried with backoff. Changes within `debounceSeconds` of the first (0 to 3600;
 * 0 by default) arrive as one event.
 */
export interface EventHook<E, C extends PluginContext = PluginContext> {
  debounceSeconds?: number;
  run(event: E, context: C): unknown;
}

/** An entry a digest lists, as the user sees it. */
export interface DigestEntry extends EventEntry {
  /** The start of the article as plain text, as the digest shows it; null when it has none. */
  excerpt: string | null;
  /** Changes when the title, link, or content does. */
  contentHash: string;
}

/** What `digest.compose` is given: one user's digest, about to be sent. */
export interface DigestComposeInput {
  userId: number;
  /** The digest's language (`en`, `pt-BR`), which additions should be written in. */
  language: string;
  frequency: 'daily' | 'weekly';
  /** The entries the digest lists, newest first. */
  entries: DigestEntry[];
  /** Unread entries the digest counts but does not list. */
  more: number;
  /**
   * Those unread entries the digest counts but does not list, newest first: at most
   * `DIGEST_LIMITS.unlisted` of `more`.
   */
  unlisted: DigestEntry[];
}

/**
 * What a plugin adds to a digest, as plain text: never HTML or links, which the digest shows as
 * written. Blank lines separate paragraphs. See `DIGEST_LIMITS`.
 */
export interface DigestAdditions {
  /** Opens the digest, under the plugin's name. */
  overview?: string | null | undefined;
  /** Text under entries the digest lists; other ids are ignored. */
  entries?: readonly { id: number; text: string }[] | null | undefined;
}

/**
 * What a digest takes of a plugin at most (characters of overview and per entry, and time), and
 * how many unlisted entries it gives.
 */
export const DIGEST_LIMITS = {
  overview: 4000,
  entryText: 1000,
  timeoutSeconds: 60,
  unlisted: 2000,
} as const;

/** What a `digest.compose` hook may return; anything else adds nothing. */
export const digestAdditionsSchema: z.ZodType<DigestAdditions | null | undefined> = z
  .object({
    overview: z.string().max(DIGEST_LIMITS.overview).nullish(),
    entries: z
      .array(z.object({ id: z.number().int(), text: z.string().max(DIGEST_LIMITS.entryText) }))
      .max(1000)
      .nullish(),
  })
  .nullish();

/**
 * A hook that adds to a user's digest before it is sent. A hook that throws, runs out of time,
 * or returns more than `DIGEST_LIMITS` adds nothing; the digest goes out without it.
 */
export interface DigestHook<C extends PluginContext = PluginContext> {
  run(
    input: DigestComposeInput,
    context: C,
  ): DigestAdditions | null | undefined | Promise<DigestAdditions | null | undefined>;
}

/** What a `test` hook reports: whether the test passed, and what happened, as plain text. */
export interface TestResult {
  ok: boolean;
  /** Shown to whoever ran the test, such as `HTTP 204 No Content`; never put secrets in it. */
  message: string;
}

/** What a test takes of a plugin at most: characters of message, and time. */
export const TEST_LIMITS = { message: 500, timeoutSeconds: 30 } as const;

/** What a `test` hook may return; anything else fails the test. */
export const testResultSchema: z.ZodType<TestResult> = z.object({
  ok: z.boolean(),
  message: z.string().max(TEST_LIMITS.message),
});

/**
 * "Send test" in Settings → Plugins: runs with the saved settings, for the user who pressed it
 * (a plugin with user settings) or the instance (an admin), while the plugin is on there. A test
 * that throws or runs out of time fails, with the error's message shown; tests never count
 * toward turning a plugin off. For a plugin with `digest.compose` and user settings, a user's
 * test that passes (or Send test of a plugin without this hook) is followed by a test digest,
 * which shows what `digest.compose` adds or why it added nothing.
 */
export interface TestHook<C extends PluginContext = PluginContext> {
  run(context: C): TestResult | Promise<TestResult>;
}

/**
 * The hooks a plugin implements, each given a context typed by the plugin's settings. Each hook
 * arrives in the patch release that names it.
 */
export interface PluginHooks<C extends PluginContext = PluginContext> {
  'entries.added'?: EventHook<EntriesAddedEvent, C>;
  'published.changed'?: EventHook<PublishedChangedEvent, C>;
  'digest.compose'?: DigestHook<C>;
  test?: TestHook<C>;
}

/** The settings a schema gives hooks: its output, or none without one. */
type SettingsOf<S extends SettingsSchema | undefined> = S extends SettingsSchema
  ? z.output<S>
  : Record<string, never>;

/** The context of a plugin whose settings schemas are `Instance` and `User`. */
export type ContextOf<
  Instance extends SettingsSchema | undefined,
  User extends SettingsSchema | undefined,
> = PluginContext<SettingsOf<Instance>, SettingsOf<User>>;

export interface PluginDefinition<
  Instance extends SettingsSchema | undefined = SettingsSchema | undefined,
  User extends SettingsSchema | undefined = SettingsSchema | undefined,
> {
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
  settings?: { instance?: Instance; user?: User };
  /**
   * The plugin's text in Settings → Plugins, per language (`en`, `de`, `pt-BR`), as plain text;
   * a message missing in the user's language is shown in English, else as its key. Keys:
   * `name`, `description` (what the plugin sends, and to whom), `settings.<field>` (a label),
   * `settings.<field>.hint`, `settings.<field>.option.<value>` (a choice), and
   * `settings.<field>.item.<property>` (a property of a list's items).
   */
  messages?: PluginMessages;
  hooks: PluginHooks<ContextOf<Instance, User>>;
}

/** Messages per language, each a map of key to plain text. */
export type PluginMessages = Readonly<Record<string, Readonly<Record<string, string>>>>;

/**
 * Declares a plugin; the module's default export. Checks types only, giving hooks a context whose
 * `settings` and `userSettings` are what the plugin's settings schemas give.
 */
export function definePlugin<
  Instance extends SettingsSchema | undefined = undefined,
  User extends SettingsSchema | undefined = undefined,
>(plugin: PluginDefinition<Instance, User>): PluginDefinition<Instance, User> {
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
