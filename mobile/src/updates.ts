// The Android update check: the stage's latest.json (ReleaseManifest), fetched at launch at most
// daily, against the installed versionCode.

/** A newer APK on the stage's downloads. */
export interface AndroidUpdate {
  version: string;
  versionCode: number;
  url: string;
}

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * The manifest's APK when it is newer than the installed `versionCode`; null when it is not, or the
 * manifest is malformed or points outside the downloads.
 */
export function androidUpdate(
  manifest: unknown,
  versionCode: number,
  downloadsUrl: string,
): AndroidUpdate | null {
  if (!isRecord(manifest) || !isRecord(manifest.android)) return null;
  const { version } = manifest;
  const { versionCode: code, url } = manifest.android;
  if (typeof version !== 'string' || typeof code !== 'number' || typeof url !== 'string') {
    return null;
  }
  if (!url.startsWith(`${downloadsUrl}/`) || code <= versionCode) return null;
  return { version, versionCode: code, url };
}

/** What the last check found, kept between launches. */
export interface CheckRecord {
  checkedAt: number;
  update: AndroidUpdate | null;
}

export function parseCheckRecord(value: string | null): CheckRecord | null {
  if (!value) return null;
  try {
    const record = JSON.parse(value) as unknown;
    return isRecord(record) && typeof record.checkedAt === 'number'
      ? (record as unknown as CheckRecord)
      : null;
  } catch {
    return null;
  }
}

/** Whether a launch should check, or reuse the last result. */
export const checkDue = (record: CheckRecord | null, now: number) =>
  !record || now - record.checkedAt >= CHECK_INTERVAL_MS || now < record.checkedAt;
