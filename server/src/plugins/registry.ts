import {
  acceptsApiVersion,
  FIELD_MARKS,
  type FieldMarks,
  isApiRange,
  PLUGIN_API_VERSION,
  type PluginDefinition,
  type SettingsSchema,
} from '@newses/plugin-api';
import { z } from 'zod';
import type {
  PluginCatalog,
  PluginInfo,
  SettingsField,
  SettingsSpec,
} from '../core/plugins/catalog.ts';
import { isHostName } from '../core/plugins/settings.ts';
import type { Logger } from '../core/ports.ts';

/** A plugin as a deployment installs it: the package it came from and its default export. */
export interface InstalledPlugin {
  /** The package and version, as the operator named it (`@scope/name@1.2.3`). */
  source: string;
  plugin: unknown;
}

/** An installed plugin the server runs: what the core sees of it, and its definition. */
export interface LoadedPlugin extends PluginInfo {
  readonly definition: PluginDefinition;
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

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// Hooks this server runs; a plugin naming any other was written for a newer contract.
const hooksSchema = z.strictObject({});

const objectSchema = z.custom<SettingsSchema>(
  (value) =>
    kindOf(value) === 'object' && typeof (value as SettingsSchema).safeParse === 'function',
  'a zod object schema',
);

const definitionSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'lower-case letters, digits, and hyphens'),
    version: z.string().regex(SEMVER, 'a semver version'),
    apiVersion: z.string().refine(isApiRange, 'a caret range such as ^0.1'),
    scopes: z
      .array(z.enum(['instance', 'user']))
      .min(1)
      .refine((scopes) => new Set(scopes).size === scopes.length, 'scopes repeat'),
    hosts: z.array(z.string().refine(isHostName, 'lower-case host names')).max(20).optional(),
    settings: z
      .strictObject({ instance: objectSchema.optional(), user: objectSchema.optional() })
      .optional(),
    messages: z
      .record(
        z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, 'language tags such as en or pt-BR'),
        z.record(z.string().min(1).max(200), z.string().max(2000)),
      )
      .refine((all) => Object.keys(all).length <= 100, 'at most 100 languages')
      .refine(
        (all) => Object.values(all).every((messages) => Object.keys(messages).length <= 500),
        'at most 500 messages per language',
      )
      .optional(),
    hooks: hooksSchema,
  })
  .refine((plugin) => !plugin.settings?.user || plugin.scopes.includes('user'), {
    message: 'user settings need the user scope',
    path: ['settings', 'user'],
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
export class PluginRegistry implements PluginCatalog {
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
      let settings: LoadedPlugin['settings'];
      try {
        settings = {
          instance: settingsSpec(parsed.data.settings?.instance),
          user: settingsSpec(parsed.data.settings?.user),
        };
      } catch (err) {
        refuse({ source, id, reason: 'invalid', detail: (err as Error).message });
        continue;
      }
      plugins.set(id, {
        id,
        version: parsed.data.version,
        source,
        scopes: parsed.data.scopes,
        hosts: parsed.data.hosts ?? [],
        settings,
        messages: parsed.data.messages ?? {},
        definition,
      });
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

/** Wrappers whose inner schema a settings field is. */
const WRAPPERS = new Set([
  'optional',
  'nullable',
  'default',
  'prefault',
  'readonly',
  'nonoptional',
  'catch',
  'pipe',
]);

interface SchemaInternals {
  _zod?: { def?: Record<string, unknown> & { type?: string } };
  meta?: () => Record<string, unknown> | undefined;
}

const defOf = (schema: unknown) => (schema as SchemaInternals | null)?._zod?.def;
const kindOf = (schema: unknown) => defOf(schema)?.type;

/** `secret()` and `url()` marks on the schema itself, read with its own copy of zod. */
function marksOf(schema: unknown): FieldMarks {
  if (typeof schema !== 'object' || schema === null) return {};
  const meta = (schema as SchemaInternals).meta?.();
  const marks = meta?.[FIELD_MARKS];
  return typeof marks === 'object' && marks !== null ? marks : {};
}

/** The schemas a schema is built of, for finding marks out of place. */
function childrenOf(schema: unknown): unknown[] {
  const def = defOf(schema);
  if (!def) return [];
  const children: unknown[] = [];
  for (const key of [
    'innerType',
    'in',
    'out',
    'element',
    'rest',
    'keyType',
    'valueType',
    'left',
    'right',
  ])
    if (def[key] !== undefined) children.push(def[key]);
  for (const key of ['options', 'items'])
    if (Array.isArray(def[key])) children.push(...(def[key] as unknown[]));
  if (typeof def.shape === 'object' && def.shape !== null)
    children.push(...Object.values(def.shape as Record<string, unknown>));
  return children;
}

/** Whether `schema` or a schema inside it carries marks. */
function marked(schema: unknown, seen = new Set<unknown>()): boolean {
  if (seen.has(schema)) return false;
  seen.add(schema);
  const marks = marksOf(schema);
  return Boolean(marks.secret || marks.url) || childrenOf(schema).some((c) => marked(c, seen));
}

/**
 * A scope's settings as the core needs them. Marks may sit on a top-level field or the wrappers
 * around it, and only on string fields; anywhere else they would leave a secret unsealed, so the
 * plugin is refused.
 */
function settingsSpec(schema: SettingsSchema | undefined): SettingsSpec | null {
  if (!schema) return null;
  const fields = new Map<string, SettingsField>();
  for (const [name, field] of Object.entries(schema.shape)) {
    let inner: unknown = field;
    let marks: FieldMarks = marksOf(field);
    while (WRAPPERS.has(kindOf(inner) ?? '')) {
      const def = defOf(inner) ?? {};
      inner = def.innerType ?? def.in;
      marks = { ...marksOf(inner), ...marks };
    }
    const secret = marks.secret === true;
    const url = marks.url === true;
    const multiline = marks.multiline === true;
    if ((secret || url) && kindOf(inner) !== 'string')
      throw new Error(`The setting ${name} is marked secret or url but is not a string`);
    if (childrenOf(inner).some((child) => marked(child)))
      throw new Error(`secret() and url() mark top-level settings only, not inside ${name}`);
    fields.set(name, { secret, url, multiline });
  }
  return {
    fields,
    jsonSchema: formSchema(schema, fields),
    parse(values) {
      const parsed = schema.safeParse(values);
      if (parsed.success) return { ok: true, value: parsed.data };
      return {
        ok: false,
        issues: parsed.error.issues
          .map((issue) => `${issue.path.map(String).join('.') || '(settings)'}: ${issue.message}`)
          .join('; '),
      };
    },
  };
}

/**
 * The settings as JSON Schema for forms, each top-level property with its marks as `newses`; a
 * secret's default would show it, so it has none. Throws when zod cannot describe them.
 */
function formSchema(
  schema: SettingsSchema,
  fields: ReadonlyMap<string, SettingsField>,
): Record<string, unknown> {
  let json: Record<string, unknown>;
  try {
    json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  } catch (err) {
    throw new Error(`The settings cannot be described as a form: ${(err as Error).message}`, {
      cause: err,
    });
  }
  const properties = (json.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, { secret, url, multiline }] of fields) {
    const property = properties[name];
    if (!property) continue;
    Reflect.deleteProperty(property, FIELD_MARKS);
    const marks = {
      ...(secret && { secret }),
      ...(url && { url }),
      ...(multiline && { multiline }),
    };
    if (Object.keys(marks).length > 0) property[FIELD_MARKS] = marks;
    if (secret) delete property.default;
  }
  return json;
}
