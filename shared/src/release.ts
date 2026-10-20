// App versions and the release manifest (no Zod, so build tools and the apps can import it).

/** The app version from a release tag (`v1.2.3`, `v1.2.3-rc.1`); local builds get `0.0.0-dev`. */
export interface AppVersion {
  name: string;
  /**
   * Android `versionCode`: major·1000000 + minor·10000 + patch·100 + a prerelease slot (`-rc.N` is N,
   * a final release 99, a `-try.*` build 0), so each rc and then the final release sort higher.
   */
  code: number;
}

const TAG = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;
const RC = /^-rc\.([1-9]\d?)$/;
// Android's largest versionCode.
const MAX_CODE = 2_100_000_000;

function prereleaseSlot(prerelease: string | undefined, tag: string): number {
  if (!prerelease) return 99;
  if (prerelease.startsWith('-try.')) return 0;
  const rc = RC.exec(prerelease);
  if (!rc || rc[1] === '99') throw new Error(`Prereleases must be -rc.1 to -rc.98: ${tag}`);
  return Number(rc[1]);
}

export function versionFromTag(tag: string | undefined): AppVersion {
  if (!tag) return { name: '0.0.0-dev', code: 1 };
  const match = TAG.exec(tag);
  if (!match) throw new Error(`Not a release tag: ${tag}`);
  const [major, minor, patch] = match.slice(1, 4).map(Number) as [number, number, number];
  if (minor > 99 || patch > 99) throw new Error(`Minor and patch must be below 100: ${tag}`);
  const code = major * 1_000_000 + minor * 10_000 + patch * 100 + prereleaseSlot(match[4], tag);
  if (code > MAX_CODE) throw new Error(`Major must be below 2100: ${tag}`);
  // Android refuses versionCode 0, and 1 is a local build's.
  if (code < 100) throw new Error(`Release versions start at 0.0.1: ${tag}`);
  return { name: tag.replace(/^v/, ''), code };
}

/** A published file: its download URL, size in bytes, and SHA-256 (hex). */
export interface ReleaseFile {
  url: string;
  size: number;
  sha256: string;
}

/** `/downloads/latest.json`: the latest release on a stage, for the download page and the Android update prompt. */
export interface ReleaseManifest {
  version: string;
  prerelease: boolean;
  /** ISO 8601 time of publishing. */
  published: string;
  windows: { installer: ReleaseFile; zip: ReleaseFile; portable: ReleaseFile };
  linux: { appImage: ReleaseFile; deb: ReleaseFile };
  android: ReleaseFile & { versionCode: number };
}
