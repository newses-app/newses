// Checks of the locale files, for tests and `pnpm locales:status`; nothing the apps run imports it.
import { readdirSync, readFileSync } from 'node:fs';
import { baseCompile } from '@intlify/message-compiler';

/** The packages with their own locale files. */
export const LOCALE_PACKAGES = ['web', 'server', 'desktop'] as const;

export const repositoryFile = (path: string) => new URL(`../../${path}`, import.meta.url);

/** A package's locale files by language. */
export function localeFiles(name: string): Map<string, object> {
  const directory = repositoryFile(`${name}/src/locales/`);
  const files = readdirSync(directory).filter((file) => file.endsWith('.json'));
  return new Map(
    files.map((file) => [
      file.replace(/\.json$/, ''),
      JSON.parse(readFileSync(new URL(file, directory), 'utf8')) as object,
    ]),
  );
}

/** Every message by its dotted key. */
export const messageEntries = (node: object, path = ''): [string, string][] =>
  Object.entries(node).flatMap(([key, value]: [string, unknown]): [string, string][] => {
    if (typeof value === 'string') return [[`${path}${key}`, value]];
    return typeof value === 'object' && value !== null
      ? messageEntries(value, `${path}${key}.`)
      : [];
  });

const placeholders = (message: string) =>
  [...new Set([...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? ''))].sort();

/** The forms of a plural message; `{'|'}` is a literal, not a separator. */
export const pluralForms = (message: string) => message.replace(/\{'.'\}/g, '').split('|');

const BIDI_CONTROLS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

function compileErrors(message: string): string[] {
  const errors: string[] = [];
  baseCompile(message, { onError: (error) => errors.push(error.message) });
  return errors;
}

/** Keys of `source` that `messages` doesn't have yet, which fall back to the source language. */
export function missingKeys(source: object, messages: object): string[] {
  const present = new Set(messageEntries(messages).map(([key]) => key));
  return messageEntries(source)
    .map(([key]) => key)
    .filter((key) => !present.has(key));
}

/**
 * What is wrong with a language's messages, each of which would show wrongly or not at all.
 * Missing keys are not wrong. `forms` is how many plural forms the language has, unset for the
 * source language, whose messages define the rest.
 */
export function localeProblems(source: object, messages: object, forms?: number): string[] {
  const originals = new Map(messageEntries(source));
  return messageEntries(messages).flatMap(([key, message]) => {
    const original = originals.get(key);
    if (original === undefined) return [`${key}: not in the source language`];
    const problems = compileErrors(message).map((error) => `${key}: ${error}`);
    const parts = pluralForms(message);
    if (parts.some((part) => !part.trim())) problems.push(`${key}: blank text`);
    if (BIDI_CONTROLS.test(message)) problems.push(`${key}: bidi control character`);
    if (placeholders(message).join() !== placeholders(original).join())
      problems.push(`${key}: placeholders differ from the source language`);
    const plural = pluralForms(original).length > 1;
    if (!plural && parts.length > 1) problems.push(`${key}: plural forms in a plain message`);
    if (plural && forms !== undefined && parts.length !== forms)
      problems.push(`${key}: ${String(parts.length)} plural forms, expected ${String(forms)}`);
    return problems;
  });
}
