/** An import that cannot start or go on; the message says why. */
export class ImportError extends Error {
  override name = 'ImportError';
}
