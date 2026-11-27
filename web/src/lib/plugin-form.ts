// Settings forms for plugins, from the JSON Schema the server describes each plugin's settings with.

/** How a setting is edited. A setting the form cannot edit keeps its saved value. */
export type FieldKind =
  | 'text'
  | 'multiline'
  | 'url'
  | 'secret'
  | 'boolean'
  | 'select'
  | 'number'
  | 'list'
  | 'feeds'
  | 'unsupported';

export interface FormField {
  name: string;
  kind: FieldKind;
  /** Must be given; settings with a default never must. */
  required: boolean;
  /** Takes null. */
  nullable: boolean;
  /** A select's choices. */
  options: string[];
  integer: boolean;
  default: unknown;
  /** A list's item properties: text, multi-line text, URLs, booleans, selects, or numbers. */
  item: FormField[];
}

type Schema = Record<string, unknown>;

const isSchema = (value: unknown): value is Schema =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The schema itself, or the one a nullable `anyOf` wraps. */
function unwrapNull(schema: Schema): { schema: Schema; nullable: boolean } {
  const options = Array.isArray(schema.anyOf) ? schema.anyOf.filter(isSchema) : [];
  const notNull = options.filter((option) => option.type !== 'null');
  if (options.length === 2 && notNull.length === 1 && notNull[0])
    return {
      schema: { ...notNull[0], ...('default' in schema && { default: schema.default }) },
      nullable: true,
    };
  return { schema, nullable: false };
}

function field(name: string, raw: Schema, required: boolean, nested: boolean): FormField {
  const { schema, nullable } = unwrapNull(raw);
  const marks = isSchema(schema.newses) ? schema.newses : {};
  const base: FormField = {
    name,
    kind: 'unsupported',
    required,
    nullable,
    options: [],
    integer: schema.type === 'integer',
    default: schema.default,
    item: [],
  };
  if (schema.type === 'boolean') return { ...base, kind: 'boolean' };
  if (schema.type === 'number' || schema.type === 'integer') return { ...base, kind: 'number' };
  if (schema.type === 'string') {
    if (Array.isArray(schema.enum) && schema.enum.every((v) => typeof v === 'string'))
      return { ...base, kind: 'select', options: schema.enum };
    if (marks.secret === true && !nested) return { ...base, kind: 'secret' };
    if (marks.multiline === true) return { ...base, kind: 'multiline' };
    if (marks.url === true || schema.format === 'uri') return { ...base, kind: 'url' };
    return { ...base, kind: 'text' };
  }
  if (!nested && marks.feeds === true && schema.type === 'array') return { ...base, kind: 'feeds' };
  if (!nested && schema.type === 'array' && isSchema(schema.items)) {
    const item = objectFields(schema.items, true);
    if (item && item.length > 0 && item.every((f) => f.kind !== 'unsupported'))
      return { ...base, kind: 'list', item };
  }
  return base;
}

function objectFields(schema: Schema, nested: boolean): FormField[] | null {
  if (schema.type !== 'object' || !isSchema(schema.properties)) return null;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(schema.properties)
    .filter((entry): entry is [string, Schema] => isSchema(entry[1]))
    .map(([name, property]) => field(name, property, required.has(name), nested));
}

/** The fields of a scope's settings, in the plugin's order; none for a scope without settings. */
export const formFields = (schema: Schema | null): FormField[] =>
  (schema && objectFields(schema, false)) ?? [];

/**
 * A plugin's message in `locale`, else in its language without a region, else in English, else
 * `fallback`.
 */
export function pluginText(
  messages: Record<string, Record<string, string>>,
  locale: string,
  key: string,
  fallback: string,
): string {
  const language = locale.split('-')[0] ?? locale;
  for (const tag of [locale, language, 'en']) {
    const text = messages[tag]?.[key];
    if (text !== undefined) return text;
  }
  return fallback;
}

/**
 * A copy of a JSON value to edit. The settings and schema come from the API as JSON, and may be
 * reactive: `structuredClone` refuses Vue's proxies, a JSON copy reads through them.
 */
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** What the form starts with: the saved settings, else defaults; secrets start empty. */
export function initialValues(
  fields: FormField[],
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.kind === 'secret') values[f.name] = '';
    else if (f.kind === 'feeds') values[f.name] = feedIds(settings[f.name] ?? f.default);
    else if (f.kind === 'list')
      values[f.name] = Array.isArray(settings[f.name])
        ? copy(settings[f.name])
        : Array.isArray(f.default)
          ? copy(f.default)
          : [];
    else if (f.name in settings) values[f.name] = settings[f.name];
    else if (f.default !== undefined) values[f.name] = f.default;
    else values[f.name] = f.kind === 'boolean' ? false : '';
  }
  return values;
}

/** A feeds field's value as subscription ids. */
const feedIds = (value: unknown): number[] =>
  Array.isArray(value) ? value.filter((id): id is number => Number.isInteger(id) && id > 0) : [];

/** A blank item of a list, with its properties' defaults. */
export const blankItem = (f: FormField): Record<string, unknown> => initialValues(f.item, {});

/** A text or number field's value as the plugin takes it: empty optional text is left out. */
function plain(f: FormField, value: unknown): unknown {
  const empty = value === '' || value === null || value === undefined;
  if (f.kind === 'number') {
    if (empty) return f.nullable ? null : undefined;
    return Number(value);
  }
  if (f.kind === 'text' || f.kind === 'multiline' || f.kind === 'url' || f.kind === 'select') {
    if (!empty) return value;
    if (f.nullable) return null;
    return f.required ? '' : undefined;
  }
  return value;
}

/**
 * The settings to send: every plain field, unsupported ones as saved; a secret typed in is set,
 * one the reader cleared is sent as null, and an untouched one is left out, keeping its value.
 */
export function settingsChange(
  fields: FormField[],
  values: Record<string, unknown>,
  saved: Record<string, unknown>,
  clearedSecrets: ReadonlySet<string>,
): Record<string, unknown> {
  const change: Record<string, unknown> = {};
  for (const f of fields) {
    const value = values[f.name];
    if (f.kind === 'secret') {
      if (typeof value === 'string' && value !== '') change[f.name] = value;
      else if (clearedSecrets.has(f.name)) change[f.name] = null;
    } else if (f.kind === 'feeds') {
      change[f.name] = feedIds(value);
    } else if (f.kind === 'unsupported') {
      if (f.name in saved) change[f.name] = saved[f.name];
    } else if (f.kind === 'list') {
      const items = Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
      change[f.name] = items.map((item) =>
        Object.fromEntries(
          f.item
            .map((property): [string, unknown] => [
              property.name,
              plain(property, item[property.name]),
            ])
            .filter(([, v]) => v !== undefined),
        ),
      );
    } else {
      const converted = plain(f, value);
      if (converted !== undefined) change[f.name] = converted;
    }
  }
  return change;
}
