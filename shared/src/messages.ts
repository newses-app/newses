// Messages in the web app's vue-i18n syntax, for packages that show them without vue-i18n (no Zod,
// so browsers and the desktop's main process can import it).
import { DEFAULT_LOCALE, isolate, type Locale, LOCALES } from './locales.ts';

/**
 * vue-i18n's plural rule for a language: the position of a count's form among those its messages
 * have. `pluralCategories` is unordered and can name forms the messages leave out (Spanish's
 * `many`), so the positions come from the registry, and any other form uses `other`.
 */
export function pluralRule({ code, plurals }: Pick<Locale, 'code' | 'plurals'>) {
  const rules = new Intl.PluralRules(code);
  const other = plurals.indexOf('other');
  return (choice: number, choicesLength: number): number => {
    const position = plurals.indexOf(rules.select(Math.abs(choice)));
    return Math.min(position < 0 ? other : position, choicesLength - 1);
  };
}

const numberFormats = new Map<string, Intl.NumberFormat>();

function numberFormat(locale: string): Intl.NumberFormat {
  let format = numberFormats.get(locale);
  if (!format) numberFormats.set(locale, (format = new Intl.NumberFormat(locale)));
  return format;
}

/**
 * A message parameter as shown: numbers in the language's format, and text isolated from the
 * message around it where directions can mix, which never changes text in a left-to-right UI
 * without right-to-left text.
 */
export function shownParam(value: unknown, locale: string, rightToLeft: boolean): unknown {
  if (typeof value === 'number') return numberFormat(locale).format(value);
  return typeof value === 'string' ? isolate(value, rightToLeft) : value;
}

export type MessageParams = Readonly<Record<string, string | number>>;

// A literal (`{'@'}`), a placeholder (`{name}`), or the separator of plural forms.
const TOKEN = /\{'((?:[^'\\]|\\.)*)'\}|\{\s*(\w+)\s*\}|\|/g;

const unescapeLiteral = (literal: string) =>
  literal.replace(/\\(u[\da-fA-F]{4}|U[\da-fA-F]{6}|.)/g, (_match, escape: string) =>
    escape.length > 1 ? String.fromCodePoint(Number.parseInt(escape.slice(1), 16)) : escape,
  );

/** A message's plural forms, without the spaces around each `|`, as vue-i18n shows them. */
function forms(message: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (const match of message.matchAll(TOKEN)) {
    if (match[0] !== '|') continue;
    parts.push(message.slice(start, match.index));
    start = match.index + 1;
  }
  parts.push(message.slice(start));
  const last = parts.length - 1;
  return parts.map((part, index) => {
    const start = index > 0 ? part.trimStart() : part;
    return index < last ? start.trimEnd() : start;
  });
}

const registered = (code: string): Locale =>
  LOCALES.find((locale) => locale.code === code) ?? {
    code,
    name: code,
    direction: 'ltr',
    plurals: LOCALES.find((locale) => locale.code === DEFAULT_LOCALE)?.plurals ?? ['other'],
  };

/** The form of a message for a count, by the rule of the language it is written in. */
function formFor(message: string, count: unknown, writtenIn: string): string {
  const all = forms(message);
  if (all.length === 1 || typeof count !== 'number') return all[0] ?? '';
  return all[pluralRule(registered(writtenIn))(count, all.length)] ?? '';
}

/**
 * A message as the web app's `t()` shows it in `locale`: `{name}` placeholders filled with
 * `shownParam`, a missing one empty; `{'@'}` literals; and plural forms separated by `|`, of which
 * a numeric `count` (or `n`) picks one and fills both `{count}` and `{n}`. The forms follow the
 * rule in `LOCALES` of the language the message is written in, `writtenIn`, which differs when a
 * message not yet translated falls back to English. Linked messages (`@:key`) are the web app's
 * alone.
 */
export function formatMessage(
  locale: string,
  message: string,
  params: MessageParams = {},
  writtenIn = locale,
): string {
  const rightToLeft = registered(locale).direction === 'rtl';
  const count = params.count ?? params.n;
  const values: MessageParams = typeof count === 'number' ? { count, n: count, ...params } : params;
  return formFor(message, count, writtenIn).replace(
    TOKEN,
    (token, literal?: string, name?: string) => {
      if (literal !== undefined) return unescapeLiteral(literal);
      if (name === undefined) return token;
      const value = values[name];
      return value === undefined ? '' : String(shownParam(value, locale, rightToLeft));
    },
  );
}
