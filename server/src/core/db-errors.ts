const UNIQUE_VIOLATION = '23505';

/** True for Postgres unique-constraint violations, raw or wrapped by Drizzle. */
export function isUniqueViolation(err: unknown): boolean {
  const cause = err instanceof Error && 'cause' in err ? err.cause : err;
  return (cause as { code?: string } | undefined)?.code === UNIQUE_VIOLATION;
}
