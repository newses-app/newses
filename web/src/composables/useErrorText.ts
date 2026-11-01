import { useI18n } from 'vue-i18n';
import { ApiError } from '../api.ts';
import { failureText } from '../lib/error-text.ts';

/** Returns what to tell the reader about an error caught from an API call. */
export function useErrorText() {
  const i18n = useI18n();
  return (error: unknown) =>
    error instanceof ApiError ? failureText(i18n, error) : i18n.t('errors.generic');
}
