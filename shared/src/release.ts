// App versions and the release manifest (no Zod, so build tools and the apps can import it).

/** The app version from a release tag (`v1.2.3`, `v1.2.3-rc.1`); local builds get `0.0.0-dev`. */
export interface AppVersion {
  name: string;
  /** Android `versionCode`: major·10000 + minor·100 + patch, so later releases sort higher. */
  code: number;
}

const TAG = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;

export function versionFromTag(tag: string | undefined): AppVersion {
  if (!tag) return { name: '0.0.0-dev', code: 1 };
  const match = TAG.exec(tag);
  if (!match) throw new Error(`Not a release tag: ${tag}`);
  const [major, minor, patch] = match.slice(1, 4).map(Number) as [number, number, number];
  if (minor > 99 || patch > 99) throw new Error(`Minor and patch must be below 100: ${tag}`);
  const code = major * 10000 + minor * 100 + patch;
  // Android refuses versionCode 0.
  if (code === 0) throw new Error(`Release versions start at 0.0.1: ${tag}`);
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
  windows: ReleaseFile;
  linux: { appImage: ReleaseFile; deb: ReleaseFile };
  android: ReleaseFile & { versionCode: number };
}
