const KEY_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._=-]*(\/[A-Za-z0-9_-][A-Za-z0-9._=-]*)*$/;

/** Enforces the BlobStore key format, so no adapter sees paths that escape its root. */
export function assertBlobKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new Error(`Invalid blob key: ${key}`);
}
