/**
 * The version of this contract. A plugin's `apiVersion` must accept it: while the major is 0,
 * additions raise the patch and breaking changes the minor.
 */
export const PLUGIN_API_VERSION = '0.1.0';

/**
 * Who a plugin's settings belong to: the instance (set by admins) or each user (set by
 * themselves). Plugins declare at least one.
 */
export type PluginScope = 'instance' | 'user';

/** Log lines go to the server's log, tagged with the plugin's id; they must not hold article text. */
export interface PluginLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** What the server gives a plugin while one of its hooks runs. Plugins get no database access. */
export interface PluginContext {
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
  hooks: PluginHooks;
}

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
