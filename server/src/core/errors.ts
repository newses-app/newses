import type { ErrorDetail } from '@newses/shared';

export type DomainErrorCode =
  | 'invalid_credentials'
  | 'password_expired'
  | 'throttled'
  | 'not_found'
  | 'conflict'
  | 'last_admin'
  | 'invalid_input'
  | 'feed_not_found'
  | 'fetch_failed'
  | 'resync_required';

/** Expected failures of a domain operation; the API maps codes to HTTP statuses. */
export class DomainError extends Error {
  override name = 'DomainError';
  readonly code: DomainErrorCode;
  /** Why, for clients to say in the reader's language; without it they have `code` and `message`. */
  readonly detail: ErrorDetail | undefined;

  constructor(code: DomainErrorCode, message: string, detail?: ErrorDetail) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

export class ThrottledError extends DomainError {
  override name = 'ThrottledError';
  readonly retryAfterSeconds: number;

  constructor(
    retryAfterSeconds: number,
    message = 'Too many failed attempts; try again later',
    detail?: ErrorDetail,
  ) {
    super('throttled', message, detail);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Refuses text longer than `max` characters, wherever it came from; `what` names it. */
export function assertMaxLength(text: string | null | undefined, max: number, what: string) {
  if (text && text.length > max)
    throw new DomainError('invalid_input', `${what} is longer than ${String(max)} characters`, {
      reason: 'too_long',
      params: { max },
    });
}
