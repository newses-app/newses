import type { BuiltinThemeKey, CreateThemeRequest, Theme } from '@newses/shared';
import { BUILTIN_THEMES, MAX_THEME_NAME_LENGTH } from '@newses/shared/client';

const FORMAT = 'newses-theme';
const VERSION = 1;

/** A theme as an exported file. */
export function themeFile(theme: Pick<Theme, 'name' | 'base' | 'tokens'>): string {
  const { name, base, tokens } = theme;
  return `${JSON.stringify({ format: FORMAT, version: VERSION, name, base, tokens }, null, 2)}\n`;
}

/** A file name for an exported theme. */
export function themeFileName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'theme'}.newses-theme.json`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Tokens a theme may override: those of the built-in themes. */
const TOKEN_KEYS: ReadonlySet<string> = new Set(Object.keys(BUILTIN_THEMES.original));

/**
 * The theme in an exported file, shape-checked here (format, version, base, token keys) so one
 * imported offline is likely to be accepted later; the server validates the values. Null when the
 * file is not one.
 */
export function readThemeFile(text: string): CreateThemeRequest | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(data) || data.format !== FORMAT || data.version !== VERSION) return null;
  const { name, base, tokens } = data;
  if (typeof name !== 'string' || typeof base !== 'string' || !isRecord(tokens)) return null;
  if (!Object.hasOwn(BUILTIN_THEMES, base)) return null;
  if (Object.keys(tokens).some((key) => !TOKEN_KEYS.has(key))) return null;
  return { name, base: base as BuiltinThemeKey, tokens };
}

/** `name`, or it numbered, so that it is not one of `taken` (ignoring case) and fits the limit. */
export function uniqueName(name: string, taken: readonly string[]): string {
  const used = new Set(taken.map((existing) => existing.toLowerCase()));
  const trimmed = name.trim().slice(0, MAX_THEME_NAME_LENGTH).trim();
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : ` ${String(n)}`;
    const candidate = `${trimmed.slice(0, MAX_THEME_NAME_LENGTH - suffix.length).trim()}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}
