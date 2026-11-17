// Test kit for plugins: a context like the server's, fixture entries, and helpers that run a hook
// as the server does. Works with any test runner. Import from `@newses/plugin-api/testing`.
import {
  acceptsApiVersion,
  DIGEST_LIMITS,
  type DigestAdditions,
  digestAdditionsSchema,
  type DigestComposeInput,
  type DigestEntry,
  type EntriesAddedEvent,
  EVENT_LIMITS,
  type EventEntry,
  type EventEntryWithText,
  PLUGIN_API_VERSION,
  type PluginContext,
  type PluginDefinition,
  type PluginLogger,
  type PluginStore,
  type PublishedChangedEvent,
  STORAGE_LIMITS,
  TEST_LIMITS,
  type TestResult,
  testResultSchema,
} from './index.ts';

const MAX_TTL_SECONDS = 366 * 24 * 60 * 60;

/** A line a plugin logged. */
export interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  fields: Record<string, unknown>;
}

/**
 * A store in memory, with the server's rules: keys of 1 to 200 characters, JSON values, the
 * limits of `STORAGE_LIMITS`, expiry of 1 s to 366 days, and lists by key. Misuse rejects as the
 * server's does: a `TypeError` for a bad key or value, a `RangeError` past a limit.
 */
export class MemoryStore implements PluginStore {
  readonly #values = new Map<string, { json: string; expiresAt: number | null }>();
  readonly #now: () => number;

  /** `now` is the clock expiry is measured by, in milliseconds. */
  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  #live(key: string) {
    const held = this.#values.get(key);
    if (held?.expiresAt !== undefined && held.expiresAt !== null && held.expiresAt <= this.#now()) {
      this.#values.delete(key);
      return undefined;
    }
    return held;
  }

  get(key: string): Promise<unknown> {
    checkKey(key);
    const held = this.#live(key);
    return Promise.resolve(held && JSON.parse(held.json));
  }

  set(key: string, value: unknown, options: { ttlSeconds?: number } = {}): Promise<void> {
    try {
      checkKey(key);
      const json = JSON.stringify(value) as string | undefined;
      if (json === undefined) throw new TypeError('Stored values must be JSON');
      const size = new TextEncoder().encode(json).length;
      if (size > STORAGE_LIMITS.valueBytes)
        throw new RangeError(
          `Stored values hold at most ${String(STORAGE_LIMITS.valueBytes)} bytes`,
        );
      const { ttlSeconds } = options;
      if (
        ttlSeconds !== undefined &&
        !(Number.isInteger(ttlSeconds) && ttlSeconds > 0 && ttlSeconds <= MAX_TTL_SECONDS)
      )
        throw new TypeError(`ttlSeconds is a whole number from 1 to ${String(MAX_TTL_SECONDS)}`);
      const others = [...this.#values.keys()].filter((k) => k !== key && this.#live(k));
      if (others.length + 1 > STORAGE_LIMITS.keys)
        throw new RangeError(`A store holds at most ${String(STORAGE_LIMITS.keys)} keys`);
      const bytes = others.reduce(
        (sum, k) => sum + new TextEncoder().encode(this.#values.get(k)?.json ?? '').length,
        size,
      );
      if (bytes > STORAGE_LIMITS.bytes)
        throw new RangeError(`A store holds at most ${String(STORAGE_LIMITS.bytes)} bytes`);
      this.#values.set(key, {
        json,
        expiresAt: ttlSeconds === undefined ? null : this.#now() + ttlSeconds * 1000,
      });
      return Promise.resolve();
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  delete(key: string): Promise<boolean> {
    checkKey(key);
    const held = this.#live(key);
    this.#values.delete(key);
    return Promise.resolve(held !== undefined);
  }

  list(
    prefix = '',
    options: { after?: string; limit?: number } = {},
  ): Promise<{ key: string; value: unknown }[]> {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 1000);
    const { after } = options;
    const keys = [...this.#values.keys()]
      .filter((key) => key.startsWith(prefix) && (after === undefined || key > after))
      .filter((key) => this.#live(key))
      .sort()
      .slice(0, Number.isFinite(limit) ? limit : 100);
    return Promise.resolve(
      keys.map((key) => ({
        key,
        value: JSON.parse(this.#values.get(key)?.json ?? 'null') as unknown,
      })),
    );
  }
}

function checkKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length === 0 || key.length > STORAGE_LIMITS.keyLength)
    throw new TypeError(`Keys are strings of 1 to ${String(STORAGE_LIMITS.keyLength)} characters`);
}

export interface TestContextOptions<
  Settings extends Record<string, unknown> = Record<string, unknown>,
  UserSettings extends Record<string, unknown> = Record<string, unknown>,
> {
  pluginId?: string;
  settings?: Settings;
  userSettings?: UserSettings | null;
  /** Hosts an admin approved; `fetch` rejects requests to any other. None by default. */
  hosts?: readonly string[];
  /** Answers the plugin's requests to approved hosts; without it they reject. */
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  storage?: PluginStore;
  /** The user's store; null for a hook run for the instance. A new store by default. */
  userStorage?: PluginStore | null;
}

/** A hook's context in a test, with what the plugin logged. */
export interface TestContext<
  Settings extends Record<string, unknown> = Record<string, unknown>,
  UserSettings extends Record<string, unknown> = Record<string, unknown>,
> extends PluginContext<Settings, UserSettings> {
  readonly logs: LogLine[];
}

/**
 * A context like the one the server gives a hook. Its `fetch` refuses, with a `TypeError`, URLs
 * other than http(s) and hosts not in `hosts`, and returns redirects instead of following them;
 * requests it lets through go to `options.fetch`.
 */
export function createTestContext<
  Settings extends Record<string, unknown> = Record<string, unknown>,
  UserSettings extends Record<string, unknown> = Record<string, unknown>,
>(options: TestContextOptions<Settings, UserSettings> = {}): TestContext<Settings, UserSettings> {
  const logs: LogLine[] = [];
  const line =
    (level: LogLine['level']) =>
    (message: string, fields: Record<string, unknown> = {}) => {
      logs.push({ level, message, fields });
    };
  const logger: PluginLogger = {
    debug: line('debug'),
    info: line('info'),
    warn: line('warn'),
    error: line('error'),
  };
  const signal = options.signal ?? new AbortController().signal;
  const hosts = new Set(options.hosts ?? []);
  const fetch: typeof globalThis.fetch = (input, init) => {
    try {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.protocol !== 'https:' && url.protocol !== 'http:')
        throw new TypeError(`Plugins fetch http(s) URLs only, not ${url.protocol}`);
      if (!hosts.has(url.hostname))
        throw new TypeError(`${url.hostname} is not an approved host of the plugin`);
      if (!options.fetch) throw new TypeError(`The test context has no fetch for ${url.href}`);
      return options.fetch(
        new Request(request, {
          redirect: 'manual',
          signal: AbortSignal.any([request.signal, signal]),
        }),
      );
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  };
  return {
    pluginId: options.pluginId ?? 'test',
    signal,
    logger,
    fetch,
    settings: options.settings ?? ({} as Settings),
    userSettings: options.userSettings ?? null,
    storage: options.storage ?? new MemoryStore(),
    userStorage: options.userStorage === undefined ? new MemoryStore() : options.userStorage,
    logs,
  };
}

let nextId = 1;
const nextEntryId = () => nextId++;

/** An entry as events carry it, unread and unpublished, in a feed; `overrides` replace fields. */
export function fixtureEntry(overrides: Partial<EventEntry> = {}): EventEntry {
  const id = overrides.id ?? nextEntryId();
  return {
    id,
    title: `Article ${String(id)}`,
    link: `https://news.example/articles/${String(id)}`,
    author: null,
    publishedAt: '2026-01-01T08:00:00.000Z',
    published: false,
    unread: true,
    feed: { id: 1, title: 'Example News', url: 'https://news.example/feed', withLogin: false },
    ...overrides,
  };
}

/** An entry with its text, as `entries.added` carries it. */
export function fixtureEntryWithText(
  overrides: Partial<EventEntryWithText> = {},
): EventEntryWithText {
  const entry = fixtureEntry(overrides);
  return {
    text: `The text of ${entry.title}.`,
    contentHash: `hash-${String(entry.id)}`,
    ...entry,
    ...overrides,
  };
}

/** An entry as a digest lists it. */
export function fixtureDigestEntry(overrides: Partial<DigestEntry> = {}): DigestEntry {
  const entry = fixtureEntry(overrides);
  return {
    excerpt: `The start of ${entry.title}.`,
    contentHash: `hash-${String(entry.id)}`,
    ...entry,
    ...overrides,
  };
}

/** Options of `runHook`: the context's, with settings as an admin or user saves them. */
export interface RunHookOptions extends Omit<
  TestContextOptions,
  'settings' | 'userSettings' | 'pluginId' | 'signal'
> {
  /** The instance settings, given to the plugin's schema as the server does. */
  settings?: Record<string, unknown>;
  /** The user's settings, for a plugin with user settings. */
  userSettings?: Record<string, unknown>;
  /** Default: the hook's limit, `EVENT_LIMITS` or `DIGEST_LIMITS`. */
  timeoutMs?: number;
}

/** What a hook run gave, with its context. */
export interface HookResult<T> {
  value: T;
  context: TestContext;
}

type HookInput = {
  'entries.added': EntriesAddedEvent;
  'published.changed': PublishedChangedEvent;
  'digest.compose': DigestComposeInput;
  /** A test takes no input. */
  test: undefined;
};
type HookValue = {
  'entries.added': unknown;
  'published.changed': unknown;
  'digest.compose': DigestAdditions | null;
  test: TestResult;
};

const LIMIT_SECONDS: Record<keyof HookInput, number> = {
  'entries.added': EVENT_LIMITS.timeoutSeconds,
  'published.changed': EVENT_LIMITS.timeoutSeconds,
  'digest.compose': DIGEST_LIMITS.timeoutSeconds,
  test: TEST_LIMITS.timeoutSeconds,
};

/**
 * Runs one of the plugin's hooks as the server would: the plugin must accept this contract's
 * version and implement the hook; settings are parsed with its schemas (defaults applied, a
 * mismatch throws); the hook runs under its time limit, its context's `signal` aborting then; and
 * a digest hook's result must be within `DIGEST_LIMITS`, a test's a `TestResult`. Throws where
 * the server would count a failure; `fetch` reaches the plugin's own `hosts` unless
 * `options.hosts` says otherwise.
 */
export async function runHook<H extends keyof HookInput>(
  plugin: PluginDefinition,
  hook: H,
  input: HookInput[H],
  options: RunHookOptions = {},
): Promise<HookResult<HookValue[H]>> {
  if (!acceptsApiVersion(plugin.apiVersion))
    throw new Error(
      `${plugin.id}'s apiVersion ${plugin.apiVersion} does not accept the plugin API ${PLUGIN_API_VERSION}`,
    );
  const declared = plugin.hooks[hook];
  if (!declared) throw new Error(`${plugin.id} does not implement ${hook}`);
  const seconds = (declared as { debounceSeconds?: unknown }).debounceSeconds;
  if (
    seconds !== undefined &&
    !(typeof seconds === 'number' && Number.isInteger(seconds) && seconds >= 0 && seconds <= 3600)
  )
    throw new Error(`${hook}'s debounceSeconds is a whole number from 0 to 3600`);
  const settings = plugin.settings?.instance?.parse(options.settings ?? {}) ?? {};
  const userSettings = plugin.settings?.user?.parse(options.userSettings ?? {}) ?? null;
  const timeoutMs = options.timeoutMs ?? LIMIT_SECONDS[hook] * 1000;
  const signal = AbortSignal.timeout(timeoutMs);
  const context = createTestContext({
    ...options,
    pluginId: plugin.id,
    hosts: options.hosts ?? plugin.hosts ?? [],
    settings,
    userSettings,
    signal,
  });
  const hookToRun = declared as { run(...args: unknown[]): unknown };
  const value = await new Promise<unknown>((resolve, reject) => {
    const onAbort = () => {
      reject(new Error(`${plugin.id}'s ${hook} ran out of time (${String(timeoutMs)} ms)`));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void Promise.resolve()
      .then(() =>
        hook === 'test' ? hookToRun.run(context) : hookToRun.run(structuredClone(input), context),
      )
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener('abort', onAbort);
      });
  });
  if (hook === 'test') {
    const result = testResultSchema.safeParse(value);
    if (!result.success)
      throw new Error(`${plugin.id}'s test returned what a test does not: ${result.error.message}`);
    return { value: result.data as HookValue[H], context };
  }
  if (hook !== 'digest.compose') return { value: value as HookValue[H], context };
  const parsed = digestAdditionsSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(
      `${plugin.id}'s digest.compose returned what the digest does not take: ${parsed.error.message}`,
    );
  return { value: (parsed.data ?? null) as HookValue[H], context };
}

/** Runs the plugin's `test` hook as "Send test" does: `runHook(plugin, 'test', undefined, options)`. */
export const runTest = (plugin: PluginDefinition, options: RunHookOptions = {}) =>
  runHook(plugin, 'test', undefined, options);
