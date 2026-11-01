// Why the API refused something, for clients to say in the reader's language (no Zod, so browsers
// can import it).

/**
 * Each reason with the names of its params. Reasons are append-only: apps already installed hold
 * their translations, so a reason whose params change becomes a new reason.
 */
export const ERROR_REASONS = {
  // `fetch_` and a `FetchErrorCode`.
  fetch_invalid_url: ['url'],
  fetch_blocked_address: ['url'],
  fetch_http_status: ['url', 'status'],
  fetch_too_large: ['url'],
  fetch_too_many_redirects: ['url'],
  fetch_timeout: ['url'],
  fetch_network: ['url'],
  fetch_host_blocked: [],
  unsupported_scheme: [],
  no_feed_found: ['url'],
  already_subscribed: [],
  feed_host_paused: [],
  invalid_host: ['host'],
  category_name_taken: ['name'],
  label_name_taken: ['name'],
  theme_name_taken: ['name'],
  login_taken: ['login'],
  app_password_limit: ['max'],
  theme_limit: ['max'],
  too_long: ['max'],
  body_too_large: [],
  opml_invalid: [],
  opml_too_deep: ['max'],
  opml_too_many: ['max'],
  category_into_itself: [],
  note_changed: [],
  article_no_address: [],
  not_a_web_page: [],
  no_article_found: [],
  tag_empty: [],
  invalid_pattern: ['pattern', 'detail'],
} as const;

export type ErrorReason = keyof typeof ERROR_REASONS;
export type ErrorParams = Record<string, string | number>;

/** A reason with the params it declares. */
export type ErrorDetail = {
  [R in ErrorReason]: (typeof ERROR_REASONS)[R] extends readonly []
    ? { reason: R; params?: never }
    : { reason: R; params: Record<(typeof ERROR_REASONS)[R][number], string | number> };
}[ErrorReason];
