export type DomainErrorCode =
  'invalid_credentials' | 'throttled' | 'not_found' | 'conflict' | 'last_admin';

/** Expected failures of a domain operation; the API maps codes to HTTP statuses. */
export class DomainError extends Error {
  override name = 'DomainError';
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export class ThrottledError extends DomainError {
  override name = 'ThrottledError';
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super('throttled', 'Too many failed attempts; try again later');
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
