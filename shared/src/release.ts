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

/**
 * Where a build's source is: `repository` (a package.json `repository.url`) at the build's release
 * tag (`1.2.3`, `1.2.3-rc.1`) or commit (as on AWS); the repository itself for other builds, such as
 * `dev` and `0.0.0-dev`.
 */
export function sourceAt(repository: string, version: string): string {
  const url = repository.replace(/^git\+/, '').replace(/\.git$/, '');
  const tag = TAG.exec(version);
  if (tag && (!tag[4] || RC.test(tag[4]))) return `${url}/tree/v${version.replace(/^v/, '')}`;
  if (/^[0-9a-f]{7,40}$/.test(version)) return `${url}/tree/${version}`;
  return url;
}

/** A published file: its download URL, size in bytes, and SHA-256 (hex). */
export interface ReleaseFile {
  url: string;
  size: number;
  sha256: string;
}

/** The server image a release publishes, and the files that install it with Docker Compose. */
export interface ServerRelease {
  /** The multi-arch image: `<repository>:<tag>`, or `<repository>@<digest>`. */
  image: { repository: string; tag: string; digest: string };
  /** The compose file, pinned to the image. */
  compose: ReleaseFile;
  /** The sample `.env`. */
  env: ReleaseFile;
  /** The override for running behind nginx-proxy. */
  nginxProxy: ReleaseFile;
  /** The cosign public key that verifies the image's signature. */
  publicKey: ReleaseFile;
}

/** The platforms a release can ship apps for. */
export const PLATFORMS = ['windows', 'linux', 'android'] as const;
export type Platform = (typeof PLATFORMS)[number];

/**
 * `/downloads/latest.json`: the latest release on a stage, for the download page and the Android
 * update prompt. Each platform only when the release built it (AWS builds all three; Docker the
 * ones it is asked for), and `server` only on stages that publish the server image.
 */
export interface ReleaseManifest {
  version: string;
  prerelease: boolean;
  /** ISO 8601 time of publishing. */
  published: string;
  windows?: { installer: ReleaseFile; zip: ReleaseFile; portable: ReleaseFile };
  linux?: { appImage: ReleaseFile; deb: ReleaseFile };
  android?: ReleaseFile & { versionCode: number };
  server?: ServerRelease;
}

/** `downloads/<version>/` files never change once published; the files at its root do. */
export const DOWNLOADS_CACHE = {
  versioned: 'public, max-age=31536000, immutable',
  latest: 'no-cache',
};

const DOWNLOAD_TYPES: Record<string, string> = {
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.zip': 'application/zip',
  '.AppImage': 'application/vnd.appimage',
  '.deb': 'application/vnd.debian.binary-package',
  '.apk': 'application/vnd.android.package-archive',
  '.blockmap': 'application/octet-stream',
  '.yml': 'text/yaml',
  '.yaml': 'text/yaml',
  '.example': 'text/plain; charset=utf-8',
  '.pub': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.html': 'text/html',
};

/** The checksums of a version's files, for `sha256sum -c`. */
export const CHECKSUMS = 'SHA256SUMS';

/** A published download's content type, by its name; undefined for a name no release uses. */
export function downloadType(name: string): string | undefined {
  if (name.endsWith('.cdx.json')) return 'application/vnd.cyclonedx+json';
  if (name.endsWith('-openapi.json')) return 'application/vnd.oai.openapi+json';
  if (name === CHECKSUMS) return 'text/plain; charset=utf-8';
  return DOWNLOAD_TYPES[name.slice(name.lastIndexOf('.'))];
}

/** Installers download rather than open; the block map, SBOMs, and checksums are read by tools. */
export const downloadsAsAttachment = (name: string) => /\.(exe|zip|AppImage|deb|apk)$/.test(name);
