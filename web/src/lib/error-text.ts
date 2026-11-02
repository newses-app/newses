import type { Subscription } from '@newses/shared';
import type { ApiFailure } from '@newses/shared/client';

export interface Translator {
  t: (key: string, params: Record<string, string | number>) => string;
  te: (key: string) => boolean;
}

/**
 * What to tell the reader about a refused request, from the most specific text there is: its
 * reason, a code that means the same whatever was refused, or the server's own message, in English.
 * Older servers send no reason, and newer ones may send a reason this app doesn't know.
 */
export function failureText({ t, te }: Translator, failure: ApiFailure): string {
  if (failure.reason) {
    const key = `errors.reason.${failure.reason}`;
    if (te(key)) return t(key, failure.params ?? {});
  }
  const key = `errors.code.${failure.code}`;
  if (te(key)) return t(key, {});
  return failure.message || t('errors.generic', {});
}

/** A feed's last error in the reader's language; `''` when it has none. */
export function feedErrorText(
  i18n: Translator,
  { lastError, lastErrorReason, lastErrorParams }: Subscription,
): string {
  return lastError === null
    ? ''
    : failureText(i18n, {
        code: '',
        message: lastError,
        reason: lastErrorReason,
        params: lastErrorParams,
      });
}
