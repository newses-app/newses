import { isolate } from '@newses/shared/locales';

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

/** A message as plain data, for text that is stored rather than shown. */
export const withoutIsolates = (text: string) => text.replace(/[\u2068\u2069]/g, '');
