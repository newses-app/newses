import { describe, expect, it } from 'vitest';
import { androidUpdate, CHECK_INTERVAL_MS, checkDue, parseCheckRecord } from './updates.ts';

const downloads = 'https://reader-dev.example.com/downloads';
const manifest = (versionCode: number, url = `${downloads}/0.2.0-rc.1/app.apk`) => ({
  version: '0.2.0-rc.1',
  android: { url, size: 1, sha256: 'x', versionCode },
});

describe('androidUpdate', () => {
  it('offers a newer versionCode', () => {
    expect(androidUpdate(manifest(200), 100, downloads)).toEqual({
      version: '0.2.0-rc.1',
      versionCode: 200,
      url: `${downloads}/0.2.0-rc.1/app.apk`,
    });
  });

  it('offers nothing for the same or an older version', () => {
    expect(androidUpdate(manifest(100), 100, downloads)).toBeNull();
    expect(androidUpdate(manifest(99), 100, downloads)).toBeNull();
  });

  it('ignores malformed manifests and APKs outside the downloads', () => {
    expect(androidUpdate(null, 1, downloads)).toBeNull();
    expect(androidUpdate({ version: '1.0.0' }, 1, downloads)).toBeNull();
    expect(androidUpdate(manifest(200, 'https://evil.example/app.apk'), 1, downloads)).toBeNull();
    expect(
      androidUpdate(manifest(200, `${downloads}.evil.example/app.apk`), 1, downloads),
    ).toBeNull();
  });
});

describe('checkDue', () => {
  const now = 1_800_000_000_000;

  it('checks at most daily', () => {
    expect(checkDue(null, now)).toBe(true);
    expect(checkDue({ checkedAt: now - 1000, update: null }, now)).toBe(false);
    expect(checkDue({ checkedAt: now - CHECK_INTERVAL_MS, update: null }, now)).toBe(true);
    // A clock set back would otherwise postpone checks.
    expect(checkDue({ checkedAt: now + 1000, update: null }, now)).toBe(true);
  });

  it('reads a stored record, or nothing', () => {
    expect(parseCheckRecord(JSON.stringify({ checkedAt: now, update: null }))).toEqual({
      checkedAt: now,
      update: null,
    });
    expect(parseCheckRecord('not json')).toBeNull();
    expect(parseCheckRecord(null)).toBeNull();
  });
});
