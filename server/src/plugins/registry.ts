import {
  acceptsApiVersion,
  isApiRange,
  PLUGIN_API_VERSION,
  type PluginDefinition,
} from '@newses/plugin-api';
import { z } from 'zod';
import type { Logger } from '../core/ports.ts';

/** A plugin as a deployment installs it: the package it came from and its default export. */
export interface InstalledPlugin {
  /** The package and version, as the operator named it (`@scope/name@1.2.3`). */
  source: string;
  plugin: unknown;
}

export interface LoadedPlugin {
  source: string;
  definition: PluginDefinition;
}

export type RefusalReason = 'invalid' | 'incompatible' | 'duplicate';

export interface RefusedPlugin {
  source: string;
  /** The plugin's id, when it declared a usable one. */
  id: string | null;
  reason: RefusalReason;
  /** What was wrong, for operators. */
  detail: string;
}

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*$`);
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// Hooks this server runs; a plugin naming any other was written for a newer contract.
const hooksSchema = z.strictObject({});

const definitionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'lower-case letters, digits, and hyphens'),
  version: z.string().regex(SEMVER, 'a semver version'),
  apiVersion: z.string().refine(isApiRange, 'a caret range such as ^0.1'),
  scopes: z
    .array(z.enum(['instance', 'user']))
    .min(1)
    .refine((scopes) => new Set(scopes).size === scopes.length, 'scopes repeat'),
  hosts: z.array(z.string().regex(HOSTNAME, 'lower-case host names')).max(20).optional(),
  hooks: hooksSchema,
});

const idOf = (plugin: unknown) => {
  const id = (plugin as { id?: unknown } | null)?.id;
  return typeof id === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(id) ? id : null;
};

/**
 * The installed plugins this server can run. A plugin with an unusable definition, written for
 * another contract version, or reusing an earlier plugin's id is refused, never crashing the
 * server; the refusals are logged and kept for admins.
 */
export class PluginRegistry {
  readonly refused: readonly RefusedPlugin[];
  readonly #plugins: ReadonlyMap<string, LoadedPlugin>;

  private constructor(plugins: Map<string, LoadedPlugin>, refused: RefusedPlugin[]) {
    this.#plugins = plugins;
    this.refused = refused;
  }

  static load(
    installed: readonly InstalledPlugin[],
    options: { logger: Logger; apiVersion?: string },
  ): PluginRegistry {
    const apiVersion = options.apiVersion ?? PLUGIN_API_VERSION;
    const plugins = new Map<string, LoadedPlugin>();
    const refused: RefusedPlugin[] = [];
    const refuse = (entry: RefusedPlugin) => {
      refused.push(entry);
      options.logger.warn(
        { plugin: entry.id, source: entry.source, reason: entry.reason, detail: entry.detail },
        'Plugin refused',
      );
    };
    for (const { source, plugin } of installed) {
      const parsed = definitionSchema.safeParse(plugin);
      if (!parsed.success) {
        refuse({
          source,
          id: idOf(plugin),
          reason: 'invalid',
          detail: z.prettifyError(parsed.error),
        });
        continue;
      }
      const definition = plugin as PluginDefinition;
      const { id } = parsed.data;
      if (!acceptsApiVersion(parsed.data.apiVersion, apiVersion)) {
        refuse({
          source,
          id,
          reason: 'incompatible',
          detail: `needs plugin API ${parsed.data.apiVersion}; this server has ${apiVersion}`,
        });
        continue;
      }
      const earlier = plugins.get(id);
      if (earlier) {
        refuse({ source, id, reason: 'duplicate', detail: `${earlier.source} has the same id` });
        continue;
      }
      plugins.set(id, { source, definition });
      options.logger.info({ plugin: id, source, version: parsed.data.version }, 'Plugin loaded');
    }
    return new PluginRegistry(plugins, refused);
  }

  get(id: string): LoadedPlugin | undefined {
    return this.#plugins.get(id);
  }

  list(): LoadedPlugin[] {
    return [...this.#plugins.values()];
  }
}
